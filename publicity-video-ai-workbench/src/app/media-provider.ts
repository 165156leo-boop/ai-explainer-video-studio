import { readJsonWithBackup, writeJsonAtomic } from "./json-storage";
import { parseBase64DataUrl, isRecord } from "./data-shape.ts";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODEL_IDS } from "./video-prompt";
import {
  applySpeechCorrections,
  describeSpeechCorrections,
} from "./speech-correction";
import { createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chooseProviderAccount,
  normalizeMediaJob,
  normalizeProviderBaseUrl,
  normalizeVisionReview,
  providerAccountQuotaAllows,
  safeProjectSegment,
  upstreamProviderFailure,
  type MediaCandidate,
  type MediaJob,
  type MediaType,
  type ProviderAccount,
  type VisionReview,
} from "./media-workflow";

/**
 * 自动分配失败时给出可执行的说明。
 * 2026-09-16：额度是按秒算的，只说「没有可用账号」会让用户不知道为什么——
 * 现在把每个账号的剩余额度摊开说，用户一眼能看出是「都没额度」还是「有额度但装不下这镜」。
 */
function autoAssignFailureMessage(accounts: ProviderAccount[], requiredSeconds: number) {
  const loggedIn = accounts.filter((account) => account.enabled && account.loginStatus === "logged_in");
  if (!loggedIn.length) return "没有已登录的豆包账号，请先在「配置」里检查登录状态";
  const need = `本次视频需要 ${requiredSeconds} 秒额度`;
  const detail = loggedIn
    .map((account) => {
      const remaining = account.videoQuotaRemainingSeconds;
      const quota = typeof remaining === "number"
        ? `剩余 ${remaining} 秒`
        : account.videoQuotaExhausted
          ? "今日额度已用完"
          : "额度未知";
      return `${account.alias}（${quota}）`;
    })
    .join("、");
  const anyEnough = loggedIn.some((account) => providerAccountQuotaAllows(account, requiredSeconds));
  return anyEnough
    ? `账号都在忙（视频按账号串行），请稍后重试：${detail}`
    : `没有额度足够的豆包账号（${need}）：${detail}。可以换一个账号，或把这一镜拆短到剩余额度以内。`;
}

const LOCAL_ROOT = path.join(
  process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"),
  "AI科普视频制作台",
);
const CONFIG_FILE = path.join(LOCAL_ROOT, "media-provider.json");
const JOBS_FILE = path.join(LOCAL_ROOT, "media-jobs.json");
const JOBS_BACKUP_FILE = path.join(LOCAL_ROOT, "media-jobs.backup.json");
const ACCOUNT_OWNERS_FILE = path.join(LOCAL_ROOT, "media-account-owners.json");
const ACCOUNT_OWNERS_BACKUP_FILE = path.join(LOCAL_ROOT, "media-account-owners.backup.json");
const CACHE_ROOT = path.join(LOCAL_ROOT, "media-cache");
const REQUEST_ROOT = path.join(LOCAL_ROOT, "media-requests");
/** 对白同音替换审计日志：工作台与任务历史保留原文，这里留痕实际发给豆包的替换。 */
const SPEECH_CORRECTIONS_LOG = path.join(LOCAL_ROOT, "speech-corrections.log");
const DEFAULT_PROVIDER_URL = "http://127.0.0.1:8012";
const MAX_REFERENCE_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const PROVIDER_RUNTIME_ROOT = path.join(
  process.cwd(),
  "..",
  "doubao-native-provider",
);
const PROVIDER_RUNTIME_ELECTRON = path.join(
  PROVIDER_RUNTIME_ROOT,
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const PROVIDER_RUNTIME_APP = path.join(PROVIDER_RUNTIME_ROOT, "src", "main.cjs");
const runtimeProcessState = globalThis as typeof globalThis & {
  __aiVideoProviderProcess?: ChildProcess;
};

/**
 * 从完整视频提示词中提取【完整原文对白】段的原文。
 * buildVideoPromptText 的组装约定：对白是独立 section，以「【完整原文对白】」开头，
 * 到下一个空行+【分节标题之前结束（或对白后面紧跟【语音要求】等固定段）。
 * 提取不到（旧格式/手动粘贴的提示词）时返回 null，调用方不替换。
 */
const DIALOGUE_SECTION_RE = /【完整原文对白】([\s\S]*?)(?=\n\n【|$)/u;

export function extractDialogueSection(prompt: string) {
  const match = DIALOGUE_SECTION_RE.exec(prompt);
  return match ? match[1] : null;
}

/**
 * 视频任务提交前的对白读音静默纠错（2026-09-16 用户要求「后台直接改、不用显示」）：
 * 生僻字按语境拼音换成同音常用字、词级校对字典按词替换；工作台界面与任务历史
 * 仍显示原文，只有真正发给豆包的文本是替换后的版本。替换明细追加到
 * SPEECH_CORRECTIONS_LOG 供事后审计（依据火山 Seedance 指南：多音字/生僻字的
 * 官方解法就是同音替换）。只动对白段——画面/动作描述里的字被替换会改变语义。
 * 审计日志失败绝不阻塞生成任务。
 */
async function prepareVideoPromptSnapshot(
  prompt: string,
  meta: { projectId: string; targetId: string },
) {
  const dialogue = extractDialogueSection(prompt);
  if (!dialogue) return prompt;
  const result = applySpeechCorrections(dialogue);
  if (!result.corrections.length) return prompt;
  const start = prompt.indexOf(dialogue);
  const corrected =
    prompt.slice(0, start) + result.text + prompt.slice(start + dialogue.length);
  await appendFile(
    SPEECH_CORRECTIONS_LOG,
    `${JSON.stringify({
      at: new Date().toISOString(),
      projectId: meta.projectId,
      targetId: meta.targetId,
      summary: describeSpeechCorrections(result),
    })}\n`,
    "utf8",
  ).catch(() => undefined);
  return corrected;
}

type ProviderConfiguration = {
  baseUrl: string;
  configured: boolean;
  updatedAt?: string;
};

type StoredMediaCandidate = Omit<MediaCandidate, "previewUrl"> & {
  filePath?: string;
};

type StoredMediaJob = Omit<MediaJob, "candidates"> & {
  ownerEmail: string;
  candidates: StoredMediaCandidate[];
  referenceFiles: string[];
  /** 2026-09-16：视频通道把模型与时长作为显式参数提交给 Provider（不再靠提示词文本）。 */
  videoModel?: string;
  videoDurationSeconds?: number;
};

type CreateMediaJobInput = {
  ownerEmail: string;
  projectId: string;
  projectTitle: string;
  targetId: string;
  /** 对外展示的镜头编号（`S1-E1_01`，下划线）；只影响导出文件名与候选图 aria 文案。 */
  targetLabel?: string;
  mediaType: MediaType;
  accountId: string;
  prompt: string;
  referenceImages?: Array<{ dataUrl: string; fileName?: string }>;
  retryOfJobId?: string;
  videoModel?: string;
  videoDurationSeconds?: number;
};

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "MEDIA_PROVIDER_FAILED",
  ) {
    super(message);
  }
}

