import { getPlatformName, parseYuketangUrl } from "./src/shared/platform.js";
import {
  getExportDirectoryHandle,
  saveExportDirectoryHandle
} from "./src/storage/directory-store.js";
import {
  COURSE_SEASONS,
  archiveKeyword,
  archiveYearOptions,
  defaultArchiveTerm,
  filterCoursesByKeyword
} from "./src/features/course-archive.js";

const $ = (selector) => document.querySelector(selector);

const notice = $("#notice");
const scanButton = $("#scan");
const exportButton = $("#export");
const cancelButton = $("#cancel");
const featureToggleButton = $("#feature-toggle");
const selectAllButton = $("#select-all");
const selectNoneButton = $("#select-none");
const coursePanel = $("#course-panel");
const courseList = $("#course-list");
const lessonPanel = $("#lesson-panel");
const featurePanel = $("#feature-panel");
const archivePanel = $("#archive-panel");
const openCourseArchiveButton = $("#open-course-archive");
const archiveBackButton = $("#archive-back");
const archiveAddTab = $("#archive-add-tab");
const archiveListTab = $("#archive-list-tab");
const archiveAddView = $("#archive-add-view");
const archiveListView = $("#archive-list-view");
const archiveYearSelect = $("#archive-year");
const archiveSeasonSelect = $("#archive-season");
const archiveKeywordInput = $("#archive-keyword");
const archiveMatchButton = $("#archive-match");
const archiveResults = $("#archive-results");
const archiveMatchCount = $("#archive-match-count");
const archiveMatchList = $("#archive-match-list");
const archiveNoMatch = $("#archive-no-match");
const archiveSelectAllButton = $("#archive-select-all");
const archiveSelectNoneButton = $("#archive-select-none");
const archiveSubmitButton = $("#archive-submit");
const archivedCourseList = $("#archived-course-list");
const archiveListEmpty = $("#archive-list-empty");
const archiveRefreshButton = $("#archive-refresh");
const archiveStatus = $("#archive-status");
const archiveConfirmDialog = $("#archive-confirm-dialog");
const archiveConfirmCopy = $("#archive-confirm-copy");
const lessonList = $("#lesson-list");
const lessonListHeading = $("#lesson-list-heading");
const lessonSelectionActions = $("#lesson-selection-actions");
const lessonEmpty = $("#lesson-empty");
const lessonTotal = $("#lesson-total");
const lessonScope = $("#lesson-scope");
const lessonSelectAllButton = $("#lesson-select-all");
const lessonSelectNoneButton = $("#lesson-select-none");
const dateFromInput = $("#date-from");
const dateToInput = $("#date-to");
const dateResetButton = $("#date-reset");
const chooseDirectoryButton = $("#choose-directory");
const directoryName = $("#directory-name");
const duplicateModeInputs = [...document.querySelectorAll('input[name="duplicate-mode"]')];
const backButton = $("#back");
const actionBar = $("#action-bar");
const selectionLabel = $("#selection-label");
const courseSearch = $("#course-search");
const courseTotal = $("#course-total");
const noResults = $("#no-results");
const selectedCount = $("#selected-count");
const loadingPanel = $("#loading-panel");
const connectionStatus = $("#connection-status");
const connectionText = $("#connection-text");
const extensionVersion = $("#extension-version");
const platformName = $("#platform-name");
const compatibilityWarning = $("#compatibility-warning");
const progressPanel = $("#progress-panel");
const progressLabel = $("#progress-label");
const progressCount = $("#progress-count");
const progressBar = $("#progress-bar");
const progressTrack = $(".progress-track");
const currentItem = $("#current-item");
const duplicateSummary = $("#duplicate-summary");
const localDuplicateSummary = $("#local-duplicate-summary");
const errorDetails = $("#error-details");
const errorSummary = $("#error-summary");
const errorMessage = $("#error-message");

let activeTab = null;
let courses = [];
let running = false;
let phase = "courses";
let featureReturnPhase = "courses";
let pendingCourses = [];
let lessons = [];
let lessonCheckedCount = 0;
let exportDirectoryHandle = null;
let archiveMatches = [];
let archivedCourses = [];
let archiveBusy = false;

