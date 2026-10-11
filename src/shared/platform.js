export const PLATFORM_NAMES = {
  "www.yuketang.cn": "普通雨课堂",
  "pro.yuketang.cn": "荷塘雨课堂",
  "huanghe.yuketang.cn": "黄河雨课堂",
  "changjiang.yuketang.cn": "长江雨课堂"
};

export function parseYuketangUrl(value) {
  try {
    const parsed = new URL(value || "");
    const hostname = parsed.hostname.toLocaleLowerCase();
    const supported = parsed.protocol === "https:" &&
      (hostname === "yuketang.cn" || hostname.endsWith(".yuketang.cn"));
    return { parsed, hostname, supported };
  } catch {
    return { parsed: null, hostname: "", supported: false };
  }
}

export function getPlatformName(hostname) {
  return PLATFORM_NAMES[String(hostname || "").toLocaleLowerCase()] || "雨课堂";
}
