const $ = (selector) => document.querySelector(selector);

const notice = $("#notice");
const scanButton = $("#scan");
const exportButton = $("#export");
const cancelButton = $("#cancel");
const selectAllButton = $("#select-all");
const selectNoneButton = $("#select-none");
const coursePanel = $("#course-panel");
const courseList = $("#course-list");
const lessonPanel = $("#lesson-panel");
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
const backButton = $("#back");
const selectionLabel = $("#selection-label");
const courseSearch = $("#course-search");
const courseTotal = $("#course-total");
const noResults = $("#no-results");
const selectedCount = $("#selected-count");
const loadingPanel = $("#loading-panel");
const connectionStatus = $("#connection-status");
const connectionText = $("#connection-text");
const progressPanel = $("#progress-panel");
const progressLabel = $("#progress-label");
const progressCount = $("#progress-count");
const progressBar = $("#progress-bar");
const progressTrack = $(".progress-track");
const currentItem = $("#current-item");
const duplicateSummary = $("#duplicate-summary");
const errorDetails = $("#error-details");
const errorSummary = $("#error-summary");
const errorMessage = $("#error-message");

let activeTab = null;
let courses = [];
let running = false;
let phase = "courses";
let pendingCourses = [];
let lessons = [];
let lessonCheckedCount = 0;

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
  phase = next;
  coursePanel.classList.toggle("hidden", next !== "courses");
  lessonPanel.classList.toggle("hidden", next !== "lessons");
  refreshFooter();
}

function refreshFooter() {
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
  coursePanel.classList.remove("hidden");
  selectAllButton.disabled = false;
  selectNoneButton.disabled = false;
  courseSearch.value = currentCourse ? currentCourse.name : "";
  filterCourses();
  refreshFooter();
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
  const filters = { dateFrom: dateFromInput.value, dateTo: dateToInput.value, lessonIds };
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
  if (!state || state.status === "idle") return;

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

  running = state.status === "running" || state.status === "scanning";
  exportButton.classList.toggle("hidden", running);
  cancelButton.classList.toggle("hidden", !running);
  scanButton.disabled = running;
  courseSearch.disabled = running;
  courseList.querySelectorAll("input").forEach((input) => { input.disabled = running; });
  refreshFooter();

  if (state.status === "done") {
    if (!total) {
      setNotice("没有找到符合日期范围的课件。", "");
    } else {
      const duplicateCopy = duplicatesSkipped ? `，跳过 ${duplicatesSkipped} 个重复引用` : "";
      setNotice(`导出完成，共生成 ${state.completed} 个文件${duplicateCopy}。`, errors.length ? "" : "ok");
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
  }
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const connected = activeTab?.url?.startsWith("https://changjiang.yuketang.cn/");

  if (!connected) {
    setConnection("error", "未连接");
    setNotice("请先在当前标签页打开并登录长江雨课堂。", "error");
    loadingPanel.classList.add("hidden");
    scanButton.disabled = true;
    exportButton.disabled = true;
    return;
  }

  setConnection("connected", "已连接");
  const result = await send({ type: "GET_STATE" }).catch(() => null);
  if (result?.state) renderProgress(result.state);
  await scanCourses();
}

scanButton.addEventListener("click", scanCourses);
courseSearch.addEventListener("input", filterCourses);

dateFromInput.addEventListener("change", () => applyLessonRange(true));
dateToInput.addEventListener("change", () => applyLessonRange(true));
dateResetButton.addEventListener("click", () => {
  dateFromInput.value = "";
  dateToInput.value = "";
  applyLessonRange(true);
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
