const $ = (selector) => document.querySelector(selector);

const notice = $("#notice");
const scanButton = $("#scan");
const exportButton = $("#export");
const cancelButton = $("#cancel");
const selectAllButton = $("#select-all");
const selectNoneButton = $("#select-none");
const coursePanel = $("#course-panel");
const courseList = $("#course-list");
const selectedCount = $("#selected-count");
const progressPanel = $("#progress-panel");
const progressLabel = $("#progress-label");
const progressCount = $("#progress-count");
const progressBar = $("#progress-bar");
const currentItem = $("#current-item");
const errorSummary = $("#error-summary");

let activeTab = null;
let courses = [];

function setNotice(message, type = "") {
  notice.textContent = message;
  notice.className = `notice ${type}`.trim();
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
  selectedCount.textContent = `${count} 门`;
  exportButton.disabled = count === 0;
}

function renderCourses(items) {
  courses = items;
  courseList.replaceChildren();

  for (const course of courses) {
    const label = document.createElement("label");
    label.className = "course-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(course.classroomId);
    input.checked = true;
    input.addEventListener("change", refreshSelection);

    const copy = document.createElement("div");
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    const meta = document.createElement("div");
    meta.className = "course-meta";
    meta.textContent = course.term ? `学期：${course.term}` : `课堂 ID：${course.classroomId}`;
    copy.append(name, meta);
    label.append(input, copy);
    courseList.append(label);
  }

  coursePanel.classList.remove("hidden");
  selectAllButton.disabled = false;
  selectNoneButton.disabled = false;
  refreshSelection();
}

function renderProgress(state) {
  if (!state || state.status === "idle") return;
  progressPanel.classList.remove("hidden");
  const total = Number(state.total || 0);
  const completed = Number(state.completed || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  progressBar.style.width = `${percent}%`;
  progressCount.textContent = `${completed} / ${total}`;
  progressLabel.textContent = state.label || "处理中";
  currentItem.textContent = state.current || "";
  errorSummary.textContent = state.errors?.length ? `已跳过 ${state.errors.length} 项：${state.errors.at(-1)}` : "";

  const running = state.status === "running" || state.status === "scanning";
  exportButton.classList.toggle("hidden", running);
  cancelButton.classList.toggle("hidden", !running);
  scanButton.disabled = running;

  if (state.status === "done") {
    setNotice(`导出完成：${state.completed} 个文件。`, state.errors?.length ? "" : "ok");
  } else if (state.status === "cancelled") {
    setNotice("任务已停止。", "");
  } else if (state.status === "error") {
    setNotice(state.error || "导出失败。", "error");
  }
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url?.startsWith("https://changjiang.yuketang.cn/")) {
    setNotice("请先在当前标签页打开并登录长江雨课堂。", "error");
    scanButton.disabled = true;
  } else {
    setNotice("已连接当前雨课堂标签页。点击“扫描课程”。", "ok");
  }

  const result = await send({ type: "GET_STATE" }).catch(() => null);
  if (result?.state) renderProgress(result.state);
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  setNotice("正在读取可访问课程……");
  try {
    const result = await send({ type: "SCAN_COURSES", tabId: activeTab.id });
    if (!result?.ok) throw new Error(result?.error || "扫描失败");
    renderCourses(result.courses);
    setNotice(`已发现 ${result.courses.length} 门课程。`, "ok");
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    scanButton.disabled = false;
  }
});

selectAllButton.addEventListener("click", () => {
  courseList.querySelectorAll("input").forEach((input) => { input.checked = true; });
  refreshSelection();
});

selectNoneButton.addEventListener("click", () => {
  courseList.querySelectorAll("input").forEach((input) => { input.checked = false; });
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

init().catch((error) => setNotice(error.message, "error"));
