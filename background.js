import { formatDate, sanitizeSegment } from "./src/shared/format.js";
import { getExportDirectoryHandle } from "./src/storage/directory-store.js";
import {
  TERMINAL_STATUSES,
  readTaskState as readState,
  resetTaskState as resetState,
  writeTaskState as writeState
} from "./src/storage/task-state.js";
import {
  collectLessons,
  pageFetch,
  scanArchivedCourses,
  scanCourses,
  scanLessons,
  setCourseArchived,
  validateSiteTab
} from "./src/services/yuketang-api.js";

let cancelRequested = false;
let running = false;

function lessonInRange(lesson, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  const date = formatDate(lesson.createTime);
  if (!date) return true;
  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;
  return true;
}

function dedupePresentations(classroomId, rawIds, seenPresentations) {
  const presentationIds = [...new Set(rawIds.filter(Boolean).map(String))];
  const exportableIds = [];
  let duplicateCount = 0;

  for (const presentationId of presentationIds) {
    const duplicateKey = `${classroomId}:${presentationId}`;
    if (seenPresentations.has(duplicateKey)) {
      duplicateCount += 1;
      continue;
    }
    seenPresentations.add(duplicateKey);
    exportableIds.push(presentationId);
  }

  return { exportableIds, duplicateCount };
}

async function collectJobs(tabId, courses, filters = {}) {
  const { dateFrom = "", dateTo = "", lessonIds = null } = filters;
  const allowedLessons = Array.isArray(lessonIds) ? new Set(lessonIds.map(String)) : null;
  const lessons = [];
  for (let index = 0; index < courses.length; index += 1) {
    if (cancelRequested) break;
    const course = courses[index];
    await writeState({
      status: "scanning",
      label: "正在扫描课堂",
      current: `${index + 1}/${courses.length} ${course.name}`
    });
    for (const lesson of await collectLessons(tabId, course, () => cancelRequested)) {
      if (allowedLessons && !allowedLessons.has(lesson.lessonId)) continue;
      if (!lessonInRange(lesson, dateFrom, dateTo)) continue;
      lessons.push(lesson);
    }
  }

  const jobs = [];
  const seenPresentations = new Set();
  let duplicateCount = 0;
  for (let index = 0; index < lessons.length; index += 1) {
    if (cancelRequested) break;
    const lesson = lessons[index];
    await writeState({
      status: "scanning",
      label: "正在识别课件",
      current: `${index + 1}/${lessons.length} ${lesson.title}`
    });
    try {
      const review = await pageFetch(
        tabId,
        `/api/v3/classroom-report/student/review?lesson_id=${encodeURIComponent(lesson.lessonId)}`
      );
      const timeline = review?.data?.timelineList || [];
      const rawPresentationIds = timeline
        .map((item) => item.presentationId || item.pres)
        .filter(Boolean)
        .map(String);
      const deduped = dedupePresentations(
        lesson.course.classroomId,
        rawPresentationIds,
        seenPresentations
      );
      duplicateCount += deduped.duplicateCount;
      const { exportableIds } = deduped;

      exportableIds.forEach((presentationId, presentationIndex) => jobs.push({
        ...lesson,
        presentationId,
        presentationIndex: presentationIndex + 1,
        presentationCount: exportableIds.length
      }));
    } catch (error) {
      const state = await readState();
      await writeState({ errors: [...(state.errors || []), `${lesson.title}：${error.message}`] });
    }
  }
  return { jobs, duplicateCount };
}

async function setPrintPayload(tabId, payload) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [payload],
    func: (printPayload) => {
      localStorage.setItem("rain_print", JSON.stringify(printPayload));
      return true;
    }
  });
  if (!execution?.result) throw new Error("无法准备打印数据。 ");
}

function waitForTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    };
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch((error) => done(error));
    timer = setTimeout(() => done(new Error("打印页面加载超时。")), timeoutMs);
  });
}

async function waitForPrintReady(tabId) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const images = [...document.images];
        const ready = document.body?.innerText?.includes("打印预览") &&
          images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
        if (ready) return { ready: true, images: images.length };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { ready: false, images: document.images.length };
    }
  });
  if (!execution?.result?.ready) throw new Error("课件图片加载超时。 ");
}