async function refreshDirectoryStatus() {
  exportDirectoryHandle = exportDirectoryHandle || await getExportDirectoryHandle();
  if (!exportDirectoryHandle) {
    directoryName.textContent = "尚未选择课件文件夹";
    directoryName.dataset.state = "missing";
    chooseDirectoryButton.textContent = "选择目录";
    return "missing";
  }
  const permission = await exportDirectoryHandle.queryPermission({ mode: "readwrite" });
  directoryName.textContent = permission === "granted"
    ? `${exportDirectoryHandle.name}（已授权）`
    : `${exportDirectoryHandle.name}（需要重新授权）`;
  directoryName.dataset.state = permission;
  chooseDirectoryButton.textContent = permission === "granted" ? "更换目录" : "重新授权";
  return permission;
}

async function chooseExportDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前浏览器不支持目录授权，请使用最新版 Chrome 或 Edge。");
  }

  if (exportDirectoryHandle) {
    const permission = await exportDirectoryHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      const nextPermission = await exportDirectoryHandle.requestPermission({ mode: "readwrite" });
      if (nextPermission === "granted") {
        await refreshDirectoryStatus();
        return;
      }
    }
  }

  const handle = await window.showDirectoryPicker({
    id: "yuketang-courseware-export",
    mode: "readwrite",
    startIn: "downloads"
  });
  exportDirectoryHandle = handle;
  await saveExportDirectoryHandle(handle);
  await refreshDirectoryStatus();
}

function selectedDuplicateMode() {
  return duplicateModeInputs.find((input) => input.checked)?.value === "strict"
    ? "strict"
    : "tolerant";
}

function clearProgress() {
  document.body.classList.remove("has-progress");
  progressPanel.classList.add("hidden");
  progressLabel.textContent = "准备中";
  progressCount.textContent = "0 / 0";
  progressBar.style.width = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
  currentItem.textContent = "";
  duplicateSummary.classList.add("hidden");
  localDuplicateSummary.classList.add("hidden");
  errorDetails.classList.add("hidden");
  errorSummary.textContent = "";
  errorMessage.textContent = "";
  running = false;
  exportButton.classList.remove("hidden");
  cancelButton.classList.add("hidden");
}

function setNotice(message, type = "") {
  notice.textContent = message;
  notice.className = `notice ${type}`.trim();
}

