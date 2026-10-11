const ORIGIN = "https://changjiang.yuketang.cn";
const STATE_KEY = "exportState";

let cancelRequested = false;
let running = false;
let pendingPdfDownload = null;

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const pending = pendingPdfDownload;
  const isPendingPdf = pending &&
    (downloadItem.byExtensionId === chrome.runtime.id || downloadItem.url === pending.url) &&
    downloadItem.url.startsWith("data:application/pdf");

  if (!isPendingPdf) {
    suggest();
    return;
  }

  pending.suggested = true;
  suggest({
    filename: pending.filename,
    conflictAction: "uniquify"
  });
});

const initialState = {
  status: "idle",
  label: "",
  current: "",
  total: 0,
  completed: 0,
  duplicatesSkipped: 0,
  errors: []
};

async function readState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || initialState;
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

async function validateSiteTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith(`${ORIGIN}/`)) {
    throw new Error("请保持一个已登录的长江雨课堂标签页打开。 ");
  }
  return tab;
}

async function pageFetch(tabId, path) {
  await validateSiteTab(tabId);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [path],
    func: async (requestPath) => {
      try {
        const response = await fetch(requestPath, { credentials: "include" });
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return {
          ok: response.ok,
          status: response.status,
          data,
          preview: data ? "" : text.slice(0, 200)
        };
      } catch (error) {
        return { ok: false, status: 0, error: String(error) };
      }
    }
  });

  const result = execution?.result;
  if (!result?.ok) {
    throw new Error(`请求失败 (${result?.status || "网络错误"})：${path}`);
  }
  return result.data;
}

function normalizeCourse(raw) {
  return {
    classroomId: raw.classroom_id ?? raw.id,
    name: raw.name || raw.short_name || `课程 ${raw.classroom_id ?? raw.id}`,
    term: raw.term || ""
  };
}

function getCourseIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ["classroom_id", "classroomId", "classroomID"]) {
      const value = parsed.searchParams.get(key);
      if (value) return String(value);
    }

    const hashQuery = parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?")) : "";
    if (hashQuery) {
      const hashParams = new URLSearchParams(hashQuery);
      for (const key of ["classroom_id", "classroomId", "classroomID"]) {
        const value = hashParams.get(key);
        if (value) return String(value);
      }
    }

    const pathMatch = parsed.pathname.match(
      /\/(?:classrooms?|courses?|studentLog)\/(\d+)(?:\/|$)/i
    );
    if (pathMatch) return pathMatch[1];
  } catch {}
  return "";
}

async function scanCourses(tabId) {
  const tab = await validateSiteTab(tabId);
  const response = await pageFetch(tabId, "/v2/api/web/courses/list?identity=2");
  const list = response?.data?.list;
  if (!Array.isArray(list)) throw new Error("未能读取课程列表，请确认账号已登录。 ");
  const currentId = getCourseIdFromUrl(tab.url || "");
  const courses = list.map(normalizeCourse).filter((course) => course.classroomId);
  for (const course of courses) {
    course.isCurrent = String(course.classroomId) === currentId;
  }
  courses.sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
  return courses;
}

async function collectLessons(tabId, course) {
  const lessons = [];
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    if (cancelRequested) break;
    const path = `/v2/api/web/logs/learn/${encodeURIComponent(course.classroomId)}?actype=-1&page=${page}&offset=20&sort=-1`;
    const response = await pageFetch(tabId, path);
    const activities = response?.data?.activities || [];
    for (const activity of activities) {
      if (activity.type !== 14 || !activity.courseware_id || seen.has(String(activity.courseware_id))) continue;
      seen.add(String(activity.courseware_id));
      lessons.push({
        course,
        lessonId: String(activity.courseware_id),
        activityId: activity.id,
        title: activity.title || `课堂 ${activity.id}`,
        createTime: activity.create_time || 0
      });
    }
    if (!response?.data?.has_more || activities.length === 0) break;
  }
  return lessons;
}

async function scanLessons(tabId, course) {
  cancelRequested = false;
  const lessons = await collectLessons(tabId, {
    classroomId: course?.classroomId,
    name: course?.name
  });
  return lessons.map((lesson) => ({
    lessonId: lesson.lessonId,
    title: lesson.title,
    createTime: lesson.createTime,
    date: formatDate(lesson.createTime)
  }));
}

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
    for (const lesson of await collectLessons(tabId, course)) {
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

function sanitizeSegment(value, fallback = "未命名") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 100);
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

