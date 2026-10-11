import { formatDate } from "../shared/format.js";
import { parseYuketangUrl } from "../shared/platform.js";

export async function validateSiteTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!parseYuketangUrl(tab.url).supported) {
    throw new Error("请保持一个已登录的雨课堂标签页打开。 ");
  }
  return tab;
}

export async function pageFetch(tabId, path, options = {}) {
  await validateSiteTab(tabId);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [path, options],
    func: async (requestPath, requestOptions) => {
      try {
        const method = String(requestOptions.method || "GET").toUpperCase();
        const headers = { ...(requestOptions.headers || {}) };
        if (!["GET", "HEAD"].includes(method) && !headers["X-CSRFToken"]) {
          const csrfCookie = document.cookie
            .split(";")
            .map((part) => part.trim().split("="))
            .find(([name]) => name === "csrftoken");
          if (csrfCookie?.[1]) headers["X-CSRFToken"] = decodeURIComponent(csrfCookie[1]);
        }
        const response = await fetch(requestPath, {
          credentials: "include",
          ...requestOptions,
          headers
        });
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
    term: raw.term || "",
    teacherName: raw.teacher?.name || ""
  };
}

function assertApiSuccess(response, fallbackMessage) {
  if (response?.errcode && response.errcode !== 0) {
    throw new Error(response.errmsg || fallbackMessage);
  }
  return response;
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

export async function scanCourses(tabId) {
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

export async function scanArchivedCourses(tabId) {
  const userInfo = assertApiSuccess(
    await pageFetch(tabId, "/v2/api/web/userinfo"),
    "未能读取当前用户信息。"
  );
  const userId = userInfo?.data?.[0]?.user_id ?? userInfo?.data?.user_id ??
    userInfo?.data?.user?.user_id ?? userInfo?.data?.id ?? userInfo?.user_id;
  if (!userId) throw new Error("未能识别当前用户，无法读取归档课程。");

  const response = assertApiSuccess(
    await pageFetch(
      tabId,
      `/v2/api/web/classroom_archive?user_id=${encodeURIComponent(userId)}`
    ),
    "未能读取归档课程。"
  );
  const list = response?.data?.classrooms;
  if (!Array.isArray(list)) throw new Error("归档课程接口返回了无法识别的数据。");
  return list.map(normalizeCourse).filter((course) => course.classroomId);
}

export async function setCourseArchived(tabId, classroomId, archived) {
  const response = await pageFetch(tabId, "/v2/api/web/classroom_archive_set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classroom_id: Number(classroomId),
      action: archived ? 1 : 0
    })
  });
  assertApiSuccess(response, archived ? "课程归档失败。" : "课程恢复失败。");
  return true;
}

export async function collectLessons(tabId, course, shouldCancel = () => false) {
  const lessons = [];
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    if (shouldCancel()) break;
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

export async function scanLessons(tabId, course) {
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