function setConnection(state, text) {
  connectionStatus.dataset.state = state;
  connectionText.textContent = text;
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function checkedCourses() {
  return [...courseList.querySelectorAll("input:checked")]
    .map((input) => courses.find((course) => String(course.classroomId) === input.value))
    .filter(Boolean);
}

function refreshSelection() {
  const count = checkedCourses().length;
  selectedCount.textContent = `${count} 门课程`;
  exportButton.disabled = count === 0 || running;
  exportButton.textContent = count ? `导出 ${count} 门课程` : "导出课件";
}

function setPhase(next) {
  const featurePhases = new Set(["features", "archive"]);
  if (featurePhases.has(next) && !featurePhases.has(phase)) featureReturnPhase = phase;
  if (!featurePhases.has(next)) featureReturnPhase = next;
  phase = next;
  coursePanel.classList.toggle("hidden", next !== "courses");
  lessonPanel.classList.toggle("hidden", next !== "lessons");
  featurePanel.classList.toggle("hidden", next !== "features");
  archivePanel.classList.toggle("hidden", next !== "archive");
  notice.classList.toggle("hidden", featurePhases.has(next));
  featureToggleButton.textContent = featurePhases.has(next) ? "返回课件" : "其他功能";
  refreshFooter();
}

function refreshFooter() {
  const featurePhase = phase === "features" || phase === "archive";
  actionBar.classList.toggle("hidden", featurePhase);
  if (featurePhase) return;
  backButton.classList.toggle("hidden", phase !== "lessons" || running);
  if (phase !== "lessons") {
    refreshSelection();
    return;
  }
  const single = pendingCourses.length === 1;
  selectionLabel.textContent = "已选择";
  if (single) {
    selectedCount.textContent = `${lessonCheckedCount} 个课件`;
    exportButton.textContent = `导出 ${lessonCheckedCount} 个课件`;
    exportButton.disabled = lessonCheckedCount === 0 || running;
  } else {
    selectedCount.textContent = `${pendingCourses.length} 门课程`;
    exportButton.textContent = `导出 ${pendingCourses.length} 门课程`;
    exportButton.disabled = running;
  }
}

function filterCourses() {
  const query = courseSearch.value.trim().toLocaleLowerCase("zh-CN");
  let visible = 0;

  courseList.querySelectorAll(".course-item").forEach((item) => {
    const matches = !query || item.dataset.search.includes(query);
    item.classList.toggle("filtered-out", !matches);
    if (matches) visible += 1;
  });

  noResults.classList.toggle("hidden", visible !== 0 || courses.length === 0);
  courseList.classList.toggle("hidden", visible === 0);
  courseTotal.textContent = query ? `${visible}/${courses.length}` : `${courses.length} 门`;
}

function renderCourses(items) {
  courses = items;
  courseList.replaceChildren();
  const currentCourse = courses.find((course) => course.isCurrent);

  for (const course of courses) {
    const label = document.createElement("label");
    label.className = "course-item";
    label.classList.toggle("current-course", Boolean(course.isCurrent));
    label.dataset.search = `${course.name} ${course.term || ""}`.toLocaleLowerCase("zh-CN");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(course.classroomId);
    input.checked = currentCourse ? Boolean(course.isCurrent) : true;
    input.addEventListener("change", refreshSelection);

    const copy = document.createElement("div");
    copy.className = "course-copy";
    const titleLine = document.createElement("div");
    titleLine.className = "course-title-line";
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    name.title = course.name;
    titleLine.append(name);
    if (course.isCurrent) {
      const badge = document.createElement("span");
      badge.className = "current-badge";
      badge.textContent = "当前页面";
      titleLine.append(badge);
    }
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = course.term || `课堂 ID：${course.classroomId}`;
    copy.append(titleLine, meta);
    label.append(input, copy);
    courseList.append(label);
  }

  loadingPanel.classList.add("hidden");
  coursePanel.classList.toggle("hidden", phase !== "courses");
  selectAllButton.disabled = false;
  selectNoneButton.disabled = false;
  courseSearch.value = currentCourse ? currentCourse.name : "";
  filterCourses();
  refreshFooter();
}

function setArchiveStatus(message = "", type = "") {
  archiveStatus.textContent = message;
  archiveStatus.className = `archive-status${message ? "" : " hidden"}${type ? ` ${type}` : ""}`;
}

function populateArchiveYears() {
  archiveYearSelect.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "未选择";
  archiveYearSelect.append(blank);
  for (const year of archiveYearOptions()) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = `${year}年`;
    archiveYearSelect.append(option);
  }

  if (!archiveSeasonSelect.querySelector('option[value=""]')) {
    const seasonBlank = document.createElement("option");
    seasonBlank.value = "";
    seasonBlank.textContent = "未选择";
    archiveSeasonSelect.prepend(seasonBlank);
  }
}

function resetArchiveFilter() {
  populateArchiveYears();
  const term = defaultArchiveTerm(courses);
  archiveYearSelect.value = String(term.year);
  archiveSeasonSelect.value = term.season;
  archiveKeywordInput.value = archiveKeyword(term.year, term.season);
  archiveMatches = [];
  archiveResults.classList.add("hidden");
  archiveMatchList.replaceChildren();
  setArchiveStatus();
}

function syncArchiveKeywordFromTerm() {
  archiveKeywordInput.value = archiveKeyword(
    archiveYearSelect.value,
    archiveSeasonSelect.value
  );
  archiveResults.classList.add("hidden");
  setArchiveStatus();
}

function checkedArchiveMatches() {
  return [...archiveMatchList.querySelectorAll("input:checked")]
    .map((input) => archiveMatches.find(
      (course) => String(course.classroomId) === input.value
    ))
    .filter(Boolean);
}