let writeQueue = Promise.resolve();
let accountOwnershipQueue = Promise.resolve();
const activeJobs = new Set<string>();
const accountQueues = new Map<string, Promise<void>>();
/** 连续读不到视频任务状态多少次才判定“状态不明确”；每次约 45 秒超时 + 5 秒间隔。 */
const MAX_CONSECUTIVE_STATUS_FAILURES = 8;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function previewUrl(jobId: string, candidateId: string) {
  return `/api/media?resource=file&jobId=${encodeURIComponent(jobId)}&candidateId=${encodeURIComponent(candidateId)}`;
}

function publicJob(job: StoredMediaJob): MediaJob {
  const { referenceFiles: _referenceFiles, ownerEmail: _ownerEmail, candidates, ...publicFields } = job;
  void _referenceFiles;
  void _ownerEmail;
  return {
    ...publicFields,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      fileName: candidate.fileName,
      mimeType: candidate.mimeType,
      status: candidate.status,
      error: candidate.error,
      visionReview: candidate.visionReview,
      rejectionReason: candidate.rejectionReason,
      actualDurationSeconds: candidate.actualDurationSeconds,
      previewUrl: candidate.error ? "" : previewUrl(job.id, candidate.id),
    })),
  };
}

function normalizeStoredJob(value: unknown): StoredMediaJob {
  const job = normalizeMediaJob(value);
  const rawCandidates = isRecord(value) && Array.isArray(value.candidates)
    ? value.candidates
    : [];
  return {
    ...job,
    candidates: job.candidates.map((candidate, index) => ({
      ...candidate,
      previewUrl: "",
      filePath:
        isRecord(rawCandidates[index]) && typeof rawCandidates[index].filePath === "string"
          ? rawCandidates[index].filePath
          : undefined,
    })),
    referenceFiles:
      isRecord(value) && Array.isArray(value.referenceFiles)
        ? value.referenceFiles.filter((item): item is string => typeof item === "string")
        : [],
    videoModel: isRecord(value) && typeof value.videoModel === "string" ? value.videoModel : undefined,
    videoDurationSeconds:
      isRecord(value) && typeof value.videoDurationSeconds === "number" && Number.isFinite(value.videoDurationSeconds)
        ? value.videoDurationSeconds
        : undefined,
    ownerEmail: isRecord(value) && typeof value.ownerEmail === "string"
      ? value.ownerEmail.trim().toLowerCase()
      : "",
  };
}

async function readConfiguration(): Promise<ProviderConfiguration> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Provider 配置无效");
    return {
      baseUrl: normalizeProviderBaseUrl(text(parsed.baseUrl) || DEFAULT_PROVIDER_URL),
      configured: Boolean(parsed.configured),
      updatedAt: text(parsed.updatedAt) || undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { baseUrl: DEFAULT_PROVIDER_URL, configured: false };
  }
}

