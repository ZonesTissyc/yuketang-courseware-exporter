const STATE_KEY = "exportState";

export const initialTaskState = {
  status: "idle",
  label: "",
  current: "",
  total: 0,
  completed: 0,
  exported: 0,
  duplicatesSkipped: 0,
  localDuplicatesSkipped: 0,
  tabId: null,
  startedAt: 0,
  finishedAt: 0,
  errors: []
};

export const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export async function readTaskState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || initialTaskState;
}

export async function writeTaskState(patch) {
  const next = { ...(await readTaskState()), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

export async function resetTaskState() {
  const next = { ...initialTaskState, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}