function refreshArchiveMatchSelection() {
  const count = checkedArchiveMatches().length;
  archiveSubmitButton.disabled = count === 0 || archiveBusy;
  archiveSubmitButton.textContent = count ? `归档 ${count} 门课程` : "归档";
}

function renderArchiveMatches(items) {
  archiveMatches = items;
  archiveMatchList.replaceChildren();
  archiveResults.classList.remove("hidden");
  archiveMatchCount.textContent = `${items.length} 门`;
  archiveNoMatch.classList.toggle("hidden", items.length !== 0);
  archiveMatchList.classList.toggle("hidden", items.length === 0);
  archiveSelectAllButton.disabled = items.length === 0;
  archiveSelectNoneButton.disabled = items.length === 0;

  for (const course of items) {
    const label = document.createElement("label");
    label.className = "course-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(course.classroomId);
    input.checked = true;
    input.addEventListener("change", refreshArchiveMatchSelection);

    const copy = document.createElement("div");
    copy.className = "course-copy";
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    name.title = course.name;
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = course.teacherName || course.term || `课堂 ID：${course.classroomId}`;
    copy.append(name, meta);
    label.append(input, copy);
    archiveMatchList.append(label);
  }
  refreshArchiveMatchSelection();
}

function renderArchivedCourses(items) {
  archivedCourses = items;
  archivedCourseList.replaceChildren();
  archiveListEmpty.classList.toggle("hidden", items.length !== 0);
  archivedCourseList.classList.toggle("hidden", items.length === 0);

  for (const course of items) {
    const row = document.createElement("div");
    row.className = "course-item archived-course-item";
    const copy = document.createElement("div");
    copy.className = "course-copy";
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    name.title = course.name;
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = course.teacherName || course.term || `课堂 ID：${course.classroomId}`;
    copy.append(name, meta);

    const restore = document.createElement("button");
    restore.className = "restore-button";
    restore.type = "button";
    restore.textContent = "恢复";
    restore.addEventListener("click", () => restoreArchivedCourse(course, restore));
    row.append(copy, restore);
    archivedCourseList.append(row);
  }
}

async function refreshCurrentCoursesSilently() {
  const result = await send({ type: "SCAN_COURSES", tabId: activeTab.id });
  if (!result?.ok) throw new Error(result?.error || "刷新课程列表失败。");
  renderCourses(result.courses);
}

async function loadArchivedCourses() {
  archiveRefreshButton.disabled = true;
  setArchiveStatus("正在读取“我的归档”…");
  try {
    const result = await send({ type: "SCAN_ARCHIVED_COURSES", tabId: activeTab.id });
    if (!result?.ok) throw new Error(result?.error || "读取归档课程失败。");
    renderArchivedCourses(result.courses);
    setArchiveStatus(
      result.courses.length ? `已读取 ${result.courses.length} 门归档课程。` : "“我的归档”中暂无课程。",
      result.courses.length ? "ok" : ""
    );
  } catch (error) {
    renderArchivedCourses([]);
    setArchiveStatus(error.message, "error");
  } finally {
    archiveRefreshButton.disabled = false;
  }
}

async function restoreArchivedCourse(course, button) {
  if (archiveBusy) return;
  archiveBusy = true;
  button.disabled = true;
  button.textContent = "恢复中";
  setArchiveStatus(`正在恢复“${course.name}”…`);
  try {
    const result = await send({
      type: "SET_COURSE_ARCHIVED",
      tabId: activeTab.id,
      classroomIds: [course.classroomId],
      archived: false
    });
    if (!result?.ok) throw new Error(result?.error || result?.failures?.[0]?.error || "恢复课程失败。");
    renderArchivedCourses(archivedCourses.filter(
      (item) => String(item.classroomId) !== String(course.classroomId)
    ));
    await refreshCurrentCoursesSilently();
    setArchiveStatus(`已将“${course.name}”恢复到首页。`, "ok");
  } catch (error) {
    button.disabled = false;
    button.textContent = "恢复";
    setArchiveStatus(error.message, "error");
  } finally {
    archiveBusy = false;
  }
}