async function downloadPdf(base64, filename) {
  const url = `data:application/pdf;base64,${base64}`;
  const pending = { url, filename, suggested: false };
  pendingPdfDownload = pending;

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    const actualFilename = await waitForDownloadFilename(downloadId, filename);
    return { downloadId, filename: actualFilename, forced: pending.suggested };
  } finally {
    if (pendingPdfDownload === pending) pendingPdfDownload = null;
  }
}

function downloadFilenameMatches(actualFilename, requestedFilename) {
  const actualParts = String(actualFilename || "").replace(/\\/g, "/").split("/");
  const requestedParts = String(requestedFilename || "").replace(/\\/g, "/").split("/");
  const actualName = actualParts.pop() || "";
  const requestedName = requestedParts.pop() || "";
  const actualDirectory = actualParts.slice(-requestedParts.length).join("/");
  const requestedDirectory = requestedParts.join("/");

  if (actualDirectory.toLocaleLowerCase() !== requestedDirectory.toLocaleLowerCase()) return false;
  if (actualName.toLocaleLowerCase() === requestedName.toLocaleLowerCase()) return true;

  const dot = requestedName.lastIndexOf(".");
  const stem = dot > 0 ? requestedName.slice(0, dot) : requestedName;
  const extension = dot > 0 ? requestedName.slice(dot) : "";
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedStem} \\(\\d+\\)${escapedExtension}$`, "i").test(actualName);
}

async function waitForDownloadFilename(downloadId, requestedFilename) {
  let actualFilename = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [download] = await chrome.downloads.search({ id: downloadId });
    actualFilename = download?.filename || actualFilename;
    if (downloadFilenameMatches(actualFilename, requestedFilename)) return actualFilename;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const actualName = actualFilename || "未知";
  throw new Error(
    `浏览器未采用课件文件名。期望“${requestedFilename}”，实际“${actualName}”。` +
    "请检查是否有其他下载管理扩展正在改写文件名。"
  );
}

async function exportJob(tabId, job) {
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
  const printTab = await chrome.tabs.create({ url: `${ORIGIN}/web/print`, active: false });
  if (!printTab.id) throw new Error("无法创建打印页面。 ");

  try {
    await waitForTabComplete(printTab.id);
    await waitForPrintReady(printTab.id);
    const pdf = await printTabToPdf(printTab.id, payload.Width > payload.Height);

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
    const filename = [
      "雨课堂课件",
      sanitizeSegment(job.course.name),
      `${date ? `${date} ` : ""}${sanitizeSegment(job.title)}${sanitizeSegment(suffix, "")}.pdf`
    ].join("/");
    await downloadPdf(pdf, filename);
  } finally {
    await chrome.tabs.remove(printTab.id).catch(() => {});
  }
}

async function runExport(tabId, courses, filters = {}) {
  running = true;
  cancelRequested = false;
  await writeState({
    status: "scanning",
    label: "正在扫描课程",
    current: "",
    total: 0,
    completed: 0,
    duplicatesSkipped: 0,
    errors: [],
    error: ""
  });

  try {
    const { jobs, duplicateCount } = await collectJobs(tabId, courses, filters);
    if (cancelRequested) {
      await writeState({ status: "cancelled", label: "已停止" });
      return;
    }
    await writeState({
      status: "running",
      label: "正在导出",
      total: jobs.length,
      completed: 0,
      duplicatesSkipped: duplicateCount
    });

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
        await exportJob(tabId, job);
      } catch (error) {
        const state = await readState();
        await writeState({ errors: [...(state.errors || []), `${job.title}：${error.message}`] });
      }
      await writeState({ completed: index + 1 });
    }

    const state = await readState();
    await writeState({
      status: cancelRequested ? "cancelled" : "done",
      label: cancelRequested ? "已停止" : "导出完成",
      current: "",
      completed: state.completed
    });
  } catch (error) {
    await writeState({ status: "error", label: "导出失败", error: error.message, current: "" });
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [STATE_KEY]: initialState });
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

  if (message?.type === "SCAN_LESSONS") {
    if (running) {
      sendResponse({ ok: false, error: "已有导出任务正在运行。" });
      return false;
    }
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
      lessonIds: Array.isArray(message.lessonIds) ? message.lessonIds : null
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
