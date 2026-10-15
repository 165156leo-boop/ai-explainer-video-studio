const crypto = require("node:crypto");
const path = require("node:path");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function safeAccountId(value) {
  const source = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return source || `account-${Date.now().toString(36)}`;
}

function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(String(value || "").toLowerCase());
}

function isPathInside(filePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertReferencePath(filePath, allowedRoot) {
  if (!filePath || !isPathInside(filePath, allowedRoot)) {
    const error = new Error("参考文件不在工作台允许的目录内");
    error.code = "REFERENCE_PATH_NOT_ALLOWED";
    error.status = 400;
    throw error;
  }
  return path.resolve(filePath);
}

function extensionForContentType(contentType, mediaType) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/jpeg")) return ".jpg";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("image/gif")) return ".gif";
  if (normalized.includes("video/webm")) return ".webm";
  if (normalized.includes("video/quicktime")) return ".mov";
  if (normalized.includes("video/mp4")) return ".mp4";
  return mediaType === "video" ? ".mp4" : ".png";
}

function extractArtifactUrls(value, mediaType) {
  const normalized = String(value || "")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const candidates = normalized.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const pattern = mediaType === "video"
    ? /\.mp4(?:[?#]|$)|video|play_addr|vid=/i
    : /\.(?:png|jpe?g|webp)(?:[?#]|$)|image|img|tos-|byteimg|imagex/i;
  return [...new Set(candidates.map((url) => url.replace(/[),\]}]+$/g, "")).filter((url) => pattern.test(url)))];
}

function cleanMediaUrl(value) {
  return String(value || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractPreferredArtifacts(value, mediaType) {
  const artifacts = new Map();
  const roots = [];
  const source = String(value || "");
  const fragments = [source, ...source.split(/\r?\n/u).map((line) => line.replace(/^\s*data:\s*/u, "").trim())];
  for (const fragment of fragments) {
    if (!fragment || fragment === "[DONE]") continue;
    try {
      roots.push(JSON.parse(fragment));
    } catch {}
  }

  function addImage(raw, stableKey = "") {
    const image = typeof raw === "string" ? { url: raw } : raw;
    const url = cleanMediaUrl(image?.url);
    if (!/^https?:\/\//iu.test(url)) return;
    artifacts.set(`image:${stableKey || url}`, {
      url,
      kind: "image",
      width: Number(image.width || 0),
      height: Number(image.height || 0),
      key: String(stableKey || image.key || ""),
      priority: 100,
      source: "image_ori_raw",
    });
  }

  function addVideo(video) {
    const vid = String(video?.vid || video?.video_id || "").trim();
    const fallbackApi = cleanMediaUrl(video?.fallback_api);
    const directUrl = cleanMediaUrl(video?.main_url || video?.play_url);
    if (!vid && !fallbackApi && !/^https?:\/\//iu.test(directUrl)) return;
    const identity = `video:${vid || fallbackApi || directUrl}`;
    artifacts.set(identity, {
      identity,
      url: /^https?:\/\//iu.test(directUrl) ? directUrl : "",
      vid,
      fallbackApi,
      kind: "video",
      width: Number(video.width || video.vwidth || 0),
      height: Number(video.height || video.vheight || 0),
      priority: 100,
      source: "creation_video",
    });
  }

  function walk(node, parentKey = "", depth = 0) {
    if (node == null || depth > 32) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        try {
          walk(JSON.parse(text), parentKey, depth + 1);
        } catch {}
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    if (mediaType === "image" && node.image_ori_raw) addImage(node.image_ori_raw, node.key);
    if (mediaType === "video" && (node.fallback_api || (parentKey === "video" && (node.vid || node.video_id)))) {
      addVideo(node);
    }
    for (const [key, child] of Object.entries(node)) walk(child, key, depth + 1);
  }

  for (const root of roots) walk(root);
  return [...artifacts.values()];
}

function isReadyArtifactCandidate(candidate, mediaType) {
  if (!candidate) return false;
  const url = String(candidate.url || "");
  if (mediaType === "video") {
    if (candidate.source === "creation_video") {
      return Boolean(candidate.vid || candidate.fallbackApi || /^https?:\/\//iu.test(url));
    }
    return /^https?:\/\//iu.test(url) && /\.mp4(?:[?#]|$)/iu.test(url);
  }
  if (!/^https?:\/\//iu.test(url)) return false;
  if (candidate.source === "image_ori_raw") return true;
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  return width >= 512 && height >= 512 && Math.max(width, height) >= 1600;
}

const VIDEO_API_HOST_SUFFIXES = [".snssdk.com", ".douyinvod.com", ".dola.com", ".byteintlapi.com"];

function buildUnwatermarkedVideoApi(rawUrl) {
  const url = new URL(cleanMediaUrl(rawUrl));
  const hostname = url.hostname.toLowerCase();
  const trusted = VIDEO_API_HOST_SUFFIXES.some((suffix) =>
    hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
  if (url.protocol !== "https:" || !trusted || !url.pathname.startsWith("/video/fplay/")) {
    throw new Error("视频下载地址不属于受信任的豆包接口");
  }
  url.searchParams.set("codec_type", "8");
  url.searchParams.set("logo_type", "unwatermarked");
  return url.href;
}

function decodeLooseBase64(value) {
  const text = String(value || "").trim();
  const variants = [
    text,
    text.replace(/\$/g, "_").replace(/@/g, "/").replace(/#/g, "."),
    text.replace(/\$/g, "+").replace(/@/g, "/").replace(/#/g, "="),
  ];
  for (const variant of variants) {
    if (!variant) continue;
    const normalized = variant.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(variant.length / 4) * 4, "=");
    try {
      const decoded = Buffer.from(normalized, "base64");
      if (decoded.length) return decoded;
    } catch {}
  }
  return null;
}

function httpUrlFromBuffer(value) {
  if (!Buffer.isBuffer(value) || !value.length) return "";
  const url = value.toString("ascii").trim();
  return /^https?:\/\/[^\s]+$/iu.test(url) ? url : "";
}

function stripPkcs7(value) {
  const padding = value[value.length - 1];
  if (!padding || padding > 16 || padding > value.length) return value;
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) return value;
  }
  return value.subarray(0, value.length - padding);
}

function decryptVideoUrl(payload, key, iv) {
  if (!payload.length || payload.length % 16) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    const decoded = Buffer.concat([decipher.update(payload), decipher.final()]);
    return httpUrlFromBuffer(decoded) || httpUrlFromBuffer(stripPkcs7(decoded));
  } catch {
    return "";
  }
}

function decodeVideoMainUrl(token, keySeed = "") {
  const value = String(token || "").trim();
  if (/^https?:\/\//iu.test(value)) return value;
  const decoded = decodeLooseBase64(value);
  const plain = httpUrlFromBuffer(decoded);
  if (plain) return plain;
  const seed = decodeLooseBase64(keySeed);
  if (!value.startsWith("qAAB") || !decoded || !seed) return "";

  // qAAB protocol details are documented by ihmily/doubao-nomark (MIT).
  const salt = Buffer.from(
    "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
    "hex",
  );
  const firstDigest = crypto.createHash("sha512").update(seed.subarray(0, 32)).digest();
  const material = crypto.createHash("sha512").update(Buffer.concat([firstDigest, salt])).digest();
  const key = material.subarray(0, 16);
  const iv = material.subarray(16, 32);
  const attempts = [];
  if (decoded.subarray(0, 4).equals(Buffer.from([0xa8, 0x00, 0x01, 0x00]))) {
    attempts.push([decoded.subarray(4), key, iv], [decoded.subarray(4), iv, key]);
    if (decoded.length > 36) attempts.push([decoded.subarray(36), key, decoded.subarray(20, 36)], [decoded.subarray(36), key, iv]);
  } else {
    attempts.push([decoded, key, iv]);
  }
  for (const [payload, attemptKey, attemptIv] of attempts) {
    const url = decryptVideoUrl(payload, attemptKey, attemptIv);
    if (url) return url;
  }
  return "";
}

function selectBestVideoArtifact(payload, fallbackApi = "") {
  const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
  const data = videoInfo?.data && typeof videoInfo.data === "object" ? videoInfo.data : videoInfo;
  if (!data || typeof data !== "object") return null;
  const values = Array.isArray(data.video_list)
    ? data.video_list
    : data.video_list && typeof data.video_list === "object"
      ? Object.values(data.video_list)
      : [data];
  const candidates = values.filter((item) => item && typeof item === "object" && (item.main_url || item.play_url));
  const number = (item) => Number(item || 0) || 0;
  candidates.sort((left, right) => {
    const leftArea = number(left.vwidth || left.width) * number(left.vheight || left.height);
    const rightArea = number(right.vwidth || right.width) * number(right.vheight || right.height);
    return rightArea - leftArea || number(right.bitrate || right.real_bitrate) - number(left.bitrate || left.real_bitrate);
  });
  const selected = candidates[0];
  if (!selected) return null;
  const url = decodeVideoMainUrl(
    selected.main_url || selected.play_url,
    data.key_seed || videoInfo?.key_seed || payload?.key_seed || "",
  );
  if (!url) return null;
  return {
    url,
    vid: String(data.vid || data.video_id || selected.vid || selected.video_id || fallbackApi),
    kind: "video",
    width: number(selected.vwidth || selected.width || data.vwidth || data.width),
    height: number(selected.vheight || selected.height || data.vheight || data.height),
    priority: 100,
    source: "video_download",
  };
}

function normalizedPixelDifference(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length || !left.length) {
    return Number.POSITIVE_INFINITY;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length / 255;
}

/**
 * 豆包免费账号的视频额度模型（2026-09-16 用户实测确认）。
 *
 * 额度按「5 秒」为单位发放，每天约 10 个单位 = 50 秒。消耗按视频秒数计，
 * 所以不同时长的条数完全不一样：
 *   5 秒视频  → 最多 10 条/天
 *   10 秒视频 → 最多 5 条/天
 *   15 秒视频 → 最多 3 条/天，还剩 1 个单位（5 秒）
 * 关键推论：额度耗尽不是「整个账号今天不能用了」，而是「剩余秒数装不下这次时长」。
 * 因此账号分配要按剩余秒数判断，而不是简单地「用完就跳过」。
 */
const VIDEO_QUOTA_UNIT_SECONDS = Number(process.env.DOUBAO_VIDEO_QUOTA_UNIT_SECONDS || 5);
const VIDEO_DAILY_QUOTA_UNITS = Number(process.env.DOUBAO_VIDEO_QUOTA_UNITS || 10);
const VIDEO_DAILY_QUOTA_SECONDS = VIDEO_QUOTA_UNIT_SECONDS * VIDEO_DAILY_QUOTA_UNITS;

function localDayKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 读出账号当前的视频剩余额度。跨天后自动按「新的一天、额度回满」计算，
 * 但不写回账号（读路径保持无副作用），真正消耗时再由 applyVideoQuotaUsage 落盘。
 */
function videoQuotaState(account, today = localDayKey()) {
  const total = VIDEO_DAILY_QUOTA_SECONDS;
  const sameDay = Boolean(account) && account.video_quota_day === today;
  const usedRaw = sameDay ? Math.max(0, Number(account.video_quota_used_seconds) || 0) : 0;
  const used = Math.min(total, usedRaw);
  const exhausted = sameDay && account.video_quota_exhausted === true;
  const remaining = exhausted ? 0 : Math.max(0, total - used);
  return {
    day: today,
    unit_seconds: VIDEO_QUOTA_UNIT_SECONDS,
    total_seconds: total,
    used_seconds: used,
    remaining_seconds: remaining,
    exhausted,
    // 按单位折算的条数，便于工作台直接展示「还能做几条」
    can_5s: Math.floor(remaining / 5) || 0,
    can_10s: Math.floor(remaining / 10) || 0,
    can_15s: Math.floor(remaining / 15) || 0,
  };
}

function videoQuotaText(quota) {
  if (quota.exhausted || quota.remaining_seconds <= 0) return "今日视频额度已用完";
  return `今日剩余视频额度 ${quota.remaining_seconds} 秒（${quota.can_5s} 条 5 秒 / ${quota.can_10s} 条 10 秒 / ${quota.can_15s} 条 15 秒）`;
}

/** 消耗额度：跨天先归零回满，再按秒数扣减。返回扣减后的状态。 */
function applyVideoQuotaUsage(account, seconds, today = localDayKey()) {
  if (!account) return videoQuotaState(account, today);
  if (account.video_quota_day !== today) {
    account.video_quota_day = today;
    account.video_quota_used_seconds = 0;
    account.video_quota_exhausted = false;
  }
  const cost = Math.max(0, Math.round(Number(seconds) || 0));
  account.video_quota_used_seconds = Math.min(
    VIDEO_DAILY_QUOTA_SECONDS,
    Math.max(0, Number(account.video_quota_used_seconds) || 0) + cost,
  );
  return videoQuotaState(account, today);
}

/** 豆包明确回了「免费次数用完／需要订阅」时调用：把当日额度直接记为用尽。 */
function markVideoQuotaExhausted(account, today = localDayKey()) {
  if (!account) return videoQuotaState(account, today);
  if (account.video_quota_day !== today) {
    account.video_quota_day = today;
    account.video_quota_used_seconds = 0;
  }
  account.video_quota_used_seconds = VIDEO_DAILY_QUOTA_SECONDS;
  account.video_quota_exhausted = true;
  return videoQuotaState(account, today);
}

function publicAccount(account) {
  const quota = videoQuotaState(account);
  return {
    account_id: account.account_id,
    display_name: account.display_name,
    enabled: account.enabled !== false,
    last_login_status: account.last_login_status || "unknown",
    last_login_reason: account.last_login_reason || "",
    quota_balance_text: account.quota_balance_text || videoQuotaText(quota),
    // 2026-09-16：视频剩余额度按秒暴露，工作台据此跳过装不下本次时长的账号。
    video_quota_day: quota.day,
    video_quota_unit_seconds: quota.unit_seconds,
    video_quota_total_seconds: quota.total_seconds,
    video_quota_used_seconds: quota.used_seconds,
    video_quota_remaining_seconds: quota.remaining_seconds,
    video_quota_exhausted: quota.exhausted,
    video_quota_can_5s: quota.can_5s,
    video_quota_can_10s: quota.can_10s,
    video_quota_can_15s: quota.can_15s,
    video_quota_text: videoQuotaText(quota),
    last_used_at: account.last_used_at || null,
    updated_at: account.updated_at || null,
  };
}

function providerError(message, status = 500, code = "DOUBAO_NATIVE_FAILED") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  VIDEO_DAILY_QUOTA_SECONDS,
  VIDEO_DAILY_QUOTA_UNITS,
  VIDEO_QUOTA_UNIT_SECONDS,
  applyVideoQuotaUsage,
  assertReferencePath,
  buildUnwatermarkedVideoApi,
  decodeVideoMainUrl,
  extensionForContentType,
  extractArtifactUrls,
  extractPreferredArtifacts,
  isLoopbackHost,
  localDayKey,
  markVideoQuotaExhausted,
  isPathInside,
  isReadyArtifactCandidate,
  normalizedPixelDifference,
  providerError,
  publicAccount,
  safeAccountId,
  selectBestVideoArtifact,
  videoQuotaState,
  videoQuotaText,
};