function showArchiveTab(tab) {
  const showList = tab === "list";
  archiveAddTab.classList.toggle("active", !showList);
  archiveListTab.classList.toggle("active", showList);
  archiveAddTab.setAttribute("aria-selected", String(!showList));
  archiveListTab.setAttribute("aria-selected", String(showList));
  archiveAddView.classList.toggle("hidden", showList);
  archiveListView.classList.toggle("hidden", !showList);
  setArchiveStatus();
  if (showList) loadArchivedCourses();
}

function openCourseArchive() {
  resetArchiveFilter();
  showArchiveTab("add");
  setPhase("archive");
}

async function archiveSelectedCourses() {
  const selected = checkedArchiveMatches();
  if (!selected.length || archiveBusy) return;
  archiveBusy = true;
  archiveSubmitButton.disabled = true;
  archiveSubmitButton.textContent = "归档中…";
  archiveMatchList.querySelectorAll("input").forEach((input) => { input.disabled = true; });
  setArchiveStatus(`正在归档 ${selected.length} 门课程…`);

  try {
    const result = await send({
      type: "SET_COURSE_ARCHIVED",
      tabId: activeTab.id,
      classroomIds: selected.map((course) => course.classroomId),
      archived: true
    });
    const completed = Number(result?.completed || 0);
    if (!completed && !result?.ok) {
      throw new Error(result?.error || result?.failures?.[0]?.error || "课程归档失败。");
    }
    await refreshCurrentCoursesSilently();
    renderArchiveMatches(filterCoursesByKeyword(courses, archiveKeywordInput.value));
    const failed = result?.failures?.length || 0;
    setArchiveStatus(
      failed
        ? `已归档 ${completed} 门课程，另有 ${failed} 门失败。`
        : `已归档 ${completed} 门课程，可在“我的归档”中恢复。`,
      failed ? "error" : "ok"
    );
  } catch (error) {
    setArchiveStatus(error.message, "error");
  } finally {
    archiveBusy = false;
    archiveMatchList.querySelectorAll("input").forEach((input) => { input.disabled = false; });
    refreshArchiveMatchSelection();
  }
}

