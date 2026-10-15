const { app, BrowserWindow, nativeImage, session } = require("electron");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} = require("node:fs/promises");
const {
  VIDEO_DAILY_QUOTA_SECONDS,
  applyVideoQuotaUsage,
  assertReferencePath,
  extensionForContentType,
  isLoopbackHost,
  localDayKey,
  markVideoQuotaExhausted,
  normalizedPixelDifference,
  providerError,
  publicAccount,
  safeAccountId,
  videoQuotaState,
  videoQuotaText,
} = require("./provider-core.cjs");
const {
  // 参考图张数上限的唯一定义在 doubao-adapter.cjs；这里**必须真的 import 进来**——
  // 2026-09-18 真机跑生图时当场报 `MAX_REFERENCE_IMAGES is not defined`：
  // 常量导出是有的，只是这一行漏了解构，于是任何「带参考图」的提交都在
  // normalizeReferenceFiles 里直接抛 ReferenceError（单元测试全绿也发现不了，
  // 因为 main.cjs 依赖 Electron、不进单测）。已由 test/module-wiring.test.cjs 锁住。
  MAX_REFERENCE_IMAGES,
  createDoubaoAdapter,
} = require("./doubao-adapter.cjs");
const {
  classifySubmissionState,
  verifyGenerationAnnouncement,
} = require("./semantic-guard.cjs");

const HOST = process.env.DOUBAO_NATIVE_HOST || "127.0.0.1";
const PORT = Number(process.env.DOUBAO_NATIVE_PORT || 8012);
const FAKE_MODE = process.env.DOUBAO_NATIVE_FAKE === "1";
const DEBUG_API = process.env.DOUBAO_NATIVE_DEBUG === "1";
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const workbenchRoot = path.join(localAppData, "AI科普视频制作台");
const stateRoot = process.env.DOUBAO_NATIVE_DATA || path.join(workbenchRoot, "native-provider");
const requestRoot = path.join(workbenchRoot, "media-requests");
const accountsFile = path.join(stateRoot, "accounts.json");
const accountOwnersFile = path.join(workbenchRoot, "media-account-owners.json");
const jobsFile = path.join(stateRoot, "jobs.json");
const outputRoot = path.join(stateRoot, "output");
const logFile = path.join(stateRoot, "provider.log");
const fakePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

if (!isLoopbackHost(HOST)) throw new Error("Doubao Native Provider 只能监听本机回环地址");
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error("Provider 端口无效");
if (FAKE_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
}

app.setName("AI 科普动画生产工作台 · 豆包后台");
app.setPath("userData", path.join(stateRoot, "electron-profile"));

const gotLock = FAKE_MODE || app.requestSingleInstanceLock({ host: HOST, port: PORT });
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let accounts = [];
let jobs = [];
let adapter;
let server;
let writeSequence = Promise.resolve();
const accountQueues = new Map();

