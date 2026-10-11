export const COURSE_SEASONS = ["春", "夏", "秋", "冬"];

const TERM_PATTERN = /(20\d{2})(春|夏|秋|冬)/g;

function termOrder(term) {
  return Number(term.year) * COURSE_SEASONS.length + COURSE_SEASONS.indexOf(term.season);
}

export function findLatestCourseTerm(courses) {
  let latest = null;
  for (const course of courses || []) {
    for (const match of String(course?.name || "").matchAll(TERM_PATTERN)) {
      const candidate = { year: Number(match[1]), season: match[2] };
      if (!latest || termOrder(candidate) > termOrder(latest)) latest = candidate;
    }
  }
  return latest;
}

export function previousTeachingTerm(term) {
  if (!term) return null;
  return term.season === "秋" || term.season === "冬"
    ? { year: term.year, season: "春" }
    : { year: term.year - 1, season: "秋" };
}

export function defaultArchiveTerm(courses, now = new Date()) {
  const latest = findLatestCourseTerm(courses);
  if (latest) return previousTeachingTerm(latest);

  const year = now.getFullYear();
  return now.getMonth() >= 7
    ? { year, season: "春" }
    : { year: year - 1, season: "秋" };
}

export function archiveYearOptions(now = new Date()) {
  const currentYear = now.getFullYear();
  return Array.from({ length: 9 }, (_, index) => currentYear - index);
}

export function archiveKeyword(year, season) {
  return year && COURSE_SEASONS.includes(season) ? `${year}${season}` : "";
}

export function filterCoursesByKeyword(courses, keyword) {
  const normalized = String(keyword || "").trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return [];
  return (courses || []).filter((course) =>
    String(course?.name || "").toLocaleLowerCase("zh-CN").includes(normalized)
  );
}