function lessonMatchesRange(date) {
  const from = dateFromInput.value;
  const to = dateToInput.value;
  if (!date) return true;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function visibleLessonItems() {
  return [...lessonList.querySelectorAll(".lesson-item")]
    .filter((item) => !item.classList.contains("filtered-out"));
}

function applyLessonRange(resetSelection) {
  let visible = 0;
  let checked = 0;
  for (const item of lessonList.querySelectorAll(".lesson-item")) {
    const match = lessonMatchesRange(item.dataset.date);
    item.classList.toggle("filtered-out", !match);
    if (!match) continue;
    visible += 1;
    const input = item.querySelector("input");
    if (resetSelection) input.checked = true;
    if (input.checked) checked += 1;
  }
  lessonCheckedCount = checked;
  lessonTotal.textContent = `${visible}/${lessons.length} 个 · 已选 ${checked}`;
  lessonList.classList.toggle("hidden", visible === 0);
  lessonEmpty.classList.toggle("hidden", visible !== 0 || lessons.length === 0);
  refreshFooter();
}

function renderLessons() {
  const single = pendingCourses.length === 1;
  lessonList.replaceChildren();
  lessonListHeading.classList.toggle("hidden", !single);
  lessonSelectionActions.classList.toggle("hidden", !single);
  lessonScope.textContent = single
    ? `${pendingCourses[0].name} 共 ${lessons.length} 个课堂课件，默认全选。`
    : `已选择 ${pendingCourses.length} 门课程：${pendingCourses
        .map((course) => course.name)
        .join("、")}。将导出日期范围内的全部课件。`;

  if (single) {
    for (const lesson of lessons) {
      const label = document.createElement("label");
      label.className = "course-item lesson-item";
      label.dataset.lessonId = lesson.lessonId;
      label.dataset.date = lesson.date || "";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = true;
      input.addEventListener("change", () => applyLessonRange(false));

      const copy = document.createElement("div");
      copy.className = "course-copy";
      const titleLine = document.createElement("div");
      titleLine.className = "course-title-line";
      const name = document.createElement("div");
      name.className = "course-name";
      name.textContent = lesson.title;
      name.title = lesson.title;
      titleLine.append(name);
      const meta = document.createElement("div");
      meta.className = "course-meta";
      meta.textContent = lesson.date || "无日期";
      copy.append(titleLine, meta);
      label.append(input, copy);
      lessonList.append(label);
    }
  } else {
    lessonList.classList.add("hidden");
    lessonEmpty.classList.add("hidden");
    lessonTotal.textContent = "";
    lessonCheckedCount = 0;
  }
  applyLessonRange(true);
}

async function openConfigure() {
  const selected = checkedCourses();
  if (!selected.length) return;
  pendingCourses = selected;
  lessons = [];
  dateFromInput.value = "";
  dateToInput.value = "";
  setPhase("lessons");

  if (selected.length === 1) {
    loadingPanel.classList.remove("hidden");
    setNotice("正在读取课件列表…");
    const result = await send({ type: "SCAN_LESSONS", tabId: activeTab.id, course: selected[0] });
    loadingPanel.classList.add("hidden");
    if (!result?.ok) {
      renderLessons();
      setNotice(result?.error || "读取课件列表失败。", "error");
      return;
    }
    lessons = result.lessons;
    renderLessons();
    setNotice(
      lessons.length
        ? `已读取 ${lessons.length} 个课件，默认全选，可取消勾选或使用日期范围筛选。`
        : `“${selected[0].name}”没有读取到课堂课件。`,
      lessons.length ? "ok" : "error"
    );
    return;
  }

  renderLessons();
  setNotice(`已选择 ${selected.length} 门课程，请指定日期范围。`, "ok");
}

async function startExport() {
  const lessonIds = pendingCourses.length === 1
    ? visibleLessonItems()
      .filter((item) => item.querySelector("input").checked)
      .map((item) => item.dataset.lessonId)
    : null;
  if (pendingCourses.length === 1 && !lessonIds.length) {
    setNotice("请至少选择一个课件。", "error");
    return;
  }
  const directoryPermission = await refreshDirectoryStatus();
  if (directoryPermission !== "granted") {
    setNotice("请先选择并授权现有的“雨课堂课件”文件夹。", "error");
    return;
  }
  const duplicateMode = selectedDuplicateMode();
  const filters = {
    dateFrom: dateFromInput.value,
    dateTo: dateToInput.value,
    lessonIds,
    duplicateMode
  };
  setPhase("courses");
  const result = await send({
    type: "START_EXPORT",
    tabId: activeTab.id,
    courses: pendingCourses,
    ...filters
  });
  if (!result?.ok) setNotice(result?.error || "无法启动导出。", "error");
}

function renderProgress(state) {
  if (!state || state.status === "idle") {
    clearProgress();
    return;
  }

  document.body.classList.add("has-progress");
  progressPanel.classList.remove("hidden");
  const total = Number(state.total || 0);
  const completed = Number(state.completed || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  progressBar.style.width = `${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
  progressCount.textContent = `${completed} / ${total}`;
  progressLabel.textContent = state.label || "处理中";
  currentItem.textContent = state.current || "";
  currentItem.title = state.current || "";

  const errors = state.errors || [];
  errorDetails.classList.toggle("hidden", errors.length === 0);
  errorSummary.textContent = `${errors.length} 项未能导出`;
  errorMessage.textContent = errors.at(-1) || "";
  const duplicatesSkipped = Number(state.duplicatesSkipped || 0);
  duplicateSummary.classList.toggle("hidden", duplicatesSkipped === 0);
  duplicateSummary.textContent = `已按课件 ID 跳过 ${duplicatesSkipped} 个重复引用`;
  const localDuplicatesSkipped = Number(state.localDuplicatesSkipped || 0);
  localDuplicateSummary.classList.toggle("hidden", localDuplicatesSkipped === 0);
  localDuplicateSummary.textContent = `已跳过 ${localDuplicatesSkipped} 个本地重复文件`;

  running = state.status === "running" || state.status === "scanning";
  exportButton.classList.toggle("hidden", running);
  cancelButton.classList.toggle("hidden", !running);
  scanButton.disabled = running;
  featureToggleButton.disabled = running;
  courseSearch.disabled = running;
  courseList.querySelectorAll("input").forEach((input) => { input.disabled = running; });
  refreshFooter();

  if (state.status === "done") {
    if (!total) {
      setNotice("没有找到符合日期范围的课件。", "");
    } else {
      const duplicateCopy = duplicatesSkipped ? `，跳过 ${duplicatesSkipped} 个重复引用` : "";
      const localDuplicateCopy = localDuplicatesSkipped
        ? `，跳过 ${localDuplicatesSkipped} 个本地重复文件`
        : "";
      setNotice(
        `导出完成，共生成 ${Number(state.exported || 0)} 个文件${duplicateCopy}${localDuplicateCopy}。`,
        errors.length ? "" : "ok"
      );
    }
  } else if (state.status === "cancelled") {
    setNotice("导出任务已停止。", "");
  } else if (state.status === "error") {
    setNotice(state.error || "导出失败。", "error");
  } else {
    setNotice("导出任务正在后台运行，请保持雨课堂登录状态。", "");
  }
}

async function scanCourses() {
  if (!activeTab?.id) return;
  scanButton.disabled = true;
  featureToggleButton.disabled = true;
  loadingPanel.classList.remove("hidden");
  setNotice("正在读取当前账号可访问的课程…");

  try {
    const result = await send({ type: "SCAN_COURSES", tabId: activeTab.id });
    if (!result?.ok) throw new Error(result?.error || "读取课程失败");
    renderCourses(result.courses);
    const currentCourse = result.courses.find((course) => course.isCurrent);
    setNotice(
      currentCourse
        ? `已默认筛选当前课程“${currentCourse.name}”，清空搜索框可查看全部课程。`
        : "课程已就绪，可选择后开始导出。",
      "ok"
    );
  } catch (error) {
    loadingPanel.classList.add("hidden");
    setNotice(error.message, "error");
  } finally {
    scanButton.disabled = running;
    featureToggleButton.disabled = running;
  }
}

async function init() {
  extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { hostname: activeHostname, supported: connected } = parseYuketangUrl(activeTab?.url);

  platformName.textContent = getPlatformName(activeHostname);
  compatibilityWarning.classList.toggle(
    "hidden",
    !connected || activeHostname === "changjiang.yuketang.cn"
  );

  if (!connected) {
    setConnection("error", "未连接");
    setNotice("请先在当前标签页打开并登录雨课堂。", "error");
    loadingPanel.classList.add("hidden");
    scanButton.disabled = true;
    featureToggleButton.disabled = true;
    exportButton.disabled = true;
    return;
  }

  setConnection("connected", "已连接");
  const settings = await chrome.storage.local.get("duplicateMode");
  const savedMode = settings.duplicateMode === "strict" ? "strict" : "tolerant";
  duplicateModeInputs.forEach((input) => { input.checked = input.value === savedMode; });
  await refreshDirectoryStatus();
  const result = await send({ type: "GET_STATE" }).catch(() => null);
  if (result?.state) renderProgress(result.state);
  await scanCourses();
}

scanButton.addEventListener("click", scanCourses);
courseSearch.addEventListener("input", filterCourses);

featureToggleButton.addEventListener("click", () => {
  setPhase(phase === "features" || phase === "archive" ? featureReturnPhase : "features");
});

openCourseArchiveButton.addEventListener("click", openCourseArchive);
archiveBackButton.addEventListener("click", () => setPhase("features"));
archiveAddTab.addEventListener("click", () => showArchiveTab("add"));
archiveListTab.addEventListener("click", () => showArchiveTab("list"));
archiveRefreshButton.addEventListener("click", loadArchivedCourses);

archiveYearSelect.addEventListener("change", syncArchiveKeywordFromTerm);
archiveSeasonSelect.addEventListener("change", syncArchiveKeywordFromTerm);
archiveKeywordInput.addEventListener("input", () => {
  archiveYearSelect.value = "";
  archiveSeasonSelect.value = "";
  archiveResults.classList.add("hidden");
  setArchiveStatus();
});

archiveMatchButton.addEventListener("click", () => {
  const keyword = archiveKeywordInput.value.trim();
  if (!keyword) {
    archiveResults.classList.add("hidden");
    setArchiveStatus("请输入课程筛选关键词。", "error");
    return;
  }
  const matches = filterCoursesByKeyword(courses, keyword);
  renderArchiveMatches(matches);
  setArchiveStatus(
    matches.length ? `关键词“${keyword}”命中 ${matches.length} 门课程，请确认后归档。` : `没有课程命中关键词“${keyword}”。`,
    matches.length ? "ok" : ""
  );
});

archiveSelectAllButton.addEventListener("click", () => {
  archiveMatchList.querySelectorAll("input:not(:disabled)").forEach((input) => {
    input.checked = true;
  });
  refreshArchiveMatchSelection();
});

archiveSelectNoneButton.addEventListener("click", () => {
  archiveMatchList.querySelectorAll("input:not(:disabled)").forEach((input) => {
    input.checked = false;
  });
  refreshArchiveMatchSelection();
});

archiveSubmitButton.addEventListener("click", () => {
  const selected = checkedArchiveMatches();
  if (!selected.length) return;
  archiveConfirmCopy.textContent = `将把 ${selected.length} 门匹配课程移出雨课堂首页。归档后可在“我的归档”中恢复。`;
  archiveConfirmDialog.showModal();
});

archiveConfirmDialog.addEventListener("close", () => {
  if (archiveConfirmDialog.returnValue === "confirm") archiveSelectedCourses();
});

dateFromInput.addEventListener("change", () => applyLessonRange(true));
dateToInput.addEventListener("change", () => applyLessonRange(true));
dateResetButton.addEventListener("click", () => {
  dateFromInput.value = "";
  dateToInput.value = "";
  applyLessonRange(true);
});

chooseDirectoryButton.addEventListener("click", async () => {
  try {
    await chooseExportDirectory();
    setNotice(`已授权导出目录“${exportDirectoryHandle.name}”。`, "ok");
  } catch (error) {
    if (error?.name !== "AbortError") {
      setNotice(error.message || "无法授权导出目录。", "error");
    }
  }
});

duplicateModeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) chrome.storage.local.set({ duplicateMode: input.value });
  });
});

lessonSelectAllButton.addEventListener("click", () => {
  visibleLessonItems().forEach((item) => { item.querySelector("input").checked = true; });
  applyLessonRange(false);
});

lessonSelectNoneButton.addEventListener("click", () => {
  visibleLessonItems().forEach((item) => { item.querySelector("input").checked = false; });
  applyLessonRange(false);
});

backButton.addEventListener("click", () => {
  lessons = [];
  pendingCourses = [];
  setPhase("courses");
  setNotice("请选择课程后继续。");
});

selectAllButton.addEventListener("click", () => {
  courseList.querySelectorAll("input:not(:disabled)").forEach((input) => { input.checked = true; });
  refreshSelection();
});

selectNoneButton.addEventListener("click", () => {
  courseList.querySelectorAll("input:not(:disabled)").forEach((input) => { input.checked = false; });
  refreshSelection();
});

exportButton.addEventListener("click", async () => {
  try {
    if (phase === "courses") {
      await openConfigure();
      return;
    }
    await startExport();
  } catch (error) {
    setPhase("courses");
    setNotice(error.message || "操作失败。", "error");
  }
});

cancelButton.addEventListener("click", async () => {
  await send({ type: "CANCEL_EXPORT" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.exportState?.newValue) {
    renderProgress(changes.exportState.newValue);
  }
});

init().catch((error) => {
  setConnection("error", "连接失败");
  loadingPanel.classList.add("hidden");
  setNotice(error.message, "error");
});