async function ownerEmailForAccount(accountId, requestedEmail = "") {
  const explicit = String(requestedEmail || "").trim().toLowerCase();
  if (explicit) return explicit;
  try {
    const owners = JSON.parse(await readFile(accountOwnersFile, "utf8"));
    return String(owners?.[accountId] || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function now() {
  return new Date().toISOString();
}

function log(message, details) {
  const line = `[${now()}] ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`;
  void appendFile(logFile, line, "utf8").catch(() => undefined);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function queueWrite(filePath, value) {
  const snapshot = JSON.stringify(value, null, 2) + "\n";
  const operation = writeSequence.then(async () => {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  });
  writeSequence = operation.catch(() => undefined);
  return operation;
}

async function saveAccounts() {
  await queueWrite(accountsFile, accounts);
}

async function saveJobs() {
  await queueWrite(jobsFile, jobs);
}

function findAccount(accountId) {
  const account = accounts.find((item) => item.account_id === accountId);
  if (!account) throw providerError("豆包账号不存在", 404, "ACCOUNT_NOT_FOUND");
  if (account.enabled === false) throw providerError("豆包账号已停用", 409, "ACCOUNT_DISABLED");
  return account;
}

function findJob(jobId) {
  const job = jobs.find((item) => item.job_id === jobId);
  if (!job) throw providerError("豆包任务不存在", 404, "JOB_NOT_FOUND");
  return job;
}

async function updateAccountSession(account, state) {
  account.last_login_status = state.loggedIn
    ? "logged_in"
    : state.verificationRequired
      ? "verification_required"
      : "logged_out";
  account.last_login_reason = state.reason || "";
  account.updated_at = now();
  await saveAccounts();
}

/**
 * 单次任务可携带的参考图上限由 doubao-adapter.cjs 统一定义并导出（单一来源，
 * 避免两处各写一个数字后悄悄漂移）。超限**显式报错**而不是截断：截断等于静默丢素材，
 * 正是 2026-09-18 用户点出的那类缺陷（「不能太局限，要包容」，但包容不等于悄悄扔掉）。
 */
function normalizeReferenceFiles(body) {
  if (!Array.isArray(body.reference_images)) return [];
  if (body.reference_images.length > MAX_REFERENCE_IMAGES) {
    throw providerError(
      `参考图最多 ${MAX_REFERENCE_IMAGES} 张，本次收到 ${body.reference_images.length} 张；`
        + "请先删减再提交（不会自动截断丢弃）。",
      400,
      "REFERENCE_TOO_MANY",
    );
  }
  return body.reference_images.map((item) =>
    assertReferencePath(item && item.file_path, requestRoot),
  );
}

/**
 * 视频任务的额度预检（2026-09-16 用户要求）。
 *
 * 豆包免费账号的视频额度按 5 秒为单位发放（约 10 个单位 = 50 秒/天/账号），
 * 消耗按视频秒数计，所以「额度不够」是按本次时长判断的，不能一刀切：
 * 剩 5 秒的账号做得了 5 秒镜头、做不了 15 秒镜头。
 *
 * 预检只是「少浪费一次提交」的第一道闸：计数来自本机历史，若用户还在网页上
 * 手动生成，账面可能偏乐观——真正的判定仍由豆包返回（收到额度文案后
 * markVideoQuotaExhausted 会把当日额度直接记为用尽）。
 * 需要强制重试时，请求体带 `allow_quota_override: true` 可跳过预检。
 */
function assertVideoQuotaAvailable(account, job, body = {}) {
  if (job.media_type !== "video" || FAKE_MODE) return;
  if (body.allow_quota_override === true) return;
  const quota = videoQuotaState(account);
  const need = Math.max(0, Number(job.duration) || 0) || 5;
  if (quota.remaining_seconds >= need) return;
  throw providerError(
    `“${account.display_name}”${videoQuotaText(quota)}，装不下这次 ${need} 秒的视频；`
      + "请换一个有额度的账号，或把镜头时长降到剩余额度以内。",
    429,
    "DOUBAO_VIDEO_QUOTA_INSUFFICIENT",
  );
}

function newJob(body, mediaType) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw providerError("缺少生成提示词", 400, "PROMPT_REQUIRED");
  const account = findAccount(String(body.account_id || ""));
  const createdAt = now();
  return {
    job_id: crypto.randomUUID(),
    account_id: account.account_id,
    // 用于异常 UI 定位时读取当前登录用户自己的文本/视觉模型配置；不存 API Key。
    owner_email: String(body.owner_email || "").trim().toLowerCase(),
    media_type: mediaType,
    status: "queued",
    stage: "queued",
    prompt,
    // 2026-09-16：视频默认走成本最低、且完整支持 4–15 秒的 Mini 档；
    // 需要更高画质的镜头由工作台显式指定 seedance-2.0（只支持 5 秒档）。
    model: String(body.model || (mediaType === "video" ? "seedance-2.0-mini" : "seedream-4.5")),
    aspect_ratio: String(body.aspect_ratio || "16:9"),
    duration: body.duration ? String(body.duration) : "",
    // 2026-09-18：运镜参数从硬编码 'fixed' 改为可由请求指定（空串则用适配器默认值）。
    // 目的不是马上改行为，而是把「机位锁死」这个可能的成片元凶变成可验证项——
    // 默认值与修复前完全一致，不会影响已验证的路径。
    camera_movement: String(body.camera_movement || ""),
    reference_files: normalizeReferenceFiles(body),
    data: [],
    created_at: createdAt,
    updated_at: createdAt,
    error_message: "",
  };
}

function publicJob(job) {
  return {
    job_id: job.job_id,
    account_id: job.account_id,
    status: job.status,
    stage: job.stage,
    data: job.data,
    error_code: job.error_code || "",
    error_message: job.error_message || "",
    http_status: Number(job.http_status || 0),
    acknowledgement_text: job.acknowledgement_text || "",
    completion_text: job.completion_text || "",
    estimated_wait_text: job.status === "running" ? "豆包正在生成，完成后会自动回到工作台" : "",
    quota_balance_text: "",
    video_quota_consumed_seconds: Number(job.video_quota_consumed_seconds || 0),
    video_quota_remaining_seconds:
      typeof job.video_quota_remaining_seconds === "number" ? job.video_quota_remaining_seconds : null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

async function storeFetchedArtifacts(job, account, candidates) {
  const output = [];
  const hashes = new Set();
  const visualFingerprints = [];
  const rejected = new Map();
  const reject = (reason) => rejected.set(reason, (rejected.get(reason) || 0) + 1);
  const ratioParts = String(job.aspect_ratio || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u);
  const requestedRatio = ratioParts ? Number(ratioParts[1]) / Number(ratioParts[2]) : 0;
  let index = 0;
  for (const candidate of candidates) {
    if (job.media_type === "image" && output.length >= 4) break;
    try {
      let buffer;
      let contentType;
      if (FAKE_MODE && candidate.fake) {
        buffer = job.media_type === "video" ? Buffer.from("fake-video") : fakePng;
        contentType = job.media_type === "video" ? "video/mp4" : "image/png";
      } else if (candidate.vid && !candidate.url) {
        // 2026-09-16：视频直连通道只回 `{ vid }`——成片在豆包「我的创作」里，没有直链 URL。
        // 旧代码拿 undefined 去 fetch，报 "Failed to parse URL from undefined"，
        // 任务以 ARTIFACT_NOT_AVAILABLE 失败（视频其实已经生成好）。
        // 这里改走已经验证过的作品库取片链路；成片刚入库时豆包侧下载地址还没就绪，所以轮询等待。
        const downloadPath = path.join(
          outputRoot,
          `${job.job_id}-${String(index + 1).padStart(2, "0")}.mp4`,
        );
        let fetched = { ok: false, reason: "not_started" };
        for (let attempt = 0; attempt < 24; attempt += 1) {
          fetched = await adapter.fetchLibraryVideo(account, candidate.vid, downloadPath);
          if (fetched.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        if (!fetched.ok) {
          reject(`library_${String(fetched.reason || "unknown").replace(/\s+/gu, "_").slice(0, 40)}`);
          continue;
        }
        buffer = await readFile(downloadPath);
        contentType = "video/mp4";
      } else {
        const response = await adapter.fetchArtifact(account, candidate.url);
        if (!response.ok) {
          reject(`http_${response.status}`);
          continue;
        }
        contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
        const requiredPrefix = job.media_type === "video" ? "video/" : "image/";
        if (!contentType.startsWith(requiredPrefix)) {
          reject("content_type");
          continue;
        }
        buffer = Buffer.from(await response.arrayBuffer());
      }
      if (!buffer || buffer.length < (FAKE_MODE ? 1 : 1024)) {
        reject("file_too_small");
        continue;
      }
      if (!FAKE_MODE && job.media_type === "image") {
        const image = nativeImage.createFromBuffer(buffer);
        const size = image.getSize();
        if (size.width < 512 || size.height < 512 || Math.max(size.width, size.height) < 1600) {
          reject("image_dimensions");
          continue;
        }
        if (requestedRatio && Math.abs(size.width / size.height - requestedRatio) / requestedRatio > 0.08) {
          reject("aspect_ratio");
          continue;
        }
        const fingerprint = image.resize({ width: 32, height: 18, quality: "good" }).toBitmap();
        if (visualFingerprints.some((existing) => normalizedPixelDifference(existing, fingerprint) < 0.01)) {
          reject("visual_duplicate");
          continue;
        }
        visualFingerprints.push(fingerprint);
      }
      const digest = crypto.createHash("sha256").update(buffer).digest("hex");
      if (hashes.has(digest)) {
        reject("file_duplicate");
        continue;
      }
      hashes.add(digest);
      const extension = extensionForContentType(contentType, job.media_type);
      const fileName = `${job.job_id}-${String(index + 1).padStart(2, "0")}${extension}`;
      await writeFile(path.join(outputRoot, fileName), buffer, { mode: 0o600 });
      output.push({
        url: `http://${HOST}:${server.address().port}/media/${encodeURIComponent(fileName)}`,
        revised_prompt: job.prompt,
      });
      index += 1;
    } catch (error) {
      reject("fetch_error");
      log("artifact candidate skipped", {
        jobId: job.job_id,
        host: (() => { try { return new URL(candidate.url).host; } catch { return "invalid"; } })(),
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
  if (rejected.size) {
    log("artifact_candidates_rejected", {
      jobId: job.job_id,
      mediaType: job.media_type,
      reasons: Object.fromEntries(rejected),
    });
  }
  if (!output.length && !FAKE_MODE) {
    const extension = job.media_type === "video" ? ".mp4" : ".png";
    const fileName = `${job.job_id}-01${extension}`;
    const filePath = path.join(outputRoot, fileName);
    const downloaded = await adapter.downloadLatestArtifact(account, filePath);
    if (downloaded) {
      const info = await stat(filePath);
      if (info.size >= 1024) {
        output.push({
          url: `http://${HOST}:${server.address().port}/media/${encodeURIComponent(fileName)}`,
          revised_prompt: job.prompt,
        });
      }
    }
  }
  if (!output.length) {
    throw providerError(
      "豆包任务已提交，但没有取得可验证的媒体文件；请先到豆包历史记录核对，系统不会自动重复发送",
      502,
      "ARTIFACT_NOT_AVAILABLE",
    );
  }
  return output;
}

/**
 * 提交一次生成任务。
 *
 * 2026-09-15 晚：这里曾加过“带参考图被豆包放弃时自动去图重试”的降级，现已删除。
 * 取证结论（见 PROJECT.md Log 第九轮）：参考图上传链路完全正常，真正失败点是
 * 豆包服务端对“文本＋图片附件”的视频请求返回 `710020702 system error`，客户端
 * 因此把会话丢回空对话；去图重试只是绕开附件，会掩盖问题且出片不锚定首帧。
 * 带图提交失败按原始错误码直接失败。
 */
async function runGeneration(account, job) {
  if (FAKE_MODE) return [{ fake: true, url: "fake://artifact" }];
  const ownerEmail = await ownerEmailForAccount(account.account_id, job.owner_email);
  return adapter.generate(account, {
    prompt: job.prompt,
    model: job.model,
    aspect_ratio: job.aspect_ratio,
    duration: job.duration,
    cameraMovement: job.camera_movement,
    ownerEmail,
    referenceFiles: job.reference_files,
  }, job.media_type);
}

async function executeJob(job) {
  const account = findAccount(job.account_id);
  job.status = "running";
  job.stage = "checking_session";
  job.updated_at = now();
  await saveJobs();
  try {
    if (!FAKE_MODE) {
      const state = await adapter.check(account);
      await updateAccountSession(account, state);
      if (!state.loggedIn) {
        throw providerError(
          state.verificationRequired ? "豆包要求人工验证，请在弹出的账号窗口完成验证" : "豆包账号未登录，请先在配置中登录",
          401,
          state.verificationRequired ? "DOUBAO_VERIFICATION_REQUIRED" : "DOUBAO_LOGIN_REQUIRED",
        );
      }
    }
    job.stage = "submitted_or_generating";
    job.updated_at = now();
    await saveJobs();
    const candidates = await runGeneration(account, job);
    job.stage = "downloading";
    job.updated_at = now();
    await saveJobs();
    job.data = await storeFetchedArtifacts(job, account, candidates);
    job.status = "succeeded";
    job.stage = "completed";
    // 2026-09-16：视频按秒消耗豆包当日免费额度，成功出片后记账（额度按 5 秒单位发放）。
    if (job.media_type === "video") {
      const consumed = applyVideoQuotaUsage(account, Number(job.duration) || 5);
      job.video_quota_consumed_seconds = Number(job.duration) || 5;
      job.video_quota_remaining_seconds = consumed.remaining_seconds;
      log("video_quota_consumed", {
        accountId: account.account_id,
        seconds: Number(job.duration) || 5,
        remainingSeconds: consumed.remaining_seconds,
        quotaText: videoQuotaText(consumed),
      });
    }
    job.completion_text = `已由“${account.display_name}”生成并回传到工作台`
      + (job.media_type === "video"
        ? `（${account.display_name}${videoQuotaText(videoQuotaState(account))}）`
        : "");
    job.updated_at = now();
    account.last_used_at = job.updated_at;
    account.updated_at = job.updated_at;
    await Promise.all([saveJobs(), saveAccounts()]);
  } catch (error) {
    job.status = "failed";
    job.stage = ["SUBMISSION_UNCERTAIN", "ARTIFACT_NOT_AVAILABLE", "GENERATION_TIMEOUT"].includes(error?.code)
      ? "needs_reconciliation"
      : "failed";
    job.error_message = error instanceof Error ? error.message : "豆包任务失败";
    job.error_code = error?.code || "DOUBAO_NATIVE_FAILED";
    job.http_status = Number(error?.status || 502);
    job.updated_at = now();
    // 豆包明确回了「免费次数用完／需要订阅」：把当日额度记为用尽，
    // 这样后续自动分配会直接跳过该账号，而不是再白跑一次。
    if (job.media_type === "video" && error?.code === "DOUBAO_QUOTA_EXHAUSTED") {
      const quota = markVideoQuotaExhausted(account);
      job.video_quota_remaining_seconds = quota.remaining_seconds;
      account.updated_at = now();
      log("video_quota_exhausted", { accountId: account.account_id, day: quota.day });
      await saveAccounts();
    }
    await saveJobs();
    throw error;
  }
}

function schedule(job) {
  const key = `${job.account_id}:${job.media_type}`;
  const limit = job.media_type === "image" ? 2 : 1;
  const state = accountQueues.get(key) || { active: 0, pending: [] };
  accountQueues.set(key, state);

  return new Promise((resolve, reject) => {
    state.pending.push({ job, resolve, reject });
    const startNext = () => {
      while (state.active < limit && state.pending.length) {
        const next = state.pending.shift();
        state.active += 1;
        Promise.resolve(executeJob(next.job))
          .then(next.resolve, next.reject)
          .finally(() => {
            state.active -= 1;
            if (!state.active && !state.pending.length) accountQueues.delete(key);
            else startNext();
          });
      }
    };
    startNext();
  });
}

function json(response, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(data);
}

function sendError(response, error) {
  const status = Number(error?.status || 500);
  log("request failed", { code: error?.code, message: error?.message });
  json(response, status, {
    error: {
      code: error?.code || "DOUBAO_NATIVE_FAILED",
      message: error instanceof Error ? error.message : "Provider 请求失败",
    },
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw providerError("请求内容过大", 413, "REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw providerError("请求 JSON 无效", 400, "INVALID_JSON");
  }
}

async function serveMedia(request, response, fileName) {
  const safeName = path.basename(decodeURIComponent(fileName));
  if (!safeName || safeName !== decodeURIComponent(fileName)) {
    throw providerError("媒体文件路径无效", 400, "INVALID_MEDIA_PATH");
  }
  const filePath = path.join(outputRoot, safeName);
  const info = await stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw providerError("媒体文件不存在", 404, "MEDIA_NOT_FOUND");
    throw error;
  });
  const extension = path.extname(safeName).toLowerCase();
  const contentType = extension === ".mp4" ? "video/mp4"
    : extension === ".webm" ? "video/webm"
      : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
        : extension === ".webp" ? "image/webp"
          : "image/png";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": info.size,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(await readFile(filePath));
}

async function handle(request, response) {
  const remote = request.socket.remoteAddress || "";
  if (!isLoopbackHost(remote.replace(/^::ffff:/, ""))) {
    throw providerError("只允许本机访问", 403, "LOOPBACK_ONLY");
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/providers/doubao/health") {
    return json(response, 200, { status: "ok", provider: "doubao-native-electron", mode: FAKE_MODE ? "fake" : "live" });
  }
  if (request.method === "GET" && pathname === "/providers/doubao/accounts") {
    return json(response, 200, { accounts: accounts.map(publicAccount) });
  }
  if (request.method === "POST" && pathname === "/providers/doubao/accounts") {
    const body = await readBody(request);
    const displayName = String(body.display_name || "").trim().slice(0, 120);
    if (!displayName) throw providerError("请填写豆包账号名称", 400, "ACCOUNT_NAME_REQUIRED");
    let accountId = safeAccountId(body.account_id || displayName);
    if (accounts.some((item) => item.account_id === accountId)) {
      accountId = `${accountId}-${Date.now().toString(36)}`;
    }
    const account = {
      account_id: accountId,
      display_name: displayName,
      enabled: true,
      last_login_status: FAKE_MODE ? "logged_in" : "unknown",
      last_login_reason: FAKE_MODE ? "测试会话" : "尚未检查网页登录",
      last_used_at: null,
      updated_at: now(),
    };
    accounts.push(account);
    await saveAccounts();
    return json(response, 201, publicAccount(account));
  }

  let match = pathname.match(/^\/providers\/doubao\/accounts\/([^/]+)\/session\/(check|init)$/);
  if (match && ((request.method === "GET" && match[2] === "check") || (request.method === "POST" && match[2] === "init"))) {
    const account = findAccount(decodeURIComponent(match[1]));
    const body = request.method === "POST" ? await readBody(request) : {};
    const state = FAKE_MODE
      ? { loggedIn: true, verificationRequired: false, reason: "测试会话", pageUrl: "https://www.doubao.com/chat/create-image" }
      : match[2] === "init"
        ? await adapter.login(account, Math.min(Math.max(Number(body.timeout_sec || 3600), 30), 3600) * 1000)
        : await adapter.check(account);
    await updateAccountSession(account, state);
    return json(response, 200, {
      logged_in: Boolean(state.loggedIn),
      account_id: account.account_id,
      reason: state.reason || "",
      page_url: state.pageUrl || "",
      quota_balance_text: account.quota_balance_text || "",
    });
  }

  if (request.method === "POST" && pathname === "/providers/doubao/v1/images/generations") {
    const job = newJob(await readBody(request), "image");
    jobs.push(job);
    await saveJobs();
    try {
      await schedule(job);
    } catch (error) {
      error.status = job.http_status || error.status;
      error.code = job.error_code || error.code;
      throw error;
    }
    return json(response, 200, {
      created: Math.floor(Date.now() / 1000),
      account_id: job.account_id,
      data: job.data,
      completion_text: job.completion_text,
      quota_balance_text: "",
    });
  }

  if (request.method === "POST" && pathname === "/providers/doubao/video-jobs") {
    const body = await readBody(request);
    const job = newJob(body, "video");
    // 2026-09-26（用户拍板）：视频任务必须至少挂 1 张参考图——分镜图/尾帧是画面锚，
    // 038eb112 实证 0 参考图的成片完全不跟随分镜。工作台已加同款闸门，这里兜底
    // 拦住绕过工作台的直连提交。
    if (!job.reference_files.length) {
      throw providerError(
        "视频任务必须至少挂 1 张参考图（本镜分镜画面或上一镜尾帧）",
        400,
        "VIDEO_REFERENCE_REQUIRED",
      );
    }
    assertVideoQuotaAvailable(findAccount(job.account_id), job, body);
    jobs.push(job);
    await saveJobs();
    void schedule(job).catch((error) => log("video job failed", { jobId: job.job_id, message: error?.message }));
    return json(response, 202, publicJob(job));
  }

  match = pathname.match(/^\/providers\/doubao\/video-jobs\/([^/]+)$/);
  if (request.method === "GET" && match) {
    return json(response, 200, publicJob(findJob(decodeURIComponent(match[1]))));
  }

  if (request.method === "GET" && pathname === "/providers/doubao/debug/windows") {
    return json(response, 200, await adapter.debugTaskWindows());
  }

  if (pathname.startsWith("/providers/doubao/debug/") && !DEBUG_API) {
    throw providerError("诊断接口未启用", 404, "NOT_FOUND");
  }

  // 只读诊断：视频页输入区/上传区的真实 DOM（不提交、不消耗额度）。支持 ?account_id= 指定账号。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/video-composer") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    return json(response, 200, await adapter.debugVideoComposer(account));
  }

  // 只读诊断：首页「视频生成」chip 切出的真实提交面结构（不提交、不消耗额度）。
  // ?attach=<绝对路径> 可先挂一张参考图再转储，用于确认豆包是否提供「首尾帧」第二个图片位。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/video-mode-surface") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    return json(response, 200, await adapter.debugVideoModeSurface(account, {
      attachPath: String(query.searchParams.get("attach") || "").trim(),
    }));
  }

  // 只读诊断：挂多张参考图，捕获全部 prepare_upload/CommitImageUpload 的请求体与响应体，
  // 用于确认多图在豆包侧的真实回报结构（不发送、不提交、不消耗额度）。
  // ?attach=<绝对路径>[;<绝对路径>...] 多张用分号分隔。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/reference-upload") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    const raw = String(query.searchParams.get("attach") || "").trim();
    return json(response, 200, await adapter.debugReferenceUpload(account, {
      paths: raw.split(";").map((item) => item.trim()).filter(Boolean),
    }));
  }

  // 只读诊断：点开创作页模型选择器下拉，读取各档位可用性/角标（不选择、不提交）。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/model-selector") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    return json(response, 200, await adapter.debugModelSelector(account));
  }

  // 只读诊断：回读指定会话页文本（宣布句/参数卡片/确认按钮状态），用于降档定位。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/conversation-page") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const conversationId = String(query.searchParams.get("conversation_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    return json(response, 200, await adapter.debugConversationPage(account, conversationId));
  }

  // 只读诊断：豆包“我的创作”最近作品，用于判断是否真的产出过视频。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/library") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requested = String(query.searchParams.get("account_id") || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    return json(response, 200, await adapter.debugLibrary(account));
  }

  // 恢复路径：按 vid 把“我的创作”里已经生成好的视频取回本地并回传 /media/ 链接。
  if (request.method === "GET" && pathname === "/providers/doubao/debug/fetch-library-video") {
    const query = new URL(request.url, `http://${HOST}:${PORT}`);
    const requestedAccount = String(query.searchParams.get("account_id") || "").trim();
    const account = (requestedAccount && accounts.find((item) => item.account_id === requestedAccount))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    if (!account) throw providerError("还没有可用账号", 409, "ACCOUNT_NOT_FOUND");
    const vid = String(query.searchParams.get("vid") || "").trim();
    if (!/^[A-Za-z0-9_-]{6,}$/u.test(vid)) throw providerError("vid 不合法", 400, "INVALID_VID");
    const fileName = `${vid}.mp4`;
    const result = await adapter.fetchLibraryVideo(account, vid, path.join(outputRoot, fileName));
    if (!result.ok) throw providerError(`取回失败：${result.reason}`, 502, "LIBRARY_FETCH_FAILED");
    log("library_video_fetched", { vid, bytes: result.bytes });
    return json(response, 200, {
      vid,
      url: `http://${HOST}:${server.address().port}/media/${encodeURIComponent(fileName)}`,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
    });
  }

  // 恢复动作：把豆包提交后弹出的「素材授权确认」（“确认生成”按钮）点掉
  // （新账号首次视频生成特有，不点就永远不会开始生成）。任务窗口已随
  // Provider 重启销毁时，凭 account_id/conversation_id 重开窗口导航到会话。
  // 属于写操作，仅供调试/恢复使用。
  if (request.method === "POST" && pathname === "/providers/doubao/debug/confirm-generation") {
    const body = await readBody(request).catch(() => ({}));
    const requested = String(body.account_id || "").trim();
    const account = (requested && accounts.find((item) => item.account_id === requested))
      || accounts.find((item) => item.account_id === "default")
      || accounts[0];
    return json(response, 200, await adapter.debugClickGenerationConfirm(account || null, String(body.conversation_id || "").trim()));
  }

  // 语义守卫手动测试：把任意会话文本交给 GLM 判定现场 + 核对宣布参数（只读，不消耗额度）。
  if (request.method === "POST" && pathname === "/providers/doubao/debug/semantic-check") {
    const body = await readBody(request).catch(() => ({}));
    const pageText = String(body.text || "");
    const requestedModel = String(body.requested_model || "Seedance 2.0 Fast");
    const requestedDuration = Number(body.requested_duration) || 15;
    const ownerEmail = String(body.owner_email || "").trim().toLowerCase();
    const [stateVerdict, announcementVerdict] = await Promise.all([
      classifySubmissionState({ pageText, requestedModel, requestedDuration, ownerEmail }),
      verifyGenerationAnnouncement({ text: pageText, requestedModel, requestedDuration }),
    ]);
    return json(response, 200, { stateVerdict, announcementVerdict });
  }

  match = pathname.match(/^\/media\/([^/]+)$/);
  if (request.method === "GET" && match) return serveMedia(request, response, match[1]);

  if (FAKE_MODE && request.method === "POST" && pathname === "/__test/shutdown") {
    json(response, 200, { ok: true });
    setTimeout(() => app.quit(), 20);
    return;
  }
  throw providerError("接口不存在", 404, "NOT_FOUND");
}

/**
 * 启动时用今天的历史任务重建视频额度账面。
 *
 * 为什么要重建：额度状态原来是「用完才标记」，Provider 一重启就忘光了，
 * 结果自动分配又会挑中一个今天已经用尽的账号。历史里其实有两个可用信号：
 *   1) 今天成功的视频任务 → 按它的 duration 扣减（额度按秒消耗）；
 *   2) 今天因 DOUBAO_QUOTA_EXHAUSTED 失败的任务 → 该账号当日额度已用尽。
 * 注意这只是本机账面的尽力重建：用户在网页上手动生成的消耗没有记录，账面会偏乐观，
 * 漏掉的部分由豆包返回的额度文案兜底（收到即标记用尽）。
 */
async function rebuildVideoQuotaFromHistory() {
  const today = localDayKey();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  let changed = false;
  for (const account of accounts) {
    const jobsOfDay = jobs.filter(
      (job) =>
        job.account_id === account.account_id
        && job.media_type === "video"
        && Date.parse(job.created_at || "") >= todayStartMs,
    );
    if (!jobsOfDay.length && account.video_quota_day === today) continue;
    // 先按新的一天重置，再回放今天的消耗。
    account.video_quota_day = today;
    account.video_quota_used_seconds = 0;
    account.video_quota_exhausted = false;
    for (const job of jobsOfDay) {
      if (job.status === "succeeded") {
        applyVideoQuotaUsage(account, Number(job.duration) || 5, today);
      }
      if (job.error_code === "DOUBAO_QUOTA_EXHAUSTED") {
        markVideoQuotaExhausted(account, today);
      }
    }
    changed = true;
    log("video_quota_rebuilt", {
      accountId: account.account_id,
      usedToday: account.video_quota_used_seconds,
      exhausted: account.video_quota_exhausted,
      text: videoQuotaText(videoQuotaState(account, today)),
    });
  }
  if (changed) await saveAccounts();
}

async function start() {
  await mkdir(outputRoot, { recursive: true });
  accounts = await readJson(accountsFile, []);
  if (!Array.isArray(accounts)) accounts = [];
  if (!accounts.length) {
    accounts.push({
      account_id: "default",
      display_name: "豆包账号 1（默认）",
      enabled: true,
      last_login_status: FAKE_MODE ? "logged_in" : "unknown",
      last_login_reason: FAKE_MODE ? "测试会话" : "首次使用请完成一次网页登录",
      last_used_at: null,
      updated_at: now(),
    });
    await saveAccounts();
  }
  jobs = await readJson(jobsFile, []);
  if (!Array.isArray(jobs)) jobs = [];
  let recovered = false;
  for (const job of jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.stage = "needs_reconciliation";
      job.error_message = "Provider 曾在任务中途退出；请先到豆包历史记录核对，系统不会自动重复发送";
      job.error_code = "PROVIDER_RESTARTED_DURING_JOB";
      job.updated_at = now();
      recovered = true;
    }
  }
  if (recovered) await saveJobs();
  await rebuildVideoQuotaFromHistory();
  adapter = createDoubaoAdapter({ BrowserWindow, session, onEvent: log });
  server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => sendError(response, error));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  log("provider started", { host: HOST, port: server.address().port, fake: FAKE_MODE });
}

app.on("window-all-closed", () => {
  // The loopback service owns the process; account windows may all be hidden or closed.
});
app.on("before-quit", () => {
  adapter?.dispose();
  server?.close();
});
app.whenReady().then(start).catch((error) => {
  log("provider start failed", { message: error?.message });
  app.exit(1);
});