export async function saveProviderConfiguration(baseUrl: string) {
  const configuration: ProviderConfiguration = {
    baseUrl: normalizeProviderBaseUrl(baseUrl),
    configured: true,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(LOCAL_ROOT, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return getProviderOverview();
}

async function providerJson(
  route: string,
  init?: RequestInit,
  timeoutMs = 15_000,
) {
  const configuration = await readConfiguration();
  const response = await fetch(new URL(route, `${configuration.baseUrl}/`), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = isRecord(data) && isRecord(data.error) ? data.error : undefined;
    const message =
      (error && text(error.message)) ||
      (isRecord(data) && text(data.detail)) ||
      `豆包 Provider 请求失败（${response.status}）`;
    const code = (error && text(error.code)) || "MEDIA_PROVIDER_FAILED";
    throw new ProviderRequestError(message, response.status, code);
  }
  return data;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function providerRuntimeStatus(configuration: ProviderConfiguration) {
  const installed =
    (await pathExists(PROVIDER_RUNTIME_ELECTRON)) &&
    (await pathExists(PROVIDER_RUNTIME_APP));
  const url = new URL(configuration.baseUrl);
  return {
    runtimeInstalled: installed,
    runtimeStartable:
      installed &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    runtimeSource: "工作台内置豆包后台",
  };
}

export async function getProviderOverview() {
  const configuration = await readConfiguration();
  const runtime = await providerRuntimeStatus(configuration);
  try {
    const health = await providerJson("/providers/doubao/health", undefined, 4_000);
    return {
      ...configuration,
      ...runtime,
      online: isRecord(health) && text(health.status) === "ok",
      provider: isRecord(health) ? text(health.provider) || "doubao" : "doubao",
    };
  } catch (error) {
    return {
      ...configuration,
      ...runtime,
      online: false,
      error: error instanceof Error ? error.message : "本机 Provider 未启动",
    };
  }
}

/**
 * Electron 只要继承 ELECTRON_RUN_AS_NODE 就会退化成普通 Node，
 * require("electron").app 变成 undefined，Provider 进程会在启动第一步崩溃。
 * 工作台自身可能是在带这个变量的终端（例如 Electron 宿主）里启动的，所以这里显式剔除。
 */
function providerChildEnvironment() {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

export async function startProviderRuntime() {
  const configuration = await readConfiguration();
  const current = await getProviderOverview();
  if (current.online) return current;
  if (!current.runtimeInstalled) {
    throw new Error("本机 Provider 运行时尚未安装");
  }
  if (!current.runtimeStartable) {
    throw new Error("内置启动只支持本机 HTTP Provider 地址");
  }

  const url = new URL(configuration.baseUrl);
  const host = url.hostname === "localhost"
    ? "127.0.0.1"
    : url.hostname.replace(/^\[|\]$/gu, "");
  const port = url.port || "8011";
  const child = spawn(
    PROVIDER_RUNTIME_ELECTRON,
    [PROVIDER_RUNTIME_ROOT],
    {
      cwd: PROVIDER_RUNTIME_ROOT,
      env: {
        ...providerChildEnvironment(),
        DOUBAO_NATIVE_HOST: host,
        DOUBAO_NATIVE_PORT: port,
      },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  runtimeProcessState.__aiVideoProviderProcess = child;
  // 没有 error 监听时，spawn 失败会变成未捕获事件；这里改成可解释的提示。
  let spawnFailure = "";
  child.once("error", (error) => {
    spawnFailure = error instanceof Error ? error.message : String(error);
  });
  let exitedEarly = false;
  child.once("exit", () => {
    exitedEarly = true;
    if (runtimeProcessState.__aiVideoProviderProcess === child) {
      delete runtimeProcessState.__aiVideoProviderProcess;
    }
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (spawnFailure) break;
    const overview = await getProviderOverview();
    if (overview.online) return overview;
  }
  if (spawnFailure) {
    throw new Error(
      `无法启动本机 Provider 进程：${spawnFailure}。请用正常 Windows 用户权限运行工作台后重试，或在 doubao-native-provider 目录手动执行 npm start。`,
    );
  }
  if (exitedEarly) {
    throw new Error(
      "本机 Provider 进程启动后立即退出，通常是权限受限或已有同名实例占用单实例锁。请在 doubao-native-provider 目录手动执行 npm start 并查看其输出。",
    );
  }
  throw new Error("Provider 启动超时，请检查本机运行环境");
}

function accountFromProvider(value: unknown): ProviderAccount {
  if (!isRecord(value)) throw new Error("Provider 账号数据无效");
  const accountId = text(value.account_id);
  const displayName = text(value.display_name);
  const rawStatus = text(value.last_login_status).toLowerCase();
  const loginStatus = rawStatus.includes("logged_in") || rawStatus === "ready" || rawStatus === "true"
    ? "logged_in"
    : rawStatus.includes("verification")
      ? "verification_required"
      : rawStatus.includes("logged_out") || rawStatus === "not_ready" || rawStatus === "false"
        ? "logged_out"
        : "unknown";
  return {
    id: accountId,
    alias:
      accountId === "default" && displayName.toLowerCase() === "primary browser cache"
        ? "豆包账号 1（默认）"
        : displayName || accountId,
    enabled: value.enabled !== false,
    loginStatus,
    loginReason: text(value.last_login_reason) || undefined,
    quotaBalance:
      typeof value.quota_balance === "number" && Number.isFinite(value.quota_balance)
        ? Math.max(value.quota_balance, 0)
        : undefined,
    quotaText: text(value.quota_balance_text) || undefined,
    videoQuotaRemainingSeconds: optionalNumber(value.video_quota_remaining_seconds),
    videoQuotaTotalSeconds: optionalNumber(value.video_quota_total_seconds),
    videoQuotaCan15s: optionalNumber(value.video_quota_can_15s),
    videoQuotaCan5s: optionalNumber(value.video_quota_can_5s),
    videoQuotaExhausted: value.video_quota_exhausted === true,
    videoQuotaText: text(value.video_quota_text) || undefined,
    videoQuotaDay: text(value.video_quota_day) || undefined,
    lastUsedAt: text(value.last_used_at) || undefined,
    updatedAt: text(value.updated_at) || undefined,
  };
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readAccountOwners() {
  return readJsonWithBackup(ACCOUNT_OWNERS_FILE, ACCOUNT_OWNERS_BACKUP_FILE, (value) => {
    if (!isRecord(value)) throw new Error("豆包账号归属数据无效");
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }, {} as Record<string, string>);
}

async function ownedAccounts(ownerEmail: string, accounts: ProviderAccount[]) {
  const operation = accountOwnershipQueue.then(async () => {
    const owners = await readAccountOwners();
    // ponytail: legacy provider accounts are claimed once by the first authenticated user;
    // replace with an admin transfer flow when accounts need cross-user sharing.
    if (!Object.keys(owners).length && accounts.length) {
      accounts.forEach((account) => { owners[account.id] = ownerEmail; });
      await writeJsonAtomic(ACCOUNT_OWNERS_FILE, owners);
    }
    return accounts.filter((account) => owners[account.id] === ownerEmail);
  });
  accountOwnershipQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function assertOwnedAccount(ownerEmail: string, accountId: string) {
  const owners = await readAccountOwners();
  if (owners[accountId] !== ownerEmail) throw new Error("无权使用该豆包账号");
}

export async function listProviderAccounts(ownerEmail: string) {
  const data = await providerJson("/providers/doubao/accounts");
  if (!isRecord(data) || !Array.isArray(data.accounts)) return [];
  return ownedAccounts(ownerEmail, data.accounts.map(accountFromProvider));
}

export async function createProviderAccount(ownerEmail: string, displayName: string, accountId?: string) {
  const name = displayName.trim().slice(0, 120);
  if (!name) throw new Error("请填写豆包账号名称");
  const data = await providerJson("/providers/doubao/accounts", {
    method: "POST",
    body: JSON.stringify({
      display_name: name,
      account_id: accountId?.trim().slice(0, 120) || undefined,
    }),
  });
  const account = accountFromProvider(data);
  const owners = await readAccountOwners();
  owners[account.id] = ownerEmail;
  await writeJsonAtomic(ACCOUNT_OWNERS_FILE, owners);
  return account;
}

function sessionResult(value: unknown) {
  if (!isRecord(value)) throw new Error("Provider 登录状态无效");
  return {
    loggedIn: Boolean(value.logged_in),
    accountId: text(value.account_id),
    reason: text(value.reason),
    pageUrl: text(value.page_url),
    quotaText: text(value.quota_balance_text) || undefined,
  };
}

export async function checkProviderAccount(ownerEmail: string, accountId: string) {
  if (!accountId.trim()) throw new Error("缺少豆包账号 ID");
  await assertOwnedAccount(ownerEmail, accountId);
  return sessionResult(
    await providerJson(
      `/providers/doubao/accounts/${encodeURIComponent(accountId)}/session/check`,
      undefined,
      120_000,
    ),
  );
}

export async function initializeProviderAccount(ownerEmail: string, accountId: string) {
  if (!accountId.trim()) throw new Error("缺少豆包账号 ID");
  await assertOwnedAccount(ownerEmail, accountId);
  return sessionResult(
    await providerJson(
      `/providers/doubao/accounts/${encodeURIComponent(accountId)}/session/init`,
      { method: "POST", body: JSON.stringify({ timeout_sec: 3600 }) },
      3_610_000,
    ),
  );
}

async function readStoredJobs() {
  return readJsonWithBackup(JOBS_FILE, JOBS_BACKUP_FILE, (parsed) => {
    if (!Array.isArray(parsed)) throw new Error("媒体任务数据结构无效");
    return parsed.map(normalizeStoredJob);
  }, []);
}

async function mutateJobs<T>(update: (jobs: StoredMediaJob[]) => T | Promise<T>) {
  let result!: T;
  const operation = writeQueue.then(async () => {
    const jobs = await readStoredJobs();
    const previous = structuredClone(jobs);
    result = await update(jobs);
    await writeJsonAtomic(JOBS_BACKUP_FILE, previous);
    await writeJsonAtomic(JOBS_FILE, jobs);
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  return result;
}

async function updateJob(
  ownerEmail: string,
  jobId: string,
  update: (job: StoredMediaJob) => StoredMediaJob,
) {
  return mutateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === jobId && job.ownerEmail === ownerEmail);
    if (index < 0) throw new Error("媒体任务不存在");
    jobs[index] = update(jobs[index]);
    return jobs[index];
  });
}

function dataUrlBuffer(dataUrl: string) {
  const parsed = parseBase64DataUrl(dataUrl);
  if (!parsed) throw new Error("参考图片必须是 Base64 Data URL");
  if (!/^image\/(?:png|jpe?g|webp)$/u.test(parsed.mimeType)) {
    throw new Error("参考图片只支持 PNG、JPG 或 WebP");
  }
  const buffer = Buffer.from(parsed.encoded, "base64");
  if (!buffer.length || buffer.length > 24 * 1024 * 1024) {
    throw new Error("参考图片为空或超过 24 MB");
  }
  return { mimeType: parsed.mimeType, buffer };
}

function extensionFromMime(mimeType: string, fallback = ".bin") {
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("webm")) return ".webm";
  return fallback;
}

async function materializeReferenceImages(
  jobId: string,
  images: CreateMediaJobInput["referenceImages"],
) {
  if (!images?.length) return [];
  if (images.length > 10) throw new Error("参考图最多 10 张");
  const directory = path.join(REQUEST_ROOT, jobId);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  let totalBytes = 0;
  try {
    for (const [index, image] of images.entries()) {
      const { mimeType, buffer } = dataUrlBuffer(image.dataUrl);
      totalBytes += buffer.length;
      if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
        throw new Error("参考图片总量不能超过 48 MB");
      }
      const filePath = path.join(directory, `reference-${index + 1}${extensionFromMime(mimeType, ".png")}`);
      await writeFile(filePath, buffer, { mode: 0o600 });
      files.push(filePath);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return files;
}

async function writeResponseBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  filePath: string,
  maxBytes = MAX_ARTIFACT_BYTES,
) {
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(new Error("Provider 返回的媒体文件过大"));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(body as import("node:stream/web").ReadableStream),
      limiter,
      createWriteStream(filePath, { mode: 0o600 }),
    );
    return totalBytes;
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 2026-09-16：读 mp4 的 moov/mvhd 拿实际时长（秒）。解析失败返回 0——
 * 只用于「实测时长与请求不符」的兜底校验，解析不出来时不阻塞正常交付。
 */
async function readMp4DurationSeconds(filePath: string): Promise<number> {
  try {
    const buffer = await readFile(filePath);
    const findBox = (
      start: number,
      end: number,
      name: string,
    ): { offset: number; size: number; header: number } | null => {
      let offset = start;
      while (offset + 8 <= end) {
        let size = buffer.readUInt32BE(offset);
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        let header = 8;
        if (size === 1) {
          if (offset + 16 > end) return null;
          size = Number(buffer.readBigUInt64BE(offset + 8));
          header = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < header || offset + size > end) return null;
        if (type === name) return { offset, size, header };
        offset += size;
      }
      return null;
    };
    const moov = findBox(0, buffer.length, "moov");
    if (!moov) return 0;
    const mvhd = findBox(moov.offset + moov.header, moov.offset + moov.size, "mvhd");
    if (!mvhd) return 0;
    const base = mvhd.offset + mvhd.header;
    if (buffer[base] === 1) {
      const timescale = buffer.readUInt32BE(base + 20);
      const duration = Number(buffer.readBigUInt64BE(base + 24));
      return timescale > 0 ? duration / timescale : 0;
    }
    const timescale = buffer.readUInt32BE(base + 12);
    const duration = buffer.readUInt32BE(base + 16);
    return timescale > 0 ? duration / timescale : 0;
  } catch {
    return 0;
  }
}

async function downloadProviderFile(
  jobId: string,
  candidateId: string,
  sourceUrl: string,
  fallbackMime: string,
) {
  const configuration = await readConfiguration();
  const source = new URL(sourceUrl);
  const configured = new URL(configuration.baseUrl);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    !loopbackHosts.has(source.hostname) ||
    source.protocol !== configured.protocol ||
    source.port !== configured.port
  ) {
    throw new Error("Provider 返回了非本机文件地址，已拒绝下载");
  }
  const response = await fetch(source, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`媒体下载失败（${response.status}）`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMime;
  const fromUrl = path.extname(source.pathname).toLowerCase();
  const extension = /^\.[a-z0-9]{2,5}$/u.test(fromUrl)
    ? fromUrl
    : extensionFromMime(mimeType);
  const directory = path.join(CACHE_ROOT, jobId);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${candidateId}${extension}`);
  await writeResponseBodyWithLimit(
    response.body as ReadableStream<Uint8Array>,
    filePath,
  );
  return { filePath, fileName: path.basename(filePath), mimeType };
}

async function downloadCandidateResult(
  job: StoredMediaJob,
  result: unknown,
  index: number,
): Promise<StoredMediaCandidate> {
  const candidateId = `${job.id}-${index + 1}`;
  if (!isRecord(result)) {
    return { id: candidateId, fileName: "", mimeType: "application/octet-stream", status: "rejected" as const, error: "Provider 返回的媒体结果无效" };
  }
  if (text(result.error)) {
    return { id: candidateId, fileName: "", mimeType: "application/octet-stream", status: "rejected" as const, error: text(result.error) };
  }
  if (text(result.url)) {
    const downloaded = await downloadProviderFile(
      job.id,
      candidateId,
      text(result.url),
      job.mediaType === "image" ? "image/png" : "video/mp4",
    );
    // 2026-09-16：视频兜底校验——实测时长与请求差 20% 以上视为豆包静默降档
    // （实证：新账号授权确认分支改用 Mini 只出 10 秒片），自动拒收，
    // 不再以 pending 混进候选列表让用户看到"能播但不对"的片子。
    if (job.mediaType === "video" && downloaded.filePath.toLowerCase().endsWith(".mp4")) {
      const actualDurationSeconds = await readMp4DurationSeconds(downloaded.filePath);
      const requestedSeconds = Number(job.videoDurationSeconds) || 0;
      if (
        actualDurationSeconds > 0 &&
        requestedSeconds > 0 &&
        Math.abs(actualDurationSeconds - requestedSeconds) / requestedSeconds > 0.2
      ) {
        return {
          id: candidateId,
          status: "rejected" as const,
          filePath: downloaded.filePath,
          fileName: downloaded.fileName,
          mimeType: downloaded.mimeType,
          actualDurationSeconds: Math.round(actualDurationSeconds * 10) / 10,
          error: `成片实测 ${actualDurationSeconds.toFixed(1)} 秒，与请求的 ${requestedSeconds} 秒不符（豆包疑似丢失参数后降档生成），已自动拒收；请重新提交这一镜`,
        };
      }
      if (actualDurationSeconds > 0) {
        return {
          id: candidateId,
          status: "pending" as const,
          filePath: downloaded.filePath,
          fileName: downloaded.fileName,
          mimeType: downloaded.mimeType,
          actualDurationSeconds: Math.round(actualDurationSeconds * 10) / 10,
        };
      }
    }
    return {
      id: candidateId,
      status: "pending" as const,
      ...downloaded,
    };
  }
  const encoded = text(result.b64_json);
  if (!encoded) {
    return { id: candidateId, fileName: "", mimeType: "application/octet-stream", status: "rejected" as const, error: "Provider 没有返回媒体文件" };
  }
  if (encoded.length > Math.ceil(MAX_ARTIFACT_BYTES / 3 * 4)) {
    throw new Error("Provider 返回的 Base64 媒体文件过大");
  }
  const mimeType = job.mediaType === "image" ? "image/png" : "video/mp4";
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error("Provider 返回的媒体文件过大或为空");
  }
  const directory = path.join(CACHE_ROOT, job.id);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${candidateId}${extensionFromMime(mimeType)}`);
  await writeFile(filePath, buffer, { mode: 0o600 });
  return { id: candidateId, filePath, fileName: path.basename(filePath), mimeType, status: "pending" as const };
}

async function candidateFromResult(job: StoredMediaJob, result: unknown, index: number): Promise<StoredMediaCandidate> {
  try {
    return await downloadCandidateResult(job, result, index);
  } catch (error) {
    return {
      id: `${job.id}-${index + 1}`,
      fileName: "",
      mimeType: "application/octet-stream",
      status: "rejected",
      error: error instanceof Error ? error.message : "候选下载失败",
    };
  }
}

function providerFailure(error: unknown) {
  const waiting = error instanceof ProviderRequestError && error.status === 401;
  const rawMessage = error instanceof Error ? error.message : "媒体任务失败";
  const errorMessage = /Could not switch Doubao into image-generation mode/iu.test(rawMessage)
    ? "豆包图片生成页没有进入可用状态。系统已改为直接进入图片生成页；请先在配置中检查登录，若豆包要求验证，只需在弹出的登录窗口完成一次验证。"
    : /Could not switch Doubao into video-generation mode/iu.test(rawMessage)
      ? "豆包视频生成页没有进入可用状态。请先在配置中检查登录，若豆包要求验证，只需在弹出的登录窗口完成一次验证。"
      : rawMessage;
  return {
    status: waiting ? ("waiting_user" as const) : ("failed" as const),
    errorCode: error instanceof ProviderRequestError ? error.code : "MEDIA_JOB_FAILED",
    errorMessage,
    finishedAt: waiting ? undefined : new Date().toISOString(),
  };
}

async function runImageJob(job: StoredMediaJob) {
  let response: unknown;
  try {
    response = await providerJson(
      "/providers/doubao/v1/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          account_id: job.accountId,
          model: "seedream-4.5",
          prompt: job.promptSnapshot,
          aspect_ratio: "16:9",
          doubao_url: "https://www.doubao.com/chat/create-image",
          headless: false,
          n: 1,
          response_format: "url",
          reference_images: job.referenceFiles.map((filePath) => ({ file_path: filePath })),
          user: `${job.projectId}/${job.targetId}`,
        }),
      },
      30 * 60_000,
    );
  } catch (error) {
    // 生图请求是长连接，连接中断时豆包可能已经在出图，必须按“状态不明确”处理。
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      "生图请求与本地 Provider 的连接中断，任务是否已在豆包生成尚不确定；请先到豆包历史记录核对，再决定是否重新生成",
      504,
      "PROVIDER_STATUS_UNREACHABLE",
    );
  }
  const results = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  const candidates = await Promise.all(
    results.map((result, index) => candidateFromResult(job, result, index)),
  );
  const successful = candidates.filter((candidate) => candidate.filePath);
  if (!successful.length) {
    throw new Error(candidates[0]?.error || "豆包没有返回可用候选图");
  }
  await updateJob(job.ownerEmail, job.id, (current) => ({
    ...current,
    status: "succeeded",
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    providerMessage: isRecord(response)
      ? text(response.completion_text) || text(response.acknowledgement_text) || undefined
      : undefined,
    quotaText: isRecord(response) ? text(response.quota_balance_text) || undefined : undefined,
    candidates,
  }));
}

async function submitVideoJob(job: StoredMediaJob) {
  try {
    return await providerJson(
      "/providers/doubao/video-jobs",
      {
        method: "POST",
        body: JSON.stringify({
          account_id: job.accountId,
          owner_email: job.ownerEmail,
          model: job.videoModel || DEFAULT_VIDEO_MODEL,
          prompt: job.promptSnapshot,
          doubao_url: "https://www.doubao.com/chat/create-video",
          headless: false,
          n: 1,
          response_format: "url",
          timeout_sec: 3600,
          ...(job.videoDurationSeconds ? { duration: String(job.videoDurationSeconds) } : {}),
          reference_images: job.referenceFiles.map((filePath) => ({ file_path: filePath })),
          user: `${job.projectId}/${job.targetId}`,
        }),
      },
      60_000,
    );
  } catch (error) {
    // Provider 已经回话（登录失效、参数错误等）时按原样冒泡；只有连接中断才是未知状态。
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      "提交视频任务时与本地 Provider 的连接中断，任务是否已在豆包生成尚不确定；请先到豆包历史记录核对，再决定是否重新生成",
      504,
      "PROVIDER_STATUS_UNREACHABLE",
    );
  }
}

async function runVideoJob(job: StoredMediaJob) {
  const created = await submitVideoJob(job);
  if (!isRecord(created) || !text(created.job_id)) {
    throw new ProviderRequestError(
      "本地 Provider 没有返回视频任务 ID，任务是否已在豆包生成尚不确定；请先到豆包历史记录核对，再决定是否重新生成",
      504,
      "PROVIDER_STATUS_UNREACHABLE",
    );
  }
  const upstreamJobId = text(created.job_id);
  await updateJob(job.ownerEmail, job.id, (current) => ({
    ...current,
    upstreamJobId,
    updatedAt: new Date().toISOString(),
  }));

  const deadline = Date.now() + 2 * 60 * 60_000;
  let consecutiveStatusFailures = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    let status: unknown = null;
    let transportFailed = false;
    try {
      status = await providerJson(
        `/providers/doubao/video-jobs/${encodeURIComponent(upstreamJobId)}`,
        undefined,
        45_000,
      );
    } catch (error) {
      // Provider 主动返回的错误（登录失效、上游任务失败）按原样处理；
      // 只有读不到响应才可能是本机休眠、Provider 卡顿等临时中断。
      if (error instanceof ProviderRequestError) throw error;
      transportFailed = true;
    }
    if (transportFailed || !isRecord(status)) {
      consecutiveStatusFailures += 1;
      const givingUp =
        consecutiveStatusFailures >= MAX_CONSECUTIVE_STATUS_FAILURES;
      await updateJob(job.ownerEmail, job.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        providerMessage: givingUp
          ? current.providerMessage
          : `本地 Provider 暂时读不到任务状态，正在重试（第 ${consecutiveStatusFailures} 次）；豆包任务本身未受影响`,
      }));
      if (!givingUp) continue;
      throw new ProviderRequestError(
        "本地 Provider 连续无法返回视频任务状态，任务是否已在豆包生成尚不确定；请先到豆包历史记录核对，再决定是否重新生成",
        504,
        "PROVIDER_STATUS_UNREACHABLE",
      );
    }
    consecutiveStatusFailures = 0;
    await updateJob(job.ownerEmail, job.id, (current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      providerMessage:
        text(status.completion_text) ||
        text(status.acknowledgement_text) ||
        text(status.estimated_wait_text) ||
        current.providerMessage,
      quotaText: text(status.quota_balance_text) || current.quotaText,
    }));
    if (text(status.status) === "failed") {
      const failure = upstreamProviderFailure(status, "豆包视频生成失败");
      throw new ProviderRequestError(
        failure.message,
        failure.status,
        failure.code,
      );
    }
    if (text(status.status) !== "succeeded") continue;
    const results = Array.isArray(status.data) ? status.data : [];
    const current = await getStoredJob(job.ownerEmail, job.id);
    const candidates = await Promise.all(
      results.map((result, index) => candidateFromResult(current, result, index)),
    );
    if (!candidates.some((candidate) => candidate.filePath)) {
      throw new Error(candidates[0]?.error || "豆包没有返回可用视频");
    }
    await updateJob(job.ownerEmail, job.id, (latest) => ({
      ...latest,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      candidates,
    }));
    return;
  }
  throw new Error("视频任务超过 2 小时仍未完成，请到豆包历史记录中核对后再决定是否重试");
}

