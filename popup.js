const $ = (selector) => document.querySelector(selector);

const notice = $("#notice");
const scanButton = $("#scan");
const exportButton = $("#export");
const cancelButton = $("#cancel");
const selectAllButton = $("#select-all");
const selectNoneButton = $("#select-none");
const coursePanel = $("#course-panel");
const courseList = $("#course-list");
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
const errorDetails = $("#error-details");
const errorSummary = $("#error-summary");
const errorMessage = $("#error-message");

let activeTab = null;
let courses = [];
let running = false;

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

  for (const course of courses) {
    const label = document.createElement("label");
    label.className = "course-item";
    label.dataset.search = `${course.name} ${course.term || ""}`.toLocaleLowerCase("zh-CN");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(course.classroomId);
    input.checked = true;
    input.addEventListener("change", refreshSelection);

    const copy = document.createElement("div");
    copy.className = "course-copy";
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    name.title = course.name;
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = course.term || `课堂 ID：${course.classroomId}`;
    copy.append(name, meta);
    label.append(input, copy);
    courseList.append(label);
  }

  loadingPanel.classList.add("hidden");
  coursePanel.classList.remove("hidden");
  selectAllButton.disabled = false;
  selectNoneButton.disabled = false;
  filterCourses();
  refreshSelection();
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

  running = state.status === "running" || state.status === "scanning";
  exportButton.classList.toggle("hidden", running);
  cancelButton.classList.toggle("hidden", !running);
  scanButton.disabled = running;
  courseSearch.disabled = running;
  courseList.querySelectorAll("input").forEach((input) => { input.disabled = running; });
  refreshSelection();

  if (state.status === "done") {
    setNotice(`导出完成，共生成 ${state.completed} 个文件。`, errors.length ? "" : "ok");
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
    setNotice("课程已就绪，可选择后开始导出。", "ok");
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

selectAllButton.addEventListener("click", () => {
  courseList.querySelectorAll("input:not(:disabled)").forEach((input) => { input.checked = true; });
  refreshSelection();
});

selectNoneButton.addEventListener("click", () => {
  courseList.querySelectorAll("input:not(:disabled)").forEach((input) => { input.checked = false; });
  refreshSelection();
});

exportButton.addEventListener("click", async () => {
  const selected = checkedCourses();
  if (!selected.length) return;
  const result = await send({ type: "START_EXPORT", tabId: activeTab.id, courses: selected });
  if (!result?.ok) setNotice(result?.error || "无法启动导出。", "error");
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