async function printTabToPdf(tabId, landscape) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      displayHeaderFooter: false,
      landscape,
      preferCSSPageSize: true,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0
    });
    if (!result?.data) throw new Error("浏览器没有返回 PDF 数据。 ");
    return result.data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function buildExportTarget(job, presentation) {
  const date = formatDate(job.createTime);
  const title = presentation.title || job.title;
  let suffix = "";
  if (job.presentationCount > 1) {
    const digits = Math.max(2, String(job.presentationCount).length);
    const order = String(job.presentationIndex).padStart(digits, "0");
    const presentationName = title === job.title ? "" : ` ${sanitizeSegment(title)}`;
    suffix = ` - 课件 ${order}${presentationName}`;
  } else if (title !== job.title) {
    suffix = ` - ${title}`;
  }
  return {
    courseName: sanitizeSegment(job.course.name),
    filename: `${date ? `${date} ` : ""}${sanitizeSegment(job.title)}` +
      `${sanitizeSegment(suffix, "")}.pdf`
  };
}

async function getExistingFile(directoryHandle, filename) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(filename);
    return await fileHandle.getFile();
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

function splitFilename(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? { stem: filename.slice(0, dot), extension: filename.slice(dot) }
    : { stem: filename, extension: "" };
}

async function inspectFilenameFamily(directoryHandle, filename, expectedSize) {
  const { stem, extension } = splitFilename(filename);
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedStem}(?: \\((\\d+)\\))?${escapedExtension}$`, "i");
  const usedIndexes = new Set();
  let matchingSize = false;

  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind !== "file") continue;
    const match = name.match(pattern);
    if (!match) continue;
    usedIndexes.add(match[1] ? Number(match[1]) : 0);
    const file = await handle.getFile();
    if (file.size === expectedSize) matchingSize = true;
  }

  if (matchingSize) return { matchingSize: true, filename };
  if (!usedIndexes.has(0)) return { matchingSize: false, filename };
  let index = 1;
  while (usedIndexes.has(index)) index += 1;
  return { matchingSize: false, filename: `${stem} (${index})${extension}` };
}

async function writeFile(directoryHandle, filename, blob) {
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function exportJob(tabId, job, exportDirectory, duplicateMode) {
  const response = await pageFetch(
    tabId,
    `/api/v3/lesson-summary/student/presentation?lesson_id=${encodeURIComponent(job.lessonId)}` +
      `&presentation_id=${encodeURIComponent(job.presentationId)}`
  );
  const presentation = response?.data?.presentation;
  const slides = response?.data?.slides;
  if (!presentation || !Array.isArray(slides) || slides.length === 0) {
    throw new Error("未找到可打印的课件页面。 ");
  }

  const target = buildExportTarget(job, presentation);
  const courseDirectory = await exportDirectory.getDirectoryHandle(target.courseName, { create: true });
  if (duplicateMode === "tolerant" && await getExistingFile(courseDirectory, target.filename)) {
    return { status: "skipped", reason: "existing", filename: target.filename };
  }

  const payload = {
    Slides: slides.map((slide) => ({
      ...slide,
      Index: slide.index,
      Cover: slide.cover,
      Thumbnail: slide.cover
    })),
    Width: presentation.width || 960,
    Height: presentation.height || 540,
    Title: presentation.title || job.title,
    printType: 14
  };

  await setPrintPayload(tabId, payload);
  const siteTab = await validateSiteTab(tabId);
  const siteOrigin = new URL(siteTab.url).origin;
  const printTab = await chrome.tabs.create({ url: `${siteOrigin}/web/print`, active: false });
  if (!printTab.id) throw new Error("无法创建打印页面。 ");

  try {
    await waitForTabComplete(printTab.id);
    await waitForPrintReady(printTab.id);
    const pdfBase64 = await printTabToPdf(printTab.id, payload.Width > payload.Height);
    const pdfBlob = await fetch(`data:application/pdf;base64,${pdfBase64}`).then((result) => result.blob());
    let outputFilename = target.filename;

    if (duplicateMode === "strict") {
      const inspection = await inspectFilenameFamily(courseDirectory, target.filename, pdfBlob.size);
      if (inspection.matchingSize) {
        return { status: "skipped", reason: "same-size", filename: target.filename };
      }
      outputFilename = inspection.filename;
    }

    await writeFile(courseDirectory, outputFilename, pdfBlob);
    return { status: "exported", filename: outputFilename };
  } finally {
    await chrome.tabs.remove(printTab.id).catch(() => {});
  }
}

async function runExport(tabId, courses, filters = {}) {
  running = true;
  cancelRequested = false;
  const duplicateMode = filters.duplicateMode === "strict" ? "strict" : "tolerant";
  await writeState({
    status: "scanning",
    label: "正在扫描课程",
    current: "",
    total: 0,
    completed: 0,
    exported: 0,
    duplicatesSkipped: 0,
    localDuplicatesSkipped: 0,
    tabId,
    startedAt: Date.now(),
    finishedAt: 0,
    errors: [],
    error: ""
  });

  try {
    const exportDirectory = await getExportDirectoryHandle();
    if (!exportDirectory) throw new Error("请先选择并授权课件导出目录。");
    const permission = await exportDirectory.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("课件导出目录权限已失效，请重新授权。");

    const { jobs, duplicateCount } = await collectJobs(tabId, courses, filters);
    if (cancelRequested) {
      await writeState({ status: "cancelled", label: "已停止", finishedAt: Date.now() });
      return;
    }
    await writeState({
      status: "running",
      label: "正在导出",
      total: jobs.length,
      completed: 0,
      exported: 0,
      localDuplicatesSkipped: 0,
      duplicatesSkipped: duplicateCount
    });

    let exported = 0;
    let localDuplicatesSkipped = 0;
    for (let index = 0; index < jobs.length; index += 1) {
      if (cancelRequested) break;
      const job = jobs[index];
      await writeState({
        status: "running",
        label: "正在导出",
        current: `${job.course.name} / ${job.title}` +
          (job.presentationCount > 1 ? `（课件 ${job.presentationIndex}/${job.presentationCount}）` : ""),
        total: jobs.length,
        completed: index
      });
      try {
        const result = await exportJob(tabId, job, exportDirectory, duplicateMode);
        if (result.status === "exported") exported += 1;
        if (result.status === "skipped") localDuplicatesSkipped += 1;
      } catch (error) {
        const state = await readState();
        await writeState({ errors: [...(state.errors || []), `${job.title}：${error.message}`] });
      }
      await writeState({
        completed: index + 1,
        exported,
        localDuplicatesSkipped
      });
    }

    const state = await readState();
    await writeState({
      status: cancelRequested ? "cancelled" : "done",
      label: cancelRequested ? "已停止" : "导出完成",
      current: "",
      completed: state.completed,
      exported: state.exported,
      localDuplicatesSkipped: state.localDuplicatesSkipped,
      finishedAt: Date.now()
    });
  } catch (error) {
    await writeState({
      status: "error",
      label: "导出失败",
      error: error.message,
      current: "",
      finishedAt: Date.now()
    });
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  resetState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  readState().then((state) => {
    if (state.tabId === tabId && TERMINAL_STATUSES.has(state.status)) return resetState();
    return null;
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    readState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }

  if (message?.type === "SCAN_COURSES") {
    scanCourses(message.tabId)
      .then((courses) => sendResponse({ ok: true, courses }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SCAN_ARCHIVED_COURSES") {
    scanArchivedCourses(message.tabId)
      .then((courses) => sendResponse({ ok: true, courses }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_COURSE_ARCHIVED") {
    if (running) {
      sendResponse({ ok: false, error: "课件导出期间不能修改课程归档。" });
      return false;
    }
    const classroomIds = Array.isArray(message.classroomIds)
      ? [...new Set(message.classroomIds.map(String).filter(Boolean))]
      : [];
    if (!classroomIds.length) {
      sendResponse({ ok: false, error: "请至少选择一门课程。" });
      return false;
    }
    (async () => {
      const failures = [];
      let completed = 0;
      for (const classroomId of classroomIds) {
        try {
          await setCourseArchived(message.tabId, classroomId, Boolean(message.archived));
          completed += 1;
        } catch (error) {
          failures.push({ classroomId, error: error.message });
        }
      }
      sendResponse({ ok: failures.length === 0, completed, failures });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SCAN_LESSONS") {
    if (running) {
      sendResponse({ ok: false, error: "已有导出任务正在运行。" });
      return false;
    }
    cancelRequested = false;
    scanLessons(message.tabId, message.course)
      .then((lessons) => sendResponse({ ok: true, lessons }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_EXPORT") {
    if (running) {
      sendResponse({ ok: false, error: "已有导出任务正在运行。" });
      return false;
    }
    if (!Array.isArray(message.courses) || message.courses.length === 0) {
      sendResponse({ ok: false, error: "请至少选择一门课程。" });
      return false;
    }
    runExport(message.tabId, message.courses, {
      dateFrom: message.dateFrom || "",
      dateTo: message.dateTo || "",
      lessonIds: Array.isArray(message.lessonIds) ? message.lessonIds : null,
      duplicateMode: message.duplicateMode === "strict" ? "strict" : "tolerant"
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "CANCEL_EXPORT") {
    cancelRequested = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