async function getStoredJob(ownerEmail: string, jobId: string) {
  await writeQueue;
  const job = (await readStoredJobs()).find((item) => item.id === jobId && item.ownerEmail === ownerEmail);
  if (!job) throw new Error("媒体任务不存在");
  return job;
}

function scheduleJob(job: StoredMediaJob) {
  activeJobs.add(job.id);
  const run = async () => {
    const latest = await getStoredJob(job.ownerEmail, job.id);
    if (latest.status === "cancelled") return;
    await updateJob(job.ownerEmail, job.id, (value) => ({
      ...value,
      status: "running",
      startedAt: value.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    try {
      if (latest.mediaType === "image") await runImageJob(latest);
      else await runVideoJob(latest);
    } catch (error) {
      await updateJob(job.ownerEmail, job.id, (value) => ({
        ...value,
        ...providerFailure(error),
        updatedAt: new Date().toISOString(),
      }));
    }
  };
  const pending = job.mediaType === "video"
    ? (accountQueues.get(job.accountId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(run)
    : run();
  const current = pending
    .finally(() => {
      activeJobs.delete(job.id);
      if (
        job.mediaType === "video" &&
        accountQueues.get(job.accountId) === current
      ) accountQueues.delete(job.accountId);
    });
  if (job.mediaType === "video") accountQueues.set(job.accountId, current);
  void current.catch(() => undefined);
}

export async function createMediaJob(input: CreateMediaJobInput) {
  const projectId = input.projectId.trim().slice(0, 160);
  const projectTitle = input.projectTitle.trim().slice(0, 160);
  const targetId = input.targetId.trim().slice(0, 160);
  /** 展示编号只是标签，跟着镜头数据走；它变了不需要让旧任务失效。 */
  const targetLabel = input.targetLabel?.trim().slice(0, 160) || undefined;
  const requestedAccountId = input.accountId.trim().slice(0, 120);
  const rawPrompt = input.prompt.trim();
  // 视频任务：对白段在提交前静默做同音字替换（界面仍显示原文）。
  const promptSnapshot = (
    input.mediaType === "video"
      ? await prepareVideoPromptSnapshot(rawPrompt, { projectId, targetId })
      : rawPrompt
  ).slice(0, 8000);
  if (!projectId || !projectTitle || !targetId || !requestedAccountId || !promptSnapshot) {
    throw new Error("媒体任务缺少项目、镜头、账号或提示词");
  }
  safeProjectSegment(projectTitle);
  if (!["image", "video"].includes(input.mediaType)) throw new Error("媒体任务类型无效");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  /** 2026-09-16：视频按秒吃豆包当日免费额度，自动分配要按「这镜需要多少秒」挑账号。 */
  const requiredQuotaSeconds =
    input.mediaType === "video" && typeof input.videoDurationSeconds === "number"
      ? Math.min(Math.max(Math.round(input.videoDurationSeconds), 4), 15)
      : 0;
  const autoAccounts = requestedAccountId === "auto"
    ? await listProviderAccounts(input.ownerEmail)
    : [];
  if (requestedAccountId !== "auto") await assertOwnedAccount(input.ownerEmail, requestedAccountId);
  if (
    requestedAccountId === "auto" &&
    !chooseProviderAccount(autoAccounts, [], requiredQuotaSeconds)
  ) {
    throw new Error(autoAssignFailureMessage(autoAccounts, requiredQuotaSeconds));
  }
  const referenceFiles = await materializeReferenceImages(id, input.referenceImages);
  try {
    const job = await mutateJobs((jobs) => {
      const accountId = requestedAccountId === "auto"
        ? chooseProviderAccount(autoAccounts, jobs, requiredQuotaSeconds)?.id
        : requestedAccountId;
      if (!accountId) {
        throw new Error(autoAssignFailureMessage(autoAccounts, requiredQuotaSeconds));
      }
      const nextJob: StoredMediaJob = {
        id,
        ownerEmail: input.ownerEmail,
        projectId,
        projectTitle,
        targetId,
        targetLabel,
        mediaType: input.mediaType,
        accountId,
        promptSnapshot,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        retryOfJobId: input.retryOfJobId?.trim() || undefined,
        candidates: [],
        referenceFiles,
        videoModel: input.mediaType === "video" && input.videoModel
          ? VIDEO_MODEL_IDS.find((item) => item === input.videoModel)
          : undefined,
        videoDurationSeconds:
          input.mediaType === "video" && typeof input.videoDurationSeconds === "number"
            ? Math.min(Math.max(Math.round(input.videoDurationSeconds), 4), 15)
            : undefined,
      };
      jobs.unshift(nextJob);
      return nextJob;
    });
    scheduleJob(job);
    return publicJob(job);
  } catch (error) {
    await rm(path.join(REQUEST_ROOT, id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function maintainMediaJobs(ownerEmail: string) {
  await writeQueue;
  const stored = await readStoredJobs();
  const needsOwnerMigration = stored.some((job) => !job.ownerEmail);
  const needsStaleRepair = stored.some(
    (job) => ["queued", "running"].includes(job.status) && !activeJobs.has(job.id),
  );
  if (!needsOwnerMigration && !needsStaleRepair) return false;

  return mutateJobs((jobs) => {
    const now = new Date().toISOString();
    let changed = false;
    jobs.forEach((job, index) => {
      if (!job.ownerEmail) {
        job.ownerEmail = ownerEmail;
        changed = true;
      }
      if (!["queued", "running"].includes(job.status) || activeJobs.has(job.id)) return;
      jobs[index] = {
        ...job,
        status: "failed",
        errorCode: "LOCAL_PROVIDER_RESTARTED",
        errorMessage: "本地服务重启前任务未完成。请先到豆包历史记录核对，避免重复生成。",
        updatedAt: now,
        finishedAt: now,
      };
      changed = true;
    });
    return changed;
  });
}

export async function listMediaJobs(ownerEmail: string, projectId: string) {
  await writeQueue;
  return (await readStoredJobs())
    .filter((job) => job.ownerEmail === ownerEmail && (!projectId || job.projectId === projectId))
    .map(publicJob);
}

export async function saveCandidateReview(
  ownerEmail: string,
  jobId: string,
  candidateId: string,
  review: VisionReview,
) {
  const normalized = normalizeVisionReview(review);
  return publicJob(
    await updateJob(ownerEmail, jobId, (job) => ({
      ...job,
      updatedAt: new Date().toISOString(),
      candidates: job.candidates.map((candidate) =>
        candidate.id === candidateId
          ? { ...candidate, visionReview: normalized }
          : candidate,
      ),
    })),
  );
}

export async function rejectCandidate(
  ownerEmail: string,
  jobId: string,
  candidateId: string,
  rejectionReason = "",
) {
  const reason = rejectionReason.trim().slice(0, 400);
  return publicJob(
    await updateJob(ownerEmail, jobId, (job) => {
      if (!job.candidates.some((candidate) => candidate.id === candidateId)) {
        throw new Error("候选媒体不存在");
      }
      return {
        ...job,
        updatedAt: new Date().toISOString(),
        candidates: job.candidates.map((candidate) =>
          candidate.id === candidateId
            ? { ...candidate, status: "rejected" as const, rejectionReason: reason || undefined }
            : candidate,
        ),
      };
    }),
  );
}

export async function adoptCandidate(
  ownerEmail: string,
  jobId: string,
  candidateId: string,
) {
  const job = await getStoredJob(ownerEmail, jobId);
  const candidate = job.candidates.find((item) => item.id === candidateId);
  if (!candidate?.filePath) throw new Error("候选媒体文件不存在");
  const projectRoot = path.resolve(process.cwd(), "..", "AI视频agent", "项目");
  const projectDirectory = path.resolve(projectRoot, safeProjectSegment(job.projectTitle));
  if (!projectDirectory.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("项目素材目录无效");
  }
  const sourceExtension = path.extname(candidate.filePath) || extensionFromMime(candidate.mimeType);
  // 2026-10-08 用户拍板：导出文件名跟着对外展示的镜头编号走（`S1-E1_01`，下划线），
  // 不再用内部键 `targetId`。旧任务没有 `targetLabel`，回退 `targetId` 保证不崩
  // （`safeProjectSegment` 不动下划线，所以新编号能原样进文件名）。
  const stem = `${safeProjectSegment(job.targetLabel ?? job.targetId)}-${candidate.id.slice(-8)}`;
  const folder = job.mediaType === "image" ? "03_豆包原始下载图片" : "06_豆包原始下载视频";
  const outputDirectory = path.join(projectDirectory, folder);
  await mkdir(outputDirectory, { recursive: true });
  const originalPath = path.join(outputDirectory, `${stem}${sourceExtension}`);
  await copyFile(candidate.filePath, originalPath);

  if (job.mediaType === "image") {
    await writeFile(
      `${originalPath}.ai.json`,
      `${JSON.stringify(
        {
          jobId: job.id,
          candidateId,
          accountId: job.accountId,
          targetId: job.targetId,
          promptSnapshot: job.promptSnapshot,
          originalFile: path.basename(originalPath),
          adoptedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const updated = await mutateJobs((jobs) => {
    const now = new Date().toISOString();
    let selected: StoredMediaJob | undefined;
    jobs.forEach((current, index) => {
      if (
        current.ownerEmail !== ownerEmail ||
        current.projectId !== job.projectId ||
        current.targetId !== job.targetId ||
        current.mediaType !== job.mediaType
      ) return;
      const next = {
        ...current,
        updatedAt: now,
        candidates: current.candidates.map((item) => ({
          ...item,
          status:
            item.id === candidateId
              ? ("adopted" as const)
              : item.status === "adopted"
                ? ("kept" as const)
                : item.status,
        })),
      };
      jobs[index] = next;
      if (current.id === jobId) selected = next;
    });
    if (!selected) throw new Error("媒体任务不存在");
    return selected;
  });
  return {
    job: publicJob(updated),
    originalFileName: path.basename(originalPath),
  };
}

function fileReadStream(filePath: string): ReadableStream<Uint8Array> {
  const source = createReadStream(filePath);
  let settled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: string | Buffer) => {
        if (!settled) controller.enqueue(new Uint8Array(Buffer.from(chunk)));
      });
      source.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      source.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        controller.error(error);
      });
    },
    cancel() {
      settled = true;
      source.destroy();
    },
  });
}

export async function getCandidateFile(ownerEmail: string, jobId: string, candidateId: string) {
  const job = await getStoredJob(ownerEmail, jobId);
  const candidate = job.candidates.find((item) => item.id === candidateId);
  if (!candidate?.filePath) throw new Error("候选媒体文件不存在");
  const cacheRoot = path.resolve(CACHE_ROOT);
  const filePath = path.resolve(candidate.filePath);
  if (!filePath.startsWith(`${cacheRoot}${path.sep}`)) throw new Error("候选媒体路径无效");
  const details = await stat(filePath);
  return {
    stream: fileReadStream(filePath),
    size: details.size,
    fileName: candidate.fileName,
    mimeType: candidate.mimeType,
  };
}
