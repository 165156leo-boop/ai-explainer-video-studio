"use client";

import Image from "next/image";
import { resolveContinuityReference, resolveVideoPromptSources, type VideoPromptSources } from "./video-prompt-input";
import { PolishLane } from "./polish-lane";
import { applyShotEdit, imagePromptInputSignature, rebuildStoryboard, reconcileImagePrompts, reconcileStoryboardDependencies } from "./storyboard-workflow";
import {
  AutoPolishBatch,
  needsVideoPromptRepolish,
  videoPromptSourceSignature,
  videoPromptInputSignature,
  type AutoPolishOutcome,
} from "./polish-digest";
import { PolishState, type PolishKind, type PolishResult } from "./polish-state";
import { AI_PROVIDER_PRESETS, useModelConnection } from "./use-model-connection";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Combine,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Film,
  FolderKanban,
  GripVertical,
  History,
  ImageIcon,
  KeyRound,
  Layers3,
  LibraryBig,
  MapPin,
  MessageSquareText,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Sparkles,
  Scissors,
  ShieldCheck,
  UploadCloud,
  UserPlus,
  UserRound,
  Wand2,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  extractedCases,
  imagePromptPackages,
  promptText,
  scriptParagraphs,
  shots,
  stages,
  type ExtractedCase,
  type ExtractedCaseItem,
  type ImagePromptPackage,
  type ScriptParagraph,
  type Shot,
  type StageKey,
} from "./workbench-data";
import {
  buildCaseShots,
  buildImagePrompts,
  buildShotsFromCases,
  continuityVisualActions,
  estimateSpeechSeconds,
  findContinuityReferenceShot,
  hydrateLegacyShotSources,
  MAX_SHOT_SECONDS,
  normalizeSpeechRate,
  recalculateShotTiming,
  recalculateShotTimings,
  reorderActions,
  SPEECH_UNITS_PER_SECOND,
  speechRateLabel,
  splitOptionsForShot,
  summarizeShot,
  splitShotItems,
} from "./shot-planning";
import {
  ACTIVE_PROJECT_KEY,
  PROJECT_SCHEMA_VERSION,
  createProjectId,
  getProject,
  listProjects,
  loadWorkspace,
  mergeWorkspaceBackup,
  migrateLegacyProjects,
  needsStoryboardRebuild,
  normalizeProjectSnapshot,
  normalizeWorkspaceSnapshot,
  saveProject,
  summarizeProjects,
  saveReferenceAsset,
  saveReuseRule,
  setActiveProject,
  undoReuseRule,
  STORYBOARD_RULE_VERSION,
  STORYBOARD_RULE_VERSION_KEY,
  type AcceptanceRun,
  recordRuleDecision,
  type FeedbackDecision,
  type ProjectHistoryEntry,
  type ProjectSnapshot,
  type ProjectSummary,
  type ScriptReviewIssue,
  type ScriptReviewReport,
} from "./project-store";
import type { ExtractionReviewResult } from "./extraction-review";
import {
  type ScriptAuditDropped,
  type ScriptAuditItem,
  type ScriptAuditKind,
  type ScriptAuditResult,
  SCRIPT_AUDIT_KIND_LABELS,
  scriptAuditCounts,
  scriptAuditDropped,
  scriptAuditCountsLabel,
  scriptAuditFromReview,
  scriptAuditReview,
} from "./script-audit";
import { cleanImagePromptAction, type ImagePromptBrief } from "./image-prompt";
import {
  AI_INPUT_REJECTED_CODE,
  isDeterministicRejectionCode,
} from "./ai-output-rejection";
import {
  buildCharacterIdentityNote,
  classifyCharacterIdentity,
  type CharacterIdentityResult,
} from "./character-identity";
import {
  buildReferenceImageNote,
  DEFAULT_VIDEO_MODEL,
  parseDialogueSpeakers,
  videoDurationBucket,
  videoScriptWarnings,
  type VideoReferenceImageRole,
} from "./video-prompt";
import {
  canUseVideoPromptForShot,
  candidateMatchesSelectedImage,
  inheritShotAssets,
  makeShotConfirmedSnapshot,
  needsProviderHistoryCheck,
  providerAccountQuotaAllows,
  referenceImageStale,
  shotBriefLabel,
  shotCaseId,
  shotConfirmedChanges,
  shotDisplayLabel,
  shotDisplayNumber,
  shotVisualSignature,
  tailFrameEnhancementInstruction,
} from "./media-workflow";
import type {
  MediaCandidate,
  MediaJob,
  ProviderAccount,
  VisionReview,
} from "./media-workflow";
import {
  appendRulesToPrompt,
  cleanImagePromptForProvider,
  findDuplicateRule,
  inferAssetTags,
  matchReuseRules,
  matchingKeywords,
  parseCharacterBindingInstruction,
  type AiRuleCandidate,
  type ReferenceAsset,
  type ReuseRule,
} from "./workspace-memory";

const SHOT_DRAFTS_KEY = "publicity-video-ai-workbench:shot-drafts";
const CASE_DRAFTS_KEY = "publicity-video-ai-workbench:case-drafts";
const IMAGE_PROMPT_DRAFTS_KEY =
  "publicity-video-ai-workbench:image-prompt-drafts";
const SCRIPT_DRAFTS_KEY = "publicity-video-ai-workbench:script-drafts";
const SOURCE_FILE_KEY = "publicity-video-ai-workbench:source-file";
const WORKFLOW_STAGE_KEY = "publicity-video-ai-workbench:workflow-stage";
const SCRIPT_REVIEW_KEY = "publicity-video-ai-workbench:script-review";
const EXTRACTION_ENGINE_KEY = "publicity-video-ai-workbench:extraction-engine";
const PROJECT_NAME_KEY = "publicity-video-ai-workbench:project-name";
// 分镜规则版本与它的 localStorage 键都搬到了 `project-store.ts`：升级它会让存量项目
// 在加载时重建一次分镜，是一条数据决策，需要被单测直接覆盖（见 `needsStoryboardRebuild`）。
const AUTO_PROVIDER_ACCOUNT_ID = "auto";
const MEDIA_ACCOUNT_KEY = "publicity-video-ai-workbench:media-account-v2";
const IMAGE_RETRY_FEEDBACK_TYPE = "候选图退回意见";
const LEGACY_IMAGE_RETRY_FEEDBACK = "用于下一次图片生成";

type ProviderOverview = {
  baseUrl: string;
  configured: boolean;
  online: boolean;
  provider?: string;
  error?: string;
  runtimeInstalled?: boolean;
  runtimeStartable?: boolean;
  runtimeSource?: string;
};

type PendingMediaRejection = {
  jobId: string;
  candidateId: string;
};

type MediaFeedbackProgress = {
  candidateId: string;
  state: "processing" | "success" | "error";
  title: string;
  detail: string;
  historyId?: string;
};

type ImageRetryResult = {
  prompt: string;
  review: VisionReview;
  visionModel: string;
  textModel: string;
};

type ImageRetryCandidateInput = {
  job: MediaJob;
  candidate: MediaCandidate;
  feedback: string;
};

function mediaFeedbackSource(jobId: string, candidateId: string) {
  return `媒体任务 ${jobId} · 候选 ${candidateId}`;
}

function parseMediaFeedbackSource(source = "") {
  const match = source.match(/^媒体任务 (.+) · 候选 (.+)$/u);
  return match ? { jobId: match[1], candidateId: match[2] } : undefined;
}

function candidateFeedbackReason(
  history: ProjectHistoryEntry[],
  jobId: string,
  candidateId: string,
) {
  return history.find(
    (entry) => entry.before === mediaFeedbackSource(jobId, candidateId),
  )?.reason;
}

/**
 * 2026-09-17：带上服务端返回的错误码，供调用方区分两类失败——
 *  - `AI_OUTPUT_REJECTED` / `AI_INPUT_REJECTED`：确定性失败。前者是模型违反内容硬规则
 *    （把台词改了、括号里加引号、混内部术语），后者是我们**自己发上去的素材**不符合最低契约
 *    （如某镜没有可用的场景或动作）。两者重发同样输入都必然同样失败，**不该自动重试**；
 *  - 其它（超时/上游 5xx/网络断开/模型过载）：瞬时失败，**值得按节奏重试**。
 */
class AiRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AiRequestError";
    this.code = code;
  }
}

async function responseData<T>(response: Response) {
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new AiRequestError(
      data.error || `请求失败（${response.status}）`,
      typeof data.code === "string" ? data.code : "",
    );
  }
  return data;
}

/**
 * 润色请求的前端兜底超时（2026-09-17 修复「一直显示后台润色中」）。
 * 服务端对上游模型有 90s 限制（超时会返回 400 并解除润色状态），但如果浏览器与
 * Next 服务之间的连接半开（休眠恢复、服务重启、代理异常），前端 fetch 会永远
 * pending——润色是串行队列，队头挂死会让后面所有润色全部堵住，界面永远「润色中」。
 * 这里 100s（略长于服务端 90s，保证先收到服务端结果而非抢跑）强制给出结果。
 */
const AI_POLISH_CLIENT_TIMEOUT_MS = 100_000;

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutLabel: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(AI_POLISH_CLIENT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new Error(
        `${timeoutLabel}超时（100 秒未返回），模型可能过载；稍后会自动重试，当前可直接用模板提交`,
      );
    }
    throw error;
  }
}

/**
 * 2026-09-17（用户拍板）润色失败后的自驱动重试节奏：先等 10 秒、再等 30 秒。
 * 首次失败算第 1 次，两次重试仍失败即停止，把控制权交回用户，
 * 不再像旧实现那样让按钮永久停在不可用状态。
 */
const POLISH_RETRY_DELAYS_MS = [10_000, 30_000] as const;

/**
 * 右下角通知（2026-10-08）。`detail` 非空时渲染成可展开的明细——后台自动润色一次会
 * 跑好几镜，只看一行摘要说不清「他改动了哪些」，展开逐镜可查。
 */
type ToastMessage = {
  text: string;
  detail?: string[];
  tone?: "ok" | "warn";
};

/** 兜底计时器的时长：超过它就不再等挂死的请求，把已收齐的结果先汇报出来。 */
const AUTO_POLISH_DIGEST_TIMEOUT_MS = 180_000;

function mediaJobStatusLabel(status: MediaJob["status"]) {
  return {
    queued: "排队中",
    running: "生成中",
    waiting_user: "等待登录",
    succeeded: "已返回",
    failed: "失败",
    cancelled: "已取消",
  }[status];
}

function accountStatusLabel(status: ProviderAccount["loginStatus"]) {
  return {
    unknown: "待检查",
    logged_in: "已登录",
    logged_out: "未登录",
    verification_required: "需要验证",
  }[status];
}

/**
 * 账号下拉里显示的视频额度文案。
 * 2026-09-16：额度按秒发放（每天约 50 秒 = 10 个 5 秒单位），
 * 所以显示「剩余多少秒 + 还能做几条 5/15 秒」比只显示「可用/不可用」有用得多。
 */
function accountQuotaLabel(account: ProviderAccount) {
  const remaining = account.videoQuotaRemainingSeconds;
  if (typeof remaining !== "number") {
    return account.videoQuotaExhausted ? "今日额度已用完" : "额度待检查";
  }
  if (remaining <= 0) return "今日额度已用完";
  return `剩余 ${remaining} 秒（约 ${account.videoQuotaCan15s ?? Math.floor(remaining / 15)} 条 15 秒 / ${
    account.videoQuotaCan5s ?? Math.floor(remaining / 5)
  } 条 5 秒）`;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("候选文件读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function referenceSourceToDataUrl(source: string) {
  if (source.startsWith("data:")) return source;
  const response = await fetch(source, { cache: "force-cache" });
  if (!response.ok) throw new Error("固定参考图读取失败");
  return blobToDataUrl(await response.blob());
}

/**
 * 2026-09-17 尾帧链（用户拍板）：从候选视频抽取结尾画面——定位到时长前 0.12 秒，
 * canvas 绘制为无损 PNG dataURL，避免本地再次压缩；任何一步失败都返回 undefined，
 * 不阻塞视频验收。后续可用豆包把它高清重绘后再接下一镜。
 */
async function extractVideoLastFrame(file: File) {
  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("视频加载失败"));
    });
    const duration =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error("视频结尾定位失败"));
      video.currentTime = Math.max(duration - 0.12, 0);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画布上下文不可用");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = canvas.toDataURL("image/png");
    return frame.startsWith("data:image") ? frame : undefined;
  } catch {
    return undefined;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

const SPEECH_RATE_PRESETS = [
  { value: 4.8, label: "舒缓", note: "讲解、强调与复杂信息" },
  { value: 5.5, label: "标准", note: "全局基线（2026-09-24 校准）" },
  { value: 7.2, label: "紧凑", note: "短句与节奏较快的段落" },
] as const;

function issuesFromFlags(flags: string[]): ScriptReviewIssue[] {
  return flags.map((message) => {
    const match = /^(S\d+-E\d+)\s+第(\d+)段/u.exec(message);
    const speaker = /说话人“([^”]+)”需要复核/u.exec(message)?.[1];
    return {
      message,
      caseId: match?.[1],
      sourceId: match ? Number(match[2]) : undefined,
      reason: speaker
        ? `说话人只写成“${speaker}”，无法确定这个字母对应的真实角色身份。`
        : "这一段的结构或角色归属无法由规则稳定判断。",
      question: speaker
        ? `请确认“${speaker}”具体是谁，以及这句台词是否确实由该角色说出。`
        : "请确认这段是否属于当前最小案例，以及是否需要进入后续分镜。",
      action: speaker
        ? `把“${speaker}”改成完整角色名，并保持相邻对白中的称呼一致。`
        : "确认后修改原文中的角色名或内容归属，再重新执行脚本审查。",
    };
  });
}

function publicEngineLabel(value: string) {
  return value
    .replace(/Codex 既有提取器/gu, "脚本结构提取器")
    .replace(/原 Codex 提取器/gu, "脚本结构提取器");
}

/**
 * 补齐展示编号（2026-10-07，Layer 1）。
 *
 * `shotNumber` 是**纯展示**的镜号，按分镜在本案例内的先后顺序给。它必须和
 * `shot.id` 分开：`id` 是画面词与媒体任务的主键，插入一镜后编号会留下缺口
 * （见 `inheritShotAssets`），直接拿它当镜号显示就会出现「01、02、04」。
 * 存量项目没有这个字段，加载时补一次。
 *
 * 顺序算法统一在 `media-workflow.ts` 的 `shotDisplayNumber`，这里只负责落盘到字段；
 * 页面上的展示标签用 `shotDisplayLabel`，两者同源，不会出现「卡片写 01、标题另写一个」。
 */
function withShotNumbers(items: Shot[]): Shot[] {
  return items.map((shot) => {
    const number = shotDisplayNumber(items, shot.id) ?? 1;
    return shot.shotNumber === number ? shot : { ...shot, shotNumber: number };
  });
}

/**
 * 早期的单镜润色看不到完整分镜列表，会把继承尾帧的镜头误当成独立开场，
 * 因而在已经有上一镜画面基准时仍重复整段风格说明和动作过程。
 * 只失效这类明确可识别的旧结果，保留用户手工编辑以及正常的独立镜头提示词。
 */
function isLegacyContinuityImagePrompt(
  prompt: ImagePromptPackage,
  shot: Shot,
  allShots: Shot[],
) {
  return Boolean(
    prompt.promptModel &&
      findContinuityReferenceShot(allShots, shot.id) &&
      ( /采用已上传风格图的?MG插画风格/u.test(prompt.prompt) ||
        // 第二类旧结果已经有“上一镜参考图”了，但仍把对白写成动作句；
        // 同样需要按新尾帧规则重跑一次。
        /[“"][^”"]+[”"]|(?:说|回应|表示|说明|确认处理)[：:]/u.test(prompt.prompt) ),
  );
}

const archivedScriptReview: ScriptReviewReport = {
  status: "PASS",
  checks: [
    { label: "大案例识别", status: "PASS", detail: "识别 3 个内容主题" },
    { label: "最小案例识别", status: "PASS", detail: "递归识别 6 个最小案例" },
    { label: "人物对白覆盖", status: "PASS", detail: "15 句对白无重复或遗漏" },
    { label: "旁白排除", status: "PASS", detail: "旁白不进入生成音频" },
    { label: "非生成内容排除", status: "PASS", detail: "标题卡、审计提醒、总结和固定结尾已排除" },
    { label: "Word 时间码", status: "PASS", detail: "不作为生成时长约束" },
    { label: "角色简称", status: "PASS", detail: "角色简称已在归档审查中解析" },
    { label: "案例 ID", status: "PASS", detail: "使用 S1-E1 至 S3-E2" },
  ],
  flags: [],
  issues: [],
};

type PendingProject = {
  fileName: string;
  paragraphs: ScriptParagraph[];
  cases: ExtractedCase[];
  shots: Shot[];
  prompts: ImagePromptPackage[];
  review: ScriptReviewReport;
  extractionEngine: string;
  /** 导入后自动执行的内容审核结果；在「进入脚本工作台」时并入脚本审查。 */
  audit: ScriptAuditState | null;
};

/**
 * 导入后的自动内容审核状态。
 *
 * 2026-09-18：这一步是「导入完成 → 进入后续步骤」之间新增的自动环节，用户不点任何按钮。
 * 它只提出问题（不改写原文），失败也不阻断流程——用模型一次可能出错的判断去硬拦流程，
 * 代价远大于收益。
 */
type ScriptAuditState = {
  status: "running" | "done" | "error" | "skipped";
  summary: string;
  items: ScriptAuditItem[];
  counts: Record<ScriptAuditKind, number>;
  /** 被程序核实为站不住而没收的条目（说明已写在 summary 里）。 */
  dropped: ScriptAuditDropped;
  model: string;
};

type FeedbackDraft = {
  stage: StageKey;
  targetId: string;
  issueType: string;
  reason: string;
  before: string;
  after: string;
  decision: FeedbackDecision;
};

const FEEDBACK_TYPES = [
  "脚本提取",
  "角色与对白",
  "案例边界",
  "分镜结构",
  "口播节奏",
  "场景与动作",
  "画面构图",
  "角色连续性",
  "画面提示词",
  "视频提示词",
] as const;

function formatProjectTime(value: string) {
  if (!value) return "尚未保存";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const PARAGRAPH_KIND_OPTIONS: Array<{
  value: ScriptParagraph["kind"];
  label: string;
}> = [
  { value: "dialogue", label: "对白" },
  { value: "action", label: "动作" },
  { value: "note", label: "场景" },
  { value: "effect", label: "后期特效" },
  { value: "heading", label: "标题" },
  { value: "meta", label: "结构" },
  { value: "summary", label: "排除" },
];

function paragraphCaseItems(
  paragraph: ScriptParagraph,
  kind: ScriptParagraph["kind"] = paragraph.kind,
): ExtractedCaseItem[] {
  if (kind === "dialogue") {
    const quotedDialogues = [...paragraph.text.matchAll(
      /([^：:\n]{1,40})[：:]\s*[“"](.+?)[”"]/gu,
    )];
    const fallbackDialogue = /^[^：:\n]{1,40}[：:]\s*(.+)$/u.exec(paragraph.text);
    return quotedDialogues.length
      ? quotedDialogues.map((match, index) => ({
          sourceId: paragraph.id,
          sourceSegment: quotedDialogues.length > 1 ? index + 1 : undefined,
          type: "dialogue",
          speaker: match[1].trim() || "待确认人物",
          text: match[2].trim(),
          estimatedSeconds: estimateSpeechSeconds(match[2].trim()),
        }))
      : [{
          sourceId: paragraph.id,
          type: "dialogue",
          speaker: /^[^：:\n]{1,40}[：:]/u.exec(paragraph.text)?.[0]
            ?.replace(/[：:]$/u, "")
            .trim() || "待确认人物",
          text: fallbackDialogue?.[1]?.trim() || paragraph.text.trim(),
          estimatedSeconds: estimateSpeechSeconds(
            fallbackDialogue?.[1]?.trim() || paragraph.text.trim(),
          ),
        }];
  }

  const type = kind === "action"
    ? "action_or_narration"
    : kind === "note"
      ? "visual_direction"
      : kind === "effect"
        // 后期特效：单独成类，既不是画面动作也不是场景。
        ? "visual_effect"
        : kind === "summary"
          ? "narration_context"
          : "title_context";
  return [{
    sourceId: paragraph.id,
    type,
    text: paragraph.text,
    estimatedSeconds: 0,
  }];
}

function DocumentRows({
  paragraphs,
  cases = [],
  selectedCaseId,
  selectable = false,
  reviewMode = false,
  reviewIssues = [],
  editable = false,
  onToggleExtraction,
  onKindChange,
  onTextChange,
  onTextCommit,
  onSpeakerChange,
}: {
  paragraphs: ScriptParagraph[];
  cases?: ExtractedCase[];
  selectedCaseId?: string;
  selectable?: boolean;
  reviewMode?: boolean;
  reviewIssues?: ScriptReviewIssue[];
  editable?: boolean;
  onToggleExtraction?: (paragraphId: number) => void;
  onKindChange?: (paragraphId: number, kind: ScriptParagraph["kind"], caseId?: string) => void;
  onTextChange?: (paragraphId: number, text: string) => void;
  onTextCommit?: (paragraphId: number, text: string) => void;
  onSpeakerChange?: (paragraphId: number, sourceSegment: number | undefined, speaker: string) => void;
}) {
  return (
    <div className="document-page">
      {paragraphs.map((paragraph) => {
        const caseIndex = cases.findIndex((item) =>
          item.sourceIds.includes(paragraph.id),
        );
        const highlightedCase = caseIndex >= 0 ? cases[caseIndex] : undefined;
        const reviewIssue = reviewIssues.find(
          (issue) => issue.sourceId === paragraph.id,
        );
        const caseItems = cases.flatMap((item) => item.items ?? [])
          .filter((item) => item.sourceId === paragraph.id);
        const dialogueItems = caseItems.filter((item) => item.type === "dialogue");
        const effectiveDialogue = dialogueItems[0];
        const effectiveAction = caseItems.find((item) =>
          item.type === "action_or_narration" || item.type === "narration_context",
        );
        const editableKind: ScriptParagraph["kind"] = effectiveDialogue
          ? "dialogue"
          : effectiveAction || paragraph.kind === "action"
            ? "action"
            : paragraph.kind === "note"
              ? "note"
              : paragraph.kind === "effect"
                ? "effect"
                : paragraph.kind === "heading"
                  ? "heading"
                  : paragraph.kind === "summary"
                    ? "summary"
                    : "meta";
        const kindLabel =
          effectiveDialogue || paragraph.kind === "dialogue"
            ? "对白"
            : paragraph.kind === "action" || effectiveAction
              ? "动作"
              : paragraph.kind === "effect"
                ? "后期特效"
                : paragraph.kind === "heading"
                  ? "标题"
                  : paragraph.kind === "note"
                    ? "场景"
                    : paragraph.kind === "section" || paragraph.kind === "meta"
                      ? "结构"
                      : "排除";
        const reviewLabel = reviewIssue ? "需核对" : kindLabel;
        const selectedForCase = highlightedCase?.id === selectedCaseId;
        return (
          <div
            className={`document-row ${paragraph.kind} ${
              highlightedCase ? `case-highlight case-${caseIndex + 1}` : ""
            } ${selectedForCase ? "selected-case" : ""} ${
              selectable ? "extraction-selectable" : ""
            } ${
              reviewIssue ? "review-issue" : ""
            }`}
            id={`paragraph-${paragraph.id}`}
            key={paragraph.id}
            role={selectable ? "button" : undefined}
            aria-pressed={selectable ? selectedForCase : undefined}
            aria-label={selectable
              ? `${selectedForCase ? "从当前案例移除" : "纳入当前案例"}第 ${paragraph.id} 段`
              : undefined}
            tabIndex={selectable ? 0 : reviewIssue ? -1 : undefined}
            onClick={selectable ? () => onToggleExtraction?.(paragraph.id) : undefined}
            onKeyDown={selectable ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggleExtraction?.(paragraph.id);
              }
            } : undefined}
          >
            <span className="paragraph-number">{paragraph.id}</span>
            {editable ? (
              <textarea
                className="review-text-editor"
                rows={1}
                value={paragraph.text}
                aria-label={`修改第 ${paragraph.id} 段正文`}
                onChange={(event) => onTextChange?.(paragraph.id, event.target.value)}
                onBlur={(event) => onTextCommit?.(paragraph.id, event.target.value)}
              />
            ) : (
              <p>{paragraph.text}</p>
            )}
            {selectable && (
              <span className={`extraction-toggle-indicator ${selectedForCase ? "selected" : ""}`} aria-hidden="true">
                {selectedForCase ? <Check size={11} strokeWidth={2.5} /> : <Plus size={11} strokeWidth={2.2} />}
              </span>
            )}
            {reviewMode && (
              <span className="review-row-controls">
                {editable ? (
                  <details className={`review-kind-menu is-${editableKind} ${reviewIssue ? "has-issue" : ""}`}>
                    <summary aria-label={`修改第 ${paragraph.id} 段类型，当前为${kindLabel}`}>
                      <span>{kindLabel}</span>
                      <ChevronDown aria-hidden="true" size={10} strokeWidth={2.4} />
                    </summary>
                    <div className="review-kind-options" role="menu" aria-label={`第 ${paragraph.id} 段类型`}>
                      {PARAGRAPH_KIND_OPTIONS.map((option) => (
                        <button
                          className={option.value === editableKind ? "active" : ""}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.value === editableKind}
                          key={option.value}
                          onClick={(event) => {
                            onKindChange?.(paragraph.id, option.value, highlightedCase?.id ?? selectedCaseId);
                            event.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                        >
                          <span>{option.label}</span>
                          {option.value === editableKind && <Check size={11} strokeWidth={2.5} />}
                        </button>
                      ))}
                    </div>
                  </details>
                ) : (
                  <span className={`review-mark ${reviewLabel}`}>{reviewLabel}</span>
                )}
              </span>
            )}
            {editable && dialogueItems.length > 0 && (
              <span className="review-speaker-editors">
                {dialogueItems.map((dialogue, index) => (
                  <label
                    className="review-speaker-chip"
                    key={`${paragraph.id}-${dialogue.sourceSegment ?? index + 1}`}
                  >
                    <UserRound aria-hidden="true" size={10} strokeWidth={2.2} />
                    <span>{dialogueItems.length > 1 ? `第 ${index + 1} 句` : "说话人"}</span>
                    <input
                      className="review-speaker-input"
                      defaultValue={dialogue.speaker ?? ""}
                      aria-label={`修改第 ${paragraph.id} 段第 ${index + 1} 句说话人`}
                      placeholder="说话人"
                      onBlur={(event) => onSpeakerChange?.(
                        paragraph.id,
                        dialogue.sourceSegment,
                        event.target.value,
                      )}
                    />
                  </label>
                ))}
              </span>
            )}
            {reviewIssue && (
              <small className="review-issue-note">
                <strong>需要核对：</strong>
                {reviewIssue.question ?? reviewIssue.message}
                {reviewIssue.action && <span>{reviewIssue.action}</span>}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ShotFilmstrip({
  items,
  selectedId,
  onSelect,
  showConfirmation = false,
  polishingIds = [],
  adoptedVideoPreviewByShotId,
}: {
  items: Shot[];
  selectedId: string;
  onSelect: (id: string) => void;
  showConfirmation?: boolean;
  polishingIds?: string[];
  adoptedVideoPreviewByShotId?: Record<string, string>;
}) {
  const confirmedCount = items.filter((shot) => shot.storyboardConfirmed).length;
  return (
    <div className="filmstrip" aria-label="镜头队列">
      <div className="filmstrip-heading">
        <span>镜头队列</span>
        <strong>{showConfirmation ? `${confirmedCount} / ${items.length} 已确认` : `${items.length} 个分镜草稿`}</strong>
      </div>
      <div className="filmstrip-list">
        {items.map((shot) => {
          const adoptedVideoPreview = adoptedVideoPreviewByShotId?.[shot.id];
          return (
          <button
            className={`filmstrip-item ${selectedId === shot.id ? "active" : ""}`}
            type="button"
            key={shot.id}
            onClick={() => onSelect(shot.id)}
            aria-pressed={selectedId === shot.id}
          >
            <span className={`filmstrip-thumb ${shot.image || adoptedVideoPreview ? "" : "empty"}`}>
              {adoptedVideoPreview ? (
                <video src={adoptedVideoPreview} muted playsInline preload="metadata" />
              ) : shot.image ? (
                <Image src={shot.image} alt="" fill sizes="72px" />
              ) : (
                <ImageIcon size={17} />
              )}
              {showConfirmation && (
                <em className={`crop-mini ${shot.storyboardConfirmed ? "ready" : ""} ${polishingIds.includes(shot.id) ? "polishing" : ""}`}>
                  {polishingIds.includes(shot.id)
                    ? "润色中"
                    : shot.storyboardConfirmed
                      ? "已确认"
                      : "待确认"}
                </em>
              )}
            </span>
            <span>
              {/* 2026-10-08 用户拍板：对外只显示 `S1-E1_01` 这种有序编号（下划线）。
                  `shot.id` 是画面词与媒体任务的主键，内部键仍用连字符、插入一镜后会
                  留下缺口（01、02、04）——那是键的正常形态，不该给人看。
                  第二行原本是 `shot.title`，同一案例内每镜都一样，没有区分度；
                  换成这一镜自己的「人物 · 动作」。 */}
              <b>{shotDisplayLabel(items, shot.id)}</b>
              <strong>{shotBriefLabel(shot)}</strong>
            </span>
          </button>
          );
        })}
      </div>
    </div>
  );
}

function PromptFilmstrip({
  items,
  shots,
  selectedId,
  onSelect,
}: {
  items: ImagePromptPackage[];
  /**
   * 画面词只知道自己的 `id`，拿不到人物与动作，也算不出顺序号。
   * 2026-10-08：把它所对应的分镜列表传进来，编号与第二行都从这里取。
   */
  shots: Shot[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  /**
   * 画面词 → 分镜：先按同名匹配；存量数据里出现过画面词少于分镜的情况
   * （`4de1d001` 的 `S3-E1-02/03/04` 都挂在 `S3-E1-01` 上），所以再按
   * `referenceId` 兜一层，兜不到就按画面词自己的 id 显示。
   */
  const shotForPrompt = (promptId: string) =>
    shots.find((shot) => shot.id === promptId) ??
    shots.find((shot) => (shot.referenceId ?? shot.id) === promptId);
  return (
    <div className="filmstrip" aria-label="逐镜画面词">
      <div className="filmstrip-heading">
        <span>逐镜画面词</span>
        <strong>
          {items.length} 个镜头 · {items.filter((item) => item.status === "ready").length} 个已选图
        </strong>
      </div>
      <div className="filmstrip-list">
        {items.map((item) => {
          const shot = shotForPrompt(item.id);
          return (
          <button
            className={`filmstrip-item ${selectedId === item.id ? "active" : ""}`}
            type="button"
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-pressed={selectedId === item.id}
          >
            <span className={`filmstrip-thumb ${item.image ? "" : "empty"}`}>
              {item.image ? (
                <Image src={item.image} alt="" fill sizes="72px" />
              ) : (
                <ImageIcon size={17} />
              )}
              <em className={`crop-mini ${item.status}`}>
                {item.status === "ready" ? "已选图" : "待选图"}
              </em>
            </span>
            <span>
              {/* 2026-10-08：这里以前显示 `item.id`（内部键），与分镜阶段改用顺序号后
                  对不上——同一屏两个胶片条，一个写 `S1-E1-04`、一个写 `1`。
                  查不到对应分镜时回退 `item.id`：画面词可能挂在已被删掉的分镜上。 */}
              <b>{shot ? shotDisplayLabel(shots, shot.id) : item.id}</b>
              <strong>{shot ? shotBriefLabel(shot) : item.title}</strong>
            </span>
          </button>
          );
        })}
      </div>
    </div>
  );
}

/** 本镜参考图清单里的一项：界面展示、提示词分工说明、提交上传三者共用同一份数据。 */
type VideoReferencePlanImage = {
  dataUrl: string;
  fileName: string;
  /** 给模型和用户看的说明（如「S2-E1-01 本镜分镜画面」）。 */
  label: string;
  role: VideoReferenceImageRole;
  /** role 为 character 时这张图对应哪个角色名——参考图说明据此写「图中人物即 X」。 */
  personName?: string;
};

/** 本镜提到、但素材库里没有形象的人。`isSpeaker=false` 指只被称呼、没开口的那种。 */
type VideoReferenceMissingRole = { name: string; isSpeaker: boolean };

/**
 * 本镜「提到了哪些人」——开口说话的人，以及台词里的称呼对象。
 *
 * 称呼语必须算进来：S2-E1-01 的台词是「刘老师，您提交的…」，说话人是小李，
 * 「刘老师」只是被称呼——可恰恰是他需要在画面里出现，也正是当时的缺口。
 */
function mentionedRoles(shot: Shot): Array<{ name: string; isSpeaker: boolean }> {
  const roles: Array<{ name: string; isSpeaker: boolean }> = [];
  const add = (value: string, isSpeaker: boolean) => {
    const name = String(value || "").trim();
    if (!name || name.length > 6) return;
    const existing = roles.find((item) => item.name === name);
    if (existing) {
      if (isSpeaker) existing.isSpeaker = true;
      return;
    }
    roles.push({ name, isSpeaker });
  };
  for (const part of String(shot.speaker || "").split(/[→、,，/|\s]+|->/u)) add(part, true);
  for (const { speaker, line } of parseDialogueSpeakers(shot.dialogue)) {
    add(speaker, true);
    const vocative = String(line || "").match(/^([\u4e00-\u9fff]{2,4})[，,：:]/u);
    if (vocative) add(vocative[1], false);
  }
  return roles;
}

/**
 * 组装本镜视频要上传的参考图清单（2026-09-18 按用户澄清改写）。
 *
 * 用户口径：「我们别的分镜上传的静态图片也不一定是首帧……我本来的意思也是生成一个参考图，
 * 你从参考图去发散生成相关视频，参考图是可以上传好几个的。」
 *
 * 所以这里不再只塞一张，而是把本镜真正用得上的图都列出来。**顺序有讲究**：豆包不回报
 * 原始文件名（实测 CommitImageUpload 的 TOS key 是哈希名），uri 只能按上传顺序对应，
 * 因此第 1 张必须是「画面基准」，否则提示词里的分工说明会指错对象。
 *
 *   第 1 张  画面基准：手动采用的分镜图（用户显式选择，最高）> 上一镜尾帧
 *   其后     本镜出现的角色形象素材——这是给「分镜画面里没有的人」补视觉锚
 *   最后     项目画风素材
 *
 * 缺锚的人（台词里提到、素材库里没有形象）单独返回，由界面提示用户去补——
 * 单张参考图下模型无法凭文字造出稳定人物，S2-E1-01 的「对着空椅子说话」就是这么来的。
 */
function buildVideoReferencePlan(input: {
  shot: Shot;
  /** 全部分镜，用来算本镜与上一镜的对外展示编号（`S1-E1_01`）。 */
  shots: Shot[];
  tailSourceId?: string;
  tailFrame?: string;
  /** 2026-09-26：画面词已采用图（imagePromptDrafts[].image）。分镜重排/重建后
   * shot.image 常为空、案例首镜又没有上一镜尾帧，不认它就会 **0 参考图提交**
   * （038eb112 实证：界面提交 refs=0，豆包完全没拿到分镜图）。 */
  draftImage?: string;
  references: VideoPromptSources["references"];
}): { images: VideoReferencePlanImage[]; missingRoles: VideoReferenceMissingRole[] } {
  const images: VideoReferencePlanImage[] = [];
  const seen = new Set<string>();
  const push = (image: VideoReferencePlanImage) => {
    if (!image.dataUrl || seen.has(image.dataUrl)) return;
    if (images.length >= 10) return;
    seen.add(image.dataUrl);
    images.push(image);
  };
  // 这些名字既进豆包的上传清单，也直接显示给用户，统一用对外编号。
  const shotLabel = shotDisplayLabel(input.shots, input.shot.id);

  if (input.shot.image) {
    push({
      dataUrl: input.shot.image,
      fileName: `${shotLabel}-画面基准.jpg`,
      label: `${shotLabel} 本镜分镜画面`,
      role: "base",
    });
  } else if (input.draftImage) {
    push({
      dataUrl: input.draftImage,
      fileName: `${shotLabel}-画面基准.jpg`,
      label: `${shotLabel} 本镜分镜画面`,
      role: "base",
    });
  } else if (input.tailFrame && input.tailSourceId) {
    push({
      dataUrl: input.tailFrame,
      fileName: `${shotDisplayLabel(input.shots, input.tailSourceId)}-尾帧.png`,
      label: `上一镜 ${shotDisplayLabel(input.shots, input.tailSourceId)} 的结尾画面`,
      role: "continuity",
    });
  }

  // 上传清单和视觉身份诊断共用同一组人物，绑定规则只在来源解析器内解释一次。
  for (const reference of input.references) {
    push({
      dataUrl: reference.image,
      fileName: `${reference.characterName}.png`,
      label: `${reference.characterName} 的人物形象`,
      role: "character",
      personName: reference.characterName,
    });
  }
  const missingRoles = mentionedRoles(input.shot).filter(role => {
    const normalized = role.name.replace(/\s+/gu, "");
    return !input.references.some(reference =>
      [reference.roleName, reference.characterName].some(name => name.replace(/\s+/gu, "") === normalized));
  });
  return { images, missingRoles };
}

export default function Home() {
  const [authStatus, setAuthStatus] = useState<"loading" | "anonymous" | "authenticated">("loading");
  const [authEmail, setAuthEmail] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authFormEmail, setAuthFormEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/auth", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ authenticated?: boolean; user?: { email?: string } }>)
      .then((data) => {
        setAuthStatus(data.authenticated ? "authenticated" : "anonymous");
        setAuthEmail(data.user?.email ?? "");
      })
      .catch(() => setAuthStatus("anonymous"));
  }, []);

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: authMode, email: authFormEmail, password: authPassword }),
      });
      const data = await response.json() as { user?: { email?: string }; error?: string };
      if (!response.ok || !data.user?.email) throw new Error(data.error || "认证失败");
      setAuthEmail(data.user.email);
      setAuthPassword("");
      setAuthStatus("authenticated");
      setDraftsLoaded(false);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "认证失败");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth", { method: "DELETE" }).catch(() => undefined);
    setAuthStatus("anonymous");
    setAuthEmail("");
    setDraftsLoaded(false);
  };

  const [currentStage, setCurrentStage] = useState<StageKey>("imagePrompt");
  const [workflowStage, setWorkflowStage] = useState<StageKey>("imagePrompt");
  const [selectedId, setSelectedId] = useState("S2-E1-01");
  const [selectedCaseId, setSelectedCaseId] = useState("S1-E1");
  const [selectedImagePromptId, setSelectedImagePromptId] =
    useState("S2-E1-01");
  const [scriptDrafts, setScriptDrafts] =
    useState<ScriptParagraph[]>(scriptParagraphs);
  const [sourceFileName, setSourceFileName] = useState(
    "酬金发放，这些雷区不要踩.docx",
  );
  const [shotDrafts, setShotDrafts] = useState<Shot[]>(shots);
  const [caseDrafts, setCaseDrafts] =
    useState<ExtractedCase[]>(extractedCases);
  const [imagePromptDrafts, setImagePromptDrafts] =
    useState<ImagePromptPackage[]>(imagePromptPackages);
  const [scriptReview, setScriptReview] =
    useState<ScriptReviewReport>(archivedScriptReview);
  const [extractionEngine, setExtractionEngine] = useState(
    "脚本结构提取器 · 已审查归档",
  );
  const [projectName, setProjectName] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("");
  const [projectCreatedAt, setProjectCreatedAt] = useState("");
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [projectHistory, setProjectHistory] = useState<ProjectHistoryEntry[]>([]);
  const [acceptanceRuns, setAcceptanceRuns] = useState<AcceptanceRun[]>([]);
  const [speechRate, setSpeechRate] = useState(SPEECH_UNITS_PER_SECOND);
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [draftProjectName, setDraftProjectName] = useState("");
  const [pendingProject, setPendingProject] = useState<PendingProject | null>(
    null,
  );
  const [newProjectUploadStatus, setNewProjectUploadStatus] = useState<
    "idle" | "uploading" | "auditing" | "ready" | "error"
  >("idle");
  const [scriptAudit, setScriptAudit] = useState<ScriptAuditState | null>(null);
  const [newProjectUploadSummary, setNewProjectUploadSummary] = useState<{
    fileName: string;
    paragraphCount: number;
    caseCount: number;
  } | null>(null);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [shotStructureDialog, setShotStructureDialog] = useState<
    "split" | "merge" | null
  >(null);
  // 2026-09-17 分镜反馈渠道：用户描述「哪里不对」，AI 重写画面字段（台词逐字保护）。
  const [shotReviseFeedback, setShotReviseFeedback] = useState("");
  const [shotRevising, setShotRevising] = useState(false);
  const [selectedSplitKey, setSelectedSplitKey] = useState("");
  const [managementPanel, setManagementPanel] = useState<
    "projects" | "content" | "knowledge" | "settings" | null
  >(null);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>({
    stage: "storyboard",
    targetId: "",
    issueType: FEEDBACK_TYPES[0],
    reason: "",
    before: "",
    after: "",
    decision: "pending",
  });
  const [uploadedNames, setUploadedNames] = useState<Record<string, string>>({});
  const [reuseRules, setReuseRules] = useState<ReuseRule[]>([]);
  const [referenceAssets, setReferenceAssets] = useState<ReferenceAsset[]>([]);
  const { configuration: aiConfiguration, draft: aiConnectionDraft,
    setDraft: setAiConnectionDraft, state: aiSettingsState, setState: setAiSettingsState,
    message: aiSettingsMessage, setMessage: setAiSettingsMessage,
    editing: aiConnectionEditing, changeProvider: changeAiProvider,
    edit: editAiConnection, cancel: cancelAiConnectionEdit, save: saveAiConnection,
  } = useModelConnection("text", authStatus === "authenticated");
  const { configuration: visionConfiguration, draft: visionConnectionDraft,
    setDraft: setVisionConnectionDraft, state: visionSettingsState, setState: setVisionSettingsState,
    message: visionSettingsMessage, setMessage: setVisionSettingsMessage,
    editing: visionConnectionEditing, changeProvider: changeVisionProvider,
    edit: editVisionConnection, cancel: cancelVisionConnectionEdit, save: saveVisionConnection,
  } = useModelConnection("vision", authStatus === "authenticated");
  const [providerOverview, setProviderOverview] = useState<ProviderOverview>({
    baseUrl: "http://127.0.0.1:8012",
    configured: false,
    online: false,
  });
  const [providerBaseUrl, setProviderBaseUrl] = useState("http://127.0.0.1:8012");
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    AUTO_PROVIDER_ACCOUNT_ID,
  );
  const [newProviderAccountName, setNewProviderAccountName] = useState("");
  const [providerAction, setProviderAction] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [mediaJobs, setMediaJobs] = useState<MediaJob[]>([]);
  const [mediaPreviewSelection, setMediaPreviewSelection] = useState<{
    jobId: string;
    candidateId: string;
    targetId: string;
    mediaType: "image" | "video";
  } | null>(null);
  const [mediaAction, setMediaAction] = useState("");
  const [mediaMessage, setMediaMessage] = useState("");
  const [pendingMediaRejection, setPendingMediaRejection] =
    useState<PendingMediaRejection | null>(null);
  const [mediaRejectionReason, setMediaRejectionReason] = useState("");
  const [mediaFeedbackProgress, setMediaFeedbackProgress] =
    useState<MediaFeedbackProgress | null>(null);
  const [aiRuleLoading, setAiRuleLoading] = useState(false);
  const [batchRuleDraft, setBatchRuleDraft] = useState("");
  const [batchRuleLoading, setBatchRuleLoading] = useState(false);
  const [batchRuleResult, setBatchRuleResult] = useState("");
  const [imagePromptPolishingIds, setImagePromptPolishingIds] = useState<string[]>([]);
  const [videoPromptPolishingIds, setVideoPromptPolishingIds] = useState<string[]>([]);
  const [draggedActionIndex, setDraggedActionIndex] = useState<number | null>(null);
  const [actionDropIndex, setActionDropIndex] = useState<number | null>(null);
  const [aiExtractionLoading, setAiExtractionLoading] = useState(false);
  const [aiExtractionReview, setAiExtractionReview] = useState<
    (ExtractionReviewResult & { model: string; rulesUsed: number }) | null
  >(null);
  const [isParsingWord, setIsParsingWord] = useState(false);
  const [sourceChanged, setSourceChanged] = useState(false);
  const projectSessionRef = useRef(0);
  const activeProjectRef = useRef("");
  const mediaRequestRef = useRef(0);
  const mediaMaintenanceRef = useRef(new Set<string>());
  const toastTimerRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const batchRuleInFlightRef = useRef(false);
  const polishStateRef = useRef(new PolishState());
  const imagePromptPolishLaneRef = useRef(new PolishLane());
  const videoPromptPolishLaneRef = useRef(new PolishLane());
  /**
   * 2026-09-17：重试定时器在 10~30 秒后才触发，必须拿到「触发那一刻」的最新素材，
   * 不能吃闭包里的旧快照——否则会把改之前的旧内容润色成一份看似新的结果。
   */
  const shotDraftsRef = useRef<Shot[]>([]);
  const imagePromptDraftsRef = useRef<ImagePromptPackage[]>([]);
  /**
   * 2026-09-16：视频词润色与画面词一致，改为**全后台自动执行**（已移除润色按钮）。
   * 记录「镜头 id → 已润色的素材签名」：签名变化（对白/动作/约束/时长被改）即自动重新润色，
   * 签名相同则跳过，避免重复请求文本模型。
   */
  const videoPromptAutoPolishRef = useRef(new Map<string, string>());
  /** 素材变化后触发自动润色的防抖计时器。 */
  const videoPromptAutoPolishTimerRef = useRef<number | null>(null);
  /**
   * 2026-10-08：本轮后台自动润色的结果收集器（见 `polish-digest.ts`）。
   * 逐镜结果压成**一条**可展开通知，取代此前「一镜一条、互相覆盖」的弹出。
   */
  const autoPolishBatchRef = useRef(new AutoPolishBatch());
  /**
   * 本轮的兜底计时器：万一某个镜头的润色请求既不返回也不报错（挂死），
   * 到点就把已收齐的结果汇总出来，而不是让用户永远等不到解释。
   */
  const autoPolishDigestTimerRef = useRef<number | null>(null);
  /**
   * 两类润色共享版本、重试、耗尽与等待者状态；图片和视频仍按 kind 隔离。
   */
  /** 当前是否有一次「排队等待润色后自动提交」正在进行（用于按钮态与防重复提交）。 */
  const [pendingMediaSubmit, setPendingMediaSubmit] = useState<{
    targetId: string;
    mediaType: "image" | "video";
  } | null>(null);
  const [pendingMediaElapsed, setPendingMediaElapsed] = useState(0);
  /** 重试耗尽后「用未润色模板强行提交」逃生口所需的上下文。 */
  const [unpolishedEscape, setUnpolishedEscape] = useState<{
    targetId: string;
    error: string;
    /** 确定性拒收：文案上不该再劝用户「再点一次试试」。 */
    rejected?: boolean;
    /**
     * 确定性拒收的具体类别（2026-09-30 新增），决定文案给出的下一步：
     *  - `AI_OUTPUT_REJECTED`：模型违反内容规则 → 未润色模板能绕过，建议用模板提交；
     *  - `AI_INPUT_REJECTED`：本镜素材缺场景/动作 → 模板里同样没有这两个字段，
     *    必须回去补素材，不能劝用户点模板提交；
     *  - 空字符串：瞬时失败，建议重试。
     */
    code?: string;
  } | null>(null);

  const stage = stages.find((item) => item.key === currentStage) ?? stages[0];
  const workflowStageIndex = stages.findIndex(
    (item) => item.key === workflowStage,
  );
  const selected =
    shotDrafts.find((shot) => shot.id === selectedId) ?? shotDrafts[0];
  const confirmedShotCount = shotDrafts.filter(
    (shot) => shot.storyboardConfirmed,
  ).length;
  const unconfirmedShotCount = shotDrafts.length - confirmedShotCount;
  const selectedShotPromptPolishing = imagePromptPolishingIds.includes(selected.id);
  const selectedShotVideoPromptPolishing = videoPromptPolishingIds.includes(selected.id);
  /**
   * 2026-09-16：对白字数预算提示。Seedance 的对白舒适语速约 3.3—4 字/秒
   * （官方提示词公式把「语速」列为独立维度；社区实测长句会在后半段退化成音素糊）。
   * 超出预算时模型只能被迫加速，听感就是「前半快、后半慢 + 咬字含糊」。
   */
  const selectedVideoSeconds = videoDurationBucket(
    selected.videoSecondsOverride ?? selected.estimatedSeconds,
  );
  const selectedDialogueChars = selected.dialogue.replace(/\s+/gu, "").length;
  const selectedDialogueBudget = Math.round(selectedVideoSeconds * 4);
  const selectedDialogueOverloaded = selectedDialogueChars > selectedDialogueBudget;
  const selectedShotCaseId = shotCaseId(selected);
  const selectedShotCase = caseDrafts.find(
    (item) => item.id === selectedShotCaseId,
  );
  const selectedCaseShots = shotDrafts.filter(
    (shot) => shotCaseId(shot) === selectedShotCaseId,
  );
  /** 当前镜头的对外展示编号（`S1-E1_01`），界面上所有「显示镜号」的地方共用它。 */
  const selectedDisplayLabel = shotDisplayLabel(shotDrafts, selected.id);
  const selectedShotCaseIndex = selectedCaseShots.findIndex(
    (shot) => shot.id === selected.id,
  );
  const nextCaseShot = selectedCaseShots[selectedShotCaseIndex + 1];
  const selectedSpeechRate = normalizeSpeechRate(
    selected.speechRateOverride ?? speechRate,
  );
  const splitOptions = splitOptionsForShot(selected, speechRate);
  const selectedSplitOption = splitOptions.find(
    (option) => option.key === selectedSplitKey,
  );
  const mergedShotSeconds = nextCaseShot
    ? recalculateShotTiming(
        {
          ...selected,
          dialogue: `${selected.dialogue}\n${nextCaseShot.dialogue}`,
          speechRateOverride:
            selected.speechRateOverride ?? nextCaseShot.speechRateOverride,
        },
        speechRate,
      ).estimatedSeconds ?? 0
    : selected.estimatedSeconds ?? 0;
  const selectedCase =
    caseDrafts.find((item) => item.id === selectedCaseId) ?? caseDrafts[0];
  const selectedImagePrompt =
    imagePromptDrafts.find((item) => item.id === selectedImagePromptId) ??
    imagePromptDrafts[0];
  const selectedImagePromptPolishing = imagePromptPolishingIds.includes(
    selectedImagePrompt?.id,
  );
  const selectedImageShot = shotDrafts.find(
    (shot) => shot.id === selectedImagePrompt?.id,
  );
  /** 画面词阶段的对外展示编号；对不上分镜时回退画面词自身的键。 */
  const selectedImageDisplayLabel = selectedImageShot
    ? shotDisplayLabel(shotDrafts, selectedImageShot.id)
    : selectedImagePrompt?.id ?? "";
  const continuityReferenceShot = selectedImageShot
    ? findContinuityReferenceShot(shotDrafts, selectedImageShot.id)
    : undefined;
  const continuityReference = resolveContinuityReference(shotDrafts, imagePromptDrafts, selectedImageShot?.id ?? "");
  const continuityReferenceTailFrame = continuityReference.tailFrame;
  const continuityReferenceImage = continuityReference.image;
  const inferredProjectTitle =
    scriptDrafts
      .find((paragraph) => /^(?:标题|片名)\s*[:：]/u.test(paragraph.text))
      ?.text.replace(/^(?:标题|片名)\s*[:：]\s*/u, "") ??
    sourceFileName.replace(/\.docx$/iu, "");
  const projectTitle = projectName.trim() || inferredProjectTitle;
  const selectedRuleContext = [
    selectedImagePrompt?.title,
    selectedImagePrompt?.prompt,
    selected?.dialogue,
    selected?.action,
    selected?.continuity,
  ]
    .filter(Boolean)
    .join(" ");
  const matchedImageRules = matchReuseRules(reuseRules, {
    projectId: activeProjectId,
    stage: "imagePrompt",
    text: selectedRuleContext,
  });
  const selectedCharacterBindings = matchedImageRules
    .map((rule) =>
      parseCharacterBindingInstruction(rule.title) ??
      parseCharacterBindingInstruction(rule.instruction),
    )
    .filter((binding): binding is { sourceRole: string; targetRole: string } => Boolean(binding));
  const matchedSpeechRules = matchReuseRules(reuseRules, {
    projectId: activeProjectId,
    stage: "storyboard",
    text: [selected.title, selected.chapter, selected.dialogue, selected.location]
      .filter(Boolean)
      .join(" "),
  }).filter((rule) => typeof rule.speechRate === "number");
  const matchedExtractionRules = matchReuseRules(reuseRules, {
    projectId: activeProjectId,
    stage: "cases",
    text: scriptDrafts.map((item) => item.text).join(" ").slice(0, 60_000),
  });
  const selectedPromptShots = shotDrafts.filter(
    (shot) => (shot.referenceId ?? shot.id) === selectedImagePrompt?.id,
  );
  const needsAuditorAsset = /审计(?:人员|员)\s*A/u.test([
    selectedImagePrompt?.prompt,
    ...selectedPromptShots.map((shot) => `${shot.speaker} ${shot.dialogue}`),
  ].filter(Boolean).join(" ")) || selectedCharacterBindings.some(
    (binding) => binding.targetRole.replace(/\s+/gu, "") === "审计员A",
  );
  const auditorAsset = referenceAssets.find(
    (asset) => asset.kind === "character" && asset.roleName === "审计员A",
  );
  const styleAsset = referenceAssets.find((asset) => asset.kind === "style");
  const isProductionStage = [
    "storyboard",
    "imagePrompt",
    "videoPrompt",
  ].includes(currentStage);
  const isScriptStage = ["script", "cases", "scriptReview"].includes(
    currentStage,
  );
  const isArchivedExtraction = extractionEngine.includes("已审查归档");
  /**
   * 2026-09-16 晚：参考图过期判定——采用图片后分镜的画面字段（人物/场景/动作/衔接）
   * 再被修改，图即过期：从「可生成视频」的判定中剔除，并在界面上列出改动、要求显式处理。
   */
  const referenceImageStaleFor = (shot: Shot) => {
    const draft = imagePromptDrafts.find(
      (item) => item.id === (shot.referenceId ?? shot.id),
    );
    return referenceImageStale(shot, draft);
  };
  const selectedStaleImage = referenceImageStaleFor(selected);
  const selectedConfirmedChanges = shotConfirmedChanges(selected);
  /**
   * 2026-09-17 尾帧链：这一镜能否「直接用上一镜视频尾帧」作参考图。
   * 衔接判定复用 findContinuityReferenceShot（同案例 + 衔接意图 + 非独立开场，
   * 与画面词阶段的续镜语义一致）；上一镜尾帧的视觉签名与当前分镜不符即过期，
   * 链路失效、回退到手动参考图门槛，避免拿旧画面接新分镜。
   */
  const videoTailFrameSourceFor = (shot: Shot) => {
    const reference = resolveContinuityReference(shotDrafts, imagePromptDrafts, shot.id);
    return reference.tailFrame ? reference.shot : undefined;
  };
  const canUseVideoPromptForShotWithTail = (shot: Shot) =>
    canUseVideoPromptForShot(shot, imagePromptDrafts) ||
    Boolean(shot.storyboardConfirmed && videoTailFrameSourceFor(shot));
  /** 尾帧链不可用时给出针对性提示；返回空串则回退默认文案。 */
  const videoTailMissingHintFor = (shot: Shot) => {
    const previous = findContinuityReferenceShot(shotDrafts, shot.id);
    if (!previous) return "";
    if (previous.videoLastFrame) {
      return `上一镜 ${shotDisplayLabel(shotDrafts, previous.id)} 的结尾画面已过期（分镜在抽帧后被修改过），请重新验收上一镜视频，或为本镜手动采用参考图`;
    }
    return `上一镜 ${shotDisplayLabel(shotDrafts, previous.id)} 的视频尚未验收，请先验收上一镜候选视频，或为本镜手动采用参考图`;
  };
  const videoSourcesFor = (shot: Shot) => resolveVideoPromptSources(shot, {
    shots: shotDrafts, prompts: imagePromptDrafts, assets: referenceAssets, rules: reuseRules, projectId: activeProjectId,
  });
  const videoModelIdentity = JSON.stringify([aiConfiguration.provider, aiConfiguration.endpoint, aiConfiguration.model,
    visionConfiguration.provider, visionConfiguration.endpoint, visionConfiguration.model]);
  const videoSignatureFor = (shot: Shot) => videoPromptInputSignature(shot, videoSourcesFor(shot), videoModelIdentity);
  const videoContextRef = useRef({ assets: referenceAssets, rules: reuseRules, projectId: activeProjectId, model: videoModelIdentity });
  useEffect(() => {
    videoContextRef.current = { assets: referenceAssets, rules: reuseRules, projectId: activeProjectId, model: videoModelIdentity };
  }, [referenceAssets, reuseRules, activeProjectId, videoModelIdentity]);
  const latestVideoSignatureFor = (shot: Shot) => videoPromptInputSignature(shot,
    resolveVideoPromptSources(shot, { ...videoContextRef.current, shots: shotDraftsRef.current, prompts: imagePromptDraftsRef.current }),
    videoContextRef.current.model);
  const selectedVideoPromptFresh = Boolean(selected.videoPromptPolished?.sourceSignature &&
    selected.videoPromptPolished.sourceSignature === videoSignatureFor(selected));
  const selectedVideoPromptShot = selectedVideoPromptFresh ? selected : { ...selected, videoPromptPolished: undefined };
  const selectedVideoTailSource = videoTailFrameSourceFor(selected);
  // 2026-09-26：基准图兜底到画面词已采用图——shot.image 在重排/重建后常为空，
  // 案例首镜没有上一镜尾帧，缺了这条界面提交就是 0 参考图（038eb112 实证）。
  const selectedVideoDraftImage = imagePromptDrafts.find(
    (item) => item.id === (selected.referenceId ?? selected.id) && item.image,
  )?.image;
  /**
   * 本镜视频的参考图清单与置顶说明（2026-09-18）。
   * 界面、提示词、实际上传三处共用这一份，保证「界面上写的」和「真正发出去的」一致。
   */
  const selectedVideoReferencePlan = buildVideoReferencePlan({
    shot: selected,
    shots: shotDrafts,
    draftImage: selectedVideoDraftImage,
    tailSourceId: selectedVideoTailSource?.id,
    tailFrame: selectedVideoTailSource?.videoLastFrame,
    references: videoSourcesFor(selected).references,
  });
  const selectedVideoReferenceNote = buildReferenceImageNote(
    selectedVideoReferencePlan.images,
  );
  /**
   * 缺人物锚的提示文案（没有缺人的时候是空串，界面不渲染）。
   * 这是 S2-E1-01「对着空座位讲话」的可操作出口：把「谁没有形象素材」直接点名。
   */
  const selectedVideoReferenceMissingNote = (() => {
    const missing = selectedVideoReferencePlan.missingRoles;
    if (!missing.length) return "";
    const names = missing
      .map((role) => (role.isSpeaker ? role.name : `${role.name}（只被台词称呼、未开口）`))
      .join("、");
    const hasAddresseeOnly = missing.some((role) => !role.isSpeaker);
    return (
      `本镜台词里出现、但素材库里还没有形象图的人物：${names}。`
      + (hasAddresseeOnly
        ? "被称呼的人如果不在分镜画面里，模型就没有视觉锚，容易对着画面里已有的空位或别人说话（实测出现过「对着空座位讲话」）——建议先在素材库里存一张他的形象图，本镜会把它连同分镜图一起作为参考图送进去。"
        : "分镜画面里若本来就有这个人，可以忽略；若画面里没有，建议先存一张他的形象图。")
    );
  })();
  const videoReadyShotCount = shotDrafts.filter((shot) =>
    canUseVideoPromptForShotWithTail(shot) &&
    !referenceImageStaleFor(shot),
  ).length;
  const selectedVideoPromptReady =
    canUseVideoPromptForShotWithTail(selected) && !selectedStaleImage;
  const selectedImageVideoPromptReady = selectedImageShot
    ? canUseVideoPromptForShotWithTail(selectedImageShot) &&
      !referenceImageStaleFor(selectedImageShot)
    : false;
  const remainingVideoPromptCount = Math.max(
    0,
    shotDrafts.length - videoReadyShotCount,
  );
  const aiConnectionNeedsKey =
    aiConnectionDraft.provider !== aiConfiguration.provider ||
    aiConnectionDraft.endpoint.trim().replace(/\/$/u, "") !==
      aiConfiguration.endpoint.trim().replace(/\/$/u, "");
  const visionConnectionNeedsKey =
    visionConnectionDraft.provider !== visionConfiguration.provider ||
    visionConnectionDraft.endpoint.trim().replace(/\/$/u, "") !==
      visionConfiguration.endpoint.trim().replace(/\/$/u, "");
  const selectedProviderAccount = providerAccounts.find(
    (account) => account.id === selectedProviderAccountId,
  );
  const loggedInProviderAccounts = providerAccounts.filter(
    (account) => account.enabled && account.loginStatus === "logged_in",
  );
  /**
   * 2026-09-16：自动分配要按「这一镜需要多少秒」挑账号——额度是按秒发的，
   * 剩 5 秒的账号做不了 15 秒镜头，但做得了 5 秒镜头，不能一刀切跳过。
   * 图片任务没有这个约束（requiredSeconds = 0）。
   */
  const mediaRequiredQuotaSeconds =
    currentStage === "videoPrompt" ? selectedVideoSeconds : 0;
  const quotaEligibleProviderAccounts = loggedInProviderAccounts.filter((account) =>
    providerAccountQuotaAllows(account, mediaRequiredQuotaSeconds),
  );
  const automaticallyAssignProvider =
    selectedProviderAccountId === AUTO_PROVIDER_ACCOUNT_ID;
  const selectedMediaType = currentStage === "videoPrompt" ? "video" : "image";
  const selectedMediaTargetId =
    selectedMediaType === "image" ? selectedImagePrompt.id : selected.id;
  const selectedMediaJobs = mediaJobs.filter(
    (job) =>
      job.projectId === activeProjectId &&
      job.targetId === selectedMediaTargetId &&
      job.mediaType === selectedMediaType,
  );
  const selectedAdoptedMediaJob = selectedMediaJobs.find((job) =>
    job.candidates.some((candidate) => candidate.status === "adopted"),
  );
  const selectedAdoptedMediaCandidate = selectedAdoptedMediaJob?.candidates.find(
    (candidate) => candidate.status === "adopted",
  );
  const adoptedVideoPreviewByShotId = mediaJobs.reduce<Record<string, string>>(
    (result, job) => {
      if (job.projectId !== activeProjectId || job.mediaType !== "video") return result;
      const adoptedCandidate = job.candidates.find((candidate) => candidate.status === "adopted");
      if (adoptedCandidate) result[job.targetId] = adoptedCandidate.previewUrl;
      return result;
    },
    {},
  );
  const pendingLegacyImageFeedback = selectedMediaType === "image"
    ? projectHistory.filter(
        (entry) =>
          entry.kind === "feedback" &&
          entry.stage === "reference" &&
          entry.targetId === selectedMediaTargetId &&
          entry.issueType === IMAGE_RETRY_FEEDBACK_TYPE &&
          entry.decision === "rejected" &&
          entry.after === LEGACY_IMAGE_RETRY_FEEDBACK &&
          Boolean(entry.reason?.trim()),
      ).slice(0, 3)
    : [];
  const activeSelectedMediaJobs = selectedMediaJobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  );
  const activeSelectedMediaJob = activeSelectedMediaJobs[0];
  const recentSelectedMediaJobs = selectedMediaJobs.slice(0, 3);
  const visibleSelectedMediaJobs = recentSelectedMediaJobs.filter(
    (job, index) => index === 0 || job.status !== "failed",
  );
  const historicalFailedMediaJobs = recentSelectedMediaJobs.filter(
    (job, index) => index > 0 && job.status === "failed",
  );
  const focusedMediaJob =
    mediaPreviewSelection?.targetId === selectedMediaTargetId &&
    mediaPreviewSelection.mediaType === selectedMediaType &&
    ["imagePrompt", "videoPrompt"].includes(currentStage)
      ? selectedMediaJobs.find((job) => job.id === mediaPreviewSelection.jobId)
      : undefined;
  const focusedMediaCandidate = focusedMediaJob?.candidates.find(
    (candidate) => candidate.id === mediaPreviewSelection?.candidateId,
  );
  const focusedMediaCandidateIndex = focusedMediaJob?.candidates.findIndex(
    (candidate) => candidate.id === focusedMediaCandidate?.id,
  );
  const providerSubmitBlocker = !providerOverview.online
    ? "本机豆包 Provider 未启动"
    : automaticallyAssignProvider
      ? loggedInProviderAccounts.length < 1
        ? "请先登录至少一个豆包账号"
        : quotaEligibleProviderAccounts.length < 1 && currentStage === "videoPrompt"
          ? `本镜需要 ${selectedVideoSeconds} 秒视频额度，但已登录账号的剩余额度都不够（${loggedInProviderAccounts
              .map((account) => `${account.alias} ${accountQuotaLabel(account)}`)
              .join("；")}）；请换账号、把镜头拆短，或等次日额度重置`
          : ""
      : !selectedProviderAccount
        ? "请先选择豆包账号"
        : !selectedProviderAccount.enabled
          ? "所选账号已停用"
          : selectedProviderAccount.loginStatus !== "logged_in"
            ? "所选账号尚未登录"
            : "";
  const continuitySubmitBlocker =
    selectedMediaType === "image" &&
    continuityReferenceShot &&
    !continuityReferenceImage
      ? `请先为上一镜 ${shotDisplayLabel(shotDrafts, continuityReferenceShot.id)} 采用参考图`
      : "";
  const videoPromptSubmitBlocker =
    selectedMediaType === "video" && !selectedVideoPromptReady
      ? selectedStaleImage
        ? "参考图已过期（分镜或衔接来源已变化），请重新选图或确认保留"
        : selected.storyboardConfirmed
          ? videoTailMissingHintFor(selected) || "请先为当前镜头采用参考图"
          : "请先确认当前分镜"
      : "";
  const selectedVideoIdentityRequired =
    selectedMediaType === "video" &&
    selectedVideoReferencePlan.images.some((image) => image.role === "character") &&
    selectedVideoReferencePlan.images.some((image) => ["base", "continuity"].includes(image.role));
  const videoIdentitySubmitBlocker = selectedVideoIdentityRequired &&
    selectedVideoPromptShot.videoPromptPolished?.identityStatus !== "matched"
    ? "多人角色的视觉身份尚未确认；请等待官方角色图与本镜场景图匹配成功后再生成"
    : "";
  // 2026-09-17（用户拍板，二次修订）：润色未完成**不再禁用按钮**。
  // 旧规则是「没润色完就置灰」，问题是润色模型过载时按钮会被永久锁死、界面没有任何出口
  // （画面词失败后既不重试也不写 promptModel，判定永远是「尚未润色」）。
  // 新规则：按钮可点，点击 = 排队等待润色，润色一完成就自动提交豆包；
  // 失败会自动重试（10s / 30s 各一次），两次重试仍失败才把按钮还原并把原因交回用户。
  // 唯一仍然硬阻断的是「未连接文本模型」——那种情况下润色永远不会发生，等待没有意义。
  const selectedVideoPolishing = videoPromptPolishingIds.includes(selected.id);
  const polishNotConfiguredBlocker = !aiConfiguration.configured
    ? selectedMediaType === "image"
      ? "画面词尚未润色：请先在「配置」连接文本模型"
      : "视频词尚未润色：请先在「配置」连接文本模型"
    : "";
  const mediaPolishPending =
    selectedMediaType === "image"
      ? selectedImagePromptPolishing || !selectedImagePrompt?.promptModel
      : selectedVideoPolishing || !selectedVideoPromptFresh;
  /** 展示给用户的「为什么点了生成还没提交」说明；不再用作按钮禁用条件。 */
  const polishSubmitHint = !mediaPolishPending
    ? ""
    : selectedMediaType === "image"
      ? selectedImagePromptPolishing
        ? "画面词正在润色；点「生成」会自动排队，润色一完成就提交豆包"
        : "画面词尚未润色；点「生成」会先等润色完成，再提交豆包"
      : selectedVideoPolishing
        ? "视频词正在润色；点「生成」会自动排队，润色一完成就提交豆包"
        : "视频词尚未润色；点「生成」会先等润色完成，再提交豆包";
  const mediaSubmitBlocker =
    videoPromptSubmitBlocker ||
    (selectedVideoPromptFresh ? videoIdentitySubmitBlocker : "") ||
    continuitySubmitBlocker ||
    polishNotConfiguredBlocker ||
    providerSubmitBlocker;

  const announce = (message: string) => {
    setToast({ text: message });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  const clearToastTimer = () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  };

  /** 展开明细／手动关闭时停住自动消失；下一条通知或切换项目仍会照常收走它。 */
  const holdToast = () => clearToastTimer();

  const dismissToast = () => {
    clearToastTimer();
    setToast(null);
  };

  /**
   * 后台自动润色的**一条**汇总通知（2026-10-08）。
   *
   * 起因：润色是按镜头串行跑的，早先每镜完成各弹一条、每条只活 2.6 秒，后一条覆盖
   * 前一条。用户原话：「我一登录，右下角就会一直弹出这些提示，我根本不知道他发生了什么，
   * 也不知道他改动了哪些，他就全做完了」。现在整轮只弹一条，逐镜明细可展开，
   * 模板兜底的镜头会被点名——那是「润色没真正发生」的唯一肉眼信号。
   *
   * 停留时间按结果数放宽（每镜 1.2 秒、上限 15 秒）：要让人来得及展开看。
   */
  const finishAutoPolishBatch = () => {
    if (autoPolishDigestTimerRef.current !== null) {
      window.clearTimeout(autoPolishDigestTimerRef.current);
      autoPolishDigestTimerRef.current = null;
    }
    const digest = autoPolishBatchRef.current.take();
    if (!digest) return;
    setToast({ text: digest.message, detail: digest.detail, tone: digest.tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, Math.min(15_000, Math.max(4_000, digest.detail.length * 1_200)));
  };

  /**
   * 登记本轮要润的镜头；本轮第一次登记时起一个兜底计时器，防止某个请求挂死后
   * 汇总永远不结算（用户等到的是「什么都没有」，比一条明确的汇总更糟）。
   */
  const expectAutoPolish = (shotIds: string[]) => {
    const batch = autoPolishBatchRef.current;
    const wasIdle = batch.idle;
    batch.expect(shotIds);
    if (!wasIdle || autoPolishDigestTimerRef.current !== null) return;
    autoPolishDigestTimerRef.current = window.setTimeout(() => {
      autoPolishDigestTimerRef.current = null;
      finishAutoPolishBatch();
    }, AUTO_POLISH_DIGEST_TIMEOUT_MS);
  };

  /** 收一镜的结果；本轮收齐就立刻汇总，不必等兜底计时器。 */
  const recordAutoPolish = (shotId: string, outcome: AutoPolishOutcome) => {
    const batch = autoPolishBatchRef.current;
    batch.record(shotId, outcome);
    if (batch.settled) finishAutoPolishBatch();
  };

  /**
   * 这一镜不再等了（失败已达上限、或确定性拒收）。失败提示本身是可操作的，
   * 照旧单独弹，只把它从本轮的等待名单里摘掉。
   */
  const abandonAutoPolish = (shotId: string) => {
    autoPolishBatchRef.current.abandon(shotId);
  };

  const refreshProvider = useCallback(async () => {
    if (authStatus !== "authenticated") return undefined;
    const settingsResponse = await fetch("/api/media?resource=settings", {
      cache: "no-store",
    });
    const overview = await responseData<ProviderOverview>(settingsResponse);
    setProviderOverview(overview);
    setProviderBaseUrl(overview.baseUrl);
    if (!overview.online) return overview;
    const accountsResponse = await fetch("/api/media?resource=accounts", {
      cache: "no-store",
    });
    const { accounts } = await responseData<{ accounts: ProviderAccount[] }>(
      accountsResponse,
    );
    setProviderAccounts(accounts);
    setSelectedProviderAccountId((current) => {
      const saved =
        window.localStorage.getItem(MEDIA_ACCOUNT_KEY) || AUTO_PROVIDER_ACCOUNT_ID;
      const currentIsValid =
        current === AUTO_PROVIDER_ACCOUNT_ID ||
        accounts.some((account) => account.id === current);
      const savedIsValid =
        saved === AUTO_PROVIDER_ACCOUNT_ID ||
        accounts.some((account) => account.id === saved);
      const next = currentIsValid
        ? current
        : savedIsValid
          ? saved
          : AUTO_PROVIDER_ACCOUNT_ID;
      window.localStorage.setItem(MEDIA_ACCOUNT_KEY, next);
      return next;
    });
    return overview;
  }, [authStatus]);

  const refreshMediaJobs = useCallback(async () => {
    if (authStatus !== "authenticated" || !activeProjectId) return;
    const session = projectSessionRef.current;
    const request = ++mediaRequestRef.current;
    const response = await fetch(
      `/api/media?resource=jobs&projectId=${encodeURIComponent(activeProjectId)}`,
      { cache: "no-store" },
    );
    const { jobs } = await responseData<{ jobs: MediaJob[] }>(response);
    if (session === projectSessionRef.current && request === mediaRequestRef.current) setMediaJobs(jobs);
  }, [activeProjectId, authStatus]);

  const openNewProject = () => {
    setDraftProjectName("");
    setPendingProject(null);
    setNewProjectUploadStatus("idle");
    setNewProjectUploadSummary(null);
    setProjectDialogOpen(true);
  };

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const refreshProjectSummaries = useCallback(async () => {
    const summaries = await listProjects();
    setProjectSummaries(summaries);
    return summaries;
  }, [setProjectSummaries]);

  const resetProductionRequests = useCallback(() => {
    if (videoPromptAutoPolishTimerRef.current !== null) {
      window.clearTimeout(videoPromptAutoPolishTimerRef.current);
      videoPromptAutoPolishTimerRef.current = null;
    }
    imagePromptPolishLaneRef.current.reset();
    videoPromptPolishLaneRef.current.reset();
    polishStateRef.current.clear();
    polishStateRef.current.settleAll({ ok: false, error: "已切换项目" });
    setImagePromptPolishingIds([]);
    videoPromptAutoPolishRef.current.clear();
    // 切换项目时本轮汇总作废：它记的是上一个项目的镜头，弹出来只会误导。
    if (autoPolishDigestTimerRef.current !== null) {
      window.clearTimeout(autoPolishDigestTimerRef.current);
      autoPolishDigestTimerRef.current = null;
    }
    autoPolishBatchRef.current.take();
    setVideoPromptPolishingIds([]);
    setPendingMediaSubmit(null);
    setPendingMediaElapsed(0);
    setUnpolishedEscape(null);
    setMediaJobs([]);
    setMediaPreviewSelection(null);
    setMediaAction("");
    setMediaMessage("");
    setPendingMediaRejection(null);
    setMediaRejectionReason("");
    setMediaFeedbackProgress(null);
    setShotRevising(false);
    batchRuleInFlightRef.current = false;
    setBatchRuleLoading(false);
  }, []);

  const applyProjectSnapshot = useCallback((project: ProjectSnapshot) => {
    projectSessionRef.current += 1;
    activeProjectRef.current = project.id;
    resetProductionRequests();
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setDraftsLoaded(false);
    setAiExtractionReview(null);

    let nextShots = project.shotDrafts.length ? project.shotDrafts : shots;
    let nextPrompts = project.imagePromptDrafts.length
      ? project.imagePromptDrafts
      : imagePromptPackages;
    const nextCases = project.caseDrafts.length
      ? project.caseDrafts
      : extractedCases;
    const nextScript = project.scriptDrafts.length
      ? project.scriptDrafts
      : scriptParagraphs;
    nextShots = hydrateLegacyShotSources(nextShots, nextCases, nextScript);

    if (
      nextPrompts.length !== nextShots.length ||
      nextShots.some((shot) => shot.referenceId !== shot.id)
    ) {
      const previousShots = nextShots;
      nextShots = nextShots.map(shot => ({ ...shot, referenceId: shot.id }));
      nextPrompts = reconcileImagePrompts(nextShots, previousShots, nextPrompts);
    }

    const savedShotReferences = new Map(
      nextShots.map((shot) => [shot.referenceId ?? shot.id, shot]),
    );
    nextPrompts = nextPrompts.map((prompt) => {
      const savedShot = savedShotReferences.get(prompt.id);
      return !prompt.image && savedShot?.image && savedShot.status === "ready"
        ? { ...prompt, image: savedShot.image, status: "ready" }
        : prompt;
    });

    if (needsStoryboardRebuild(project)) {
      const rebuilt = rebuildStoryboard({
        cases: nextCases, paragraphs: nextScript, previousCases: nextCases,
        previousShots: nextShots, previousPrompts: nextPrompts,
        speechRate: project.speechRate, forceRebuild: true,
      });
      nextShots = rebuilt.shots;
      nextPrompts = rebuilt.prompts;
    }
    nextShots = withShotNumbers(nextShots);
    nextShots = recalculateShotTimings(nextShots, project.speechRate);

    // 存量项目里已经保存的旧尾帧提示词也要进入新的增量润色链路。
    // 仅清除模型标记即可：当前画面词阶段的补润 effect 会重新排队，图片资产不受影响。
    const shotById = new Map(nextShots.map((shot) => [shot.id, shot]));
    nextPrompts = nextPrompts.map((prompt) => {
      const shot = shotById.get(prompt.id);
      return shot && isLegacyContinuityImagePrompt(prompt, shot, nextShots)
        ? { ...prompt, promptModel: undefined }
        : prompt;
    });

    setActiveProjectId(project.id);
    setProjectCreatedAt(project.createdAt);
    setProjectName(project.title);
    setSourceFileName(project.sourceFileName);
    setCurrentStage(project.currentStage);
    setWorkflowStage(project.workflowStage);
    setSelectedId(
      nextShots.some((shot) => shot.id === project.selectedId)
        ? project.selectedId
        : nextShots[0].id,
    );
    setSelectedCaseId(
      nextCases.some((item) => item.id === project.selectedCaseId)
        ? project.selectedCaseId
        : nextCases[0].id,
    );
    setSelectedImagePromptId(
      nextPrompts.some((item) => item.id === project.selectedImagePromptId)
        ? project.selectedImagePromptId
        : nextPrompts[0].id,
    );
    setScriptDrafts(nextScript);
    setCaseDrafts(nextCases);
    setShotDrafts(nextShots);
    setImagePromptDrafts(nextPrompts);
    shotDraftsRef.current = nextShots;
    imagePromptDraftsRef.current = nextPrompts;
    setScriptReview(project.scriptReview);
    // 审核结果已随 scriptReview 持久化，这里按标记还原，避免重新打开项目后面板"消失"。
    const restoredAudit = scriptAuditFromReview(project.scriptReview);
    setScriptAudit(
      restoredAudit
        ? {
            status: "done",
            summary: restoredAudit.summary,
            items: restoredAudit.items,
            counts: restoredAudit.counts,
            dropped: restoredAudit.dropped,
            model: restoredAudit.model,
          }
        : null,
    );
    setExtractionEngine(publicEngineLabel(project.extractionEngine));
    setUploadedNames(project.uploadedNames);
    setProjectHistory(project.history);
    setAcceptanceRuns(project.acceptanceRuns);
    setSpeechRate(project.speechRate);
    setLastSavedAt(project.updatedAt);
    setSourceChanged(
      ["script", "cases", "scriptReview"].includes(project.workflowStage),
    );
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, project.id);
    window.requestAnimationFrame(() => setDraftsLoaded(true));
  }, [resetProductionRequests]);

  useEffect(() => {
    let cancelled = false;
    const legacyKeys = [
      SHOT_DRAFTS_KEY,
      CASE_DRAFTS_KEY,
      IMAGE_PROMPT_DRAFTS_KEY,
      SCRIPT_DRAFTS_KEY,
      SOURCE_FILE_KEY,
      WORKFLOW_STAGE_KEY,
      SCRIPT_REVIEW_KEY,
      EXTRACTION_ENGINE_KEY,
      PROJECT_NAME_KEY,
      STORYBOARD_RULE_VERSION_KEY,
    ];

    const initializeProjects = async () => {
      if (authStatus !== "authenticated") return;
      try {
        const requestedId =
          window.localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "";
        const workspace = await migrateLegacyProjects(requestedId);
        setReuseRules(workspace.rules);
        setReferenceAssets(workspace.assets);
        let summaries = await listProjects();
        let project =
          workspace.projects.find(
            (item) => item.id === workspace.activeProjectId,
          ) ??
          workspace.projects.find((item) => item.id === requestedId) ??
          workspace.projects[0] ??
          null;

        if (!project) {
          const hasLegacyDraft = legacyKeys.some((key) =>
            window.localStorage.getItem(key),
          );
          let legacyShots = shots;
          let legacyCases = extractedCases;
          let legacyPrompts = imagePromptPackages;
          let legacyScript = scriptParagraphs;
          let legacyReview = archivedScriptReview;
          let legacyStage: StageKey = "imagePrompt";
          let legacySource = stages[0].source;
          let legacyEngine = "脚本结构提取器 · 已审查归档";
          let legacyTitle = legacySource.replace(/\.docx$/iu, "");
          let legacyRuleVersion = STORYBOARD_RULE_VERSION;

          if (hasLegacyDraft) {
            try {
              const savedShots = JSON.parse(
                window.localStorage.getItem(SHOT_DRAFTS_KEY) ?? "null",
              );
              const savedCases = JSON.parse(
                window.localStorage.getItem(CASE_DRAFTS_KEY) ?? "null",
              );
              const savedPrompts = JSON.parse(
                window.localStorage.getItem(IMAGE_PROMPT_DRAFTS_KEY) ?? "null",
              );
              const savedScript = JSON.parse(
                window.localStorage.getItem(SCRIPT_DRAFTS_KEY) ?? "null",
              );
              const savedReview = JSON.parse(
                window.localStorage.getItem(SCRIPT_REVIEW_KEY) ?? "null",
              ) as ScriptReviewReport | null;
              if (Array.isArray(savedShots) && savedShots.length) {
                legacyShots = savedShots;
              }
              if (Array.isArray(savedCases) && savedCases.length) {
                legacyCases = savedCases;
              }
              if (Array.isArray(savedPrompts) && savedPrompts.length) {
                legacyPrompts = savedPrompts;
              }
              if (Array.isArray(savedScript) && savedScript.length) {
                legacyScript = savedScript;
              }
              if (savedReview?.status && Array.isArray(savedReview.flags)) {
                legacyReview = {
                  ...savedReview,
                  issues: Array.isArray(savedReview.issues)
                    ? savedReview.issues
                    : issuesFromFlags(savedReview.flags),
                };
              }
              const savedStage = window.localStorage.getItem(
                WORKFLOW_STAGE_KEY,
              ) as StageKey | null;
              if (savedStage && stages.some((item) => item.key === savedStage)) {
                legacyStage = savedStage;
              }
              legacySource =
                window.localStorage.getItem(SOURCE_FILE_KEY) ?? legacySource;
              legacyEngine =
                window.localStorage.getItem(EXTRACTION_ENGINE_KEY) ??
                legacyEngine;
              legacyTitle =
                window.localStorage.getItem(PROJECT_NAME_KEY) ??
                legacySource.replace(/\.docx$/iu, "");
              legacyRuleVersion =
                window.localStorage.getItem(STORYBOARD_RULE_VERSION_KEY) ?? "";
            } catch {
              // Keep the built-in project if a legacy JSON value is damaged.
            }
          }

          const now = new Date().toISOString();
          const history: ProjectHistoryEntry[] = [
            {
              id: createProjectId(),
              kind: hasLegacyDraft ? "imported" : "created",
              createdAt: now,
              title: hasLegacyDraft
                ? "已迁移旧版单项目草稿"
                : "已创建内置验收项目",
            },
          ];
          project = {
            schemaVersion: PROJECT_SCHEMA_VERSION,
            id: createProjectId(),
            title: legacyTitle,
            sourceFileName: legacySource,
            createdAt: now,
            updatedAt: now,
            currentStage: legacyStage,
            workflowStage: legacyStage,
            selectedId: legacyShots[0].id,
            selectedCaseId: legacyCases[0].id,
            selectedImagePromptId: legacyPrompts[0].id,
            scriptDrafts: legacyScript,
            caseDrafts: legacyCases,
            shotDrafts: legacyShots,
            imagePromptDrafts: legacyPrompts,
            scriptReview: legacyReview,
            extractionEngine: legacyEngine,
            storyboardRuleVersion: legacyRuleVersion,
            speechRate: SPEECH_UNITS_PER_SECOND,
            uploadedNames: {},
            history,
            acceptanceRuns: [],
          };
          await saveProject(project);
          summaries = await listProjects();
          if (hasLegacyDraft) {
            legacyKeys.forEach((key) => window.localStorage.removeItem(key));
          }
        }

        if (cancelled) return;
        setProjectSummaries(summaries);
        applyProjectSnapshot(project);
        // 刷新只恢复数据，默认先展示项目列表；由用户明确选择要进入的项目。
        setManagementPanel("projects");
      } catch {
        if (!cancelled) {
          setToast({ text: "项目存储初始化失败，本次页面仍可继续编辑" });
          setDraftsLoaded(true);
        }
      }
    };

    void initializeProjects();
    return () => {
      cancelled = true;
    };
  }, [applyProjectSnapshot, authStatus]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    const providerTimer = window.setTimeout(() => {
      void refreshProvider().catch((error) => {
        setProviderMessage(
          error instanceof Error ? error.message : "豆包 Provider 状态读取失败",
        );
      });
    }, 0);
    return () => window.clearTimeout(providerTimer);
  }, [authStatus, refreshProvider]);

  /**
   * 2026-09-16：视频任务的成败都会改变账号剩余额度（按秒消耗／额度用尽），
   * 所以任务落到终态时顺带刷新一次账号列表，免得下拉里还显示着过期的剩余秒数。
   */
  const quotaRefreshKeyRef = useRef("");
  useEffect(() => {
    const key = mediaJobs.map((job) => `${job.id}:${job.status}`).join("|");
    if (key === quotaRefreshKeyRef.current) return;
    quotaRefreshKeyRef.current = key;
    const hasTerminalVideo = mediaJobs.some(
      (job) =>
        job.mediaType === "video" &&
        ["succeeded", "failed"].includes(job.status),
    );
    if (hasTerminalVideo) {
      // 延后一拍再刷新：与上面首次拉取账号信息的写法一致，避免在 effect 同步 setState。
      const timer = window.setTimeout(() => {
        void refreshProvider().catch(() => undefined);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [mediaJobs, refreshProvider]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !activeProjectId || !["imagePrompt", "videoPrompt"].includes(currentStage)) {
      return;
    }
    const key = `${projectSessionRef.current}:${activeProjectId}`;
    if (mediaMaintenanceRef.current.has(key)) return;
    mediaMaintenanceRef.current.add(key);
    void fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "maintain-jobs" }),
    })
      .then((response) => responseData<{ maintained: boolean }>(response))
      .then(({ maintained }) => maintained ? refreshMediaJobs() : undefined)
      .catch(() => undefined);
  }, [activeProjectId, authStatus, currentStage, refreshMediaJobs]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !activeProjectId || !["imagePrompt", "videoPrompt"].includes(currentStage)) {
      return;
    }
    const initialTimer = window.setTimeout(() => {
      void refreshMediaJobs().catch(() => undefined);
    }, 0);
    const pollingTimer = window.setInterval(() => {
      void refreshMediaJobs().catch(() => undefined);
    }, 5_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(pollingTimer);
    };
  }, [activeProjectId, authStatus, currentStage, refreshMediaJobs]);

  const buildCurrentProjectSnapshot = useCallback((
    updatedAt = new Date().toISOString(),
  ): ProjectSnapshot => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: activeProjectId,
    title: projectTitle,
    sourceFileName,
    createdAt: projectCreatedAt,
    updatedAt,
    currentStage,
    workflowStage,
    selectedId,
    selectedCaseId,
    selectedImagePromptId,
    scriptDrafts,
    caseDrafts,
    shotDrafts,
    imagePromptDrafts,
    scriptReview,
    extractionEngine,
    storyboardRuleVersion: STORYBOARD_RULE_VERSION,
    speechRate,
    uploadedNames,
    history: projectHistory,
    acceptanceRuns,
  }), [activeProjectId, projectTitle, sourceFileName, projectCreatedAt, currentStage, workflowStage,
    selectedId, selectedCaseId, selectedImagePromptId, scriptDrafts, caseDrafts, shotDrafts,
    imagePromptDrafts, scriptReview, extractionEngine, speechRate, uploadedNames,
    projectHistory, acceptanceRuns]);

  useEffect(() => {
    if (!draftsLoaded || !activeProjectId || !projectCreatedAt) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(() => {
      const updatedAt = new Date().toISOString();
      const snapshot = buildCurrentProjectSnapshot(updatedAt);
      const session = projectSessionRef.current;
      void saveProject(snapshot)
        .then((workspace) => {
          if (session !== projectSessionRef.current) return;
          setLastSavedAt(updatedAt);
          setProjectSummaries(summarizeProjects(workspace.projects));
        })
        .catch(() => setToast({ text: "自动保存失败，请先导出项目备份" }));
    }, 650);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [activeProjectId, projectCreatedAt, draftsLoaded, buildCurrentProjectSnapshot]);
  const invalidateImagePromptPolish = (ids: string[]) => {
    ids.forEach((id) => {
      // 素材改动必须废弃旧请求，并清掉重试/耗尽状态以便按最新输入重新润色。
      polishStateRef.current.invalidate("image", id);
      polishStateRef.current.reset("image", id);
    });
    setImagePromptPolishingIds((current) =>
      current.filter((id) => !ids.includes(id)),
    );
  };

  const rebuildCurrentStoryboard = (cases: ExtractedCase[], paragraphs: ScriptParagraph[]) =>
    rebuildStoryboard({ cases, paragraphs, previousCases: caseDrafts,
      previousShots: shotDrafts, previousPrompts: imagePromptDrafts, speechRate });

  const applyStoryboardWork = (proposed: { shots: Shot[]; prompts: ImagePromptPackage[] }) => {
    const previousShots = shotDraftsRef.current;
    const previousPrompts = imagePromptDraftsRef.current;
    const next = reconcileStoryboardDependencies(previousShots, previousPrompts, proposed);
    const alive = new Set(next.shots.map(shot => shot.id));
    const changed = [...new Set([...next.affectedIds, ...previousShots.filter(old => {
      const shot = next.shots.find(item => item.id === old.id);
      return !shot || videoPromptSourceSignature(shot) !== videoPromptSourceSignature(old) ||
        imagePromptInputSignature(shot, next.shots) !== imagePromptInputSignature(old, previousShots);
    }).map(shot => shot.id)])];
    invalidateImagePromptPolish(changed);
    for (const id of changed) {
      polishStateRef.current.invalidate("video", id);
      polishStateRef.current.reset("video", id);
      videoPromptAutoPolishRef.current.delete(id);
      abandonAutoPolish(id);
      const error = alive.has(id) ? "分镜素材已修改，请检查并确认分镜后重新生成" : "镜头已被删除或合并";
      settlePolishWaiters("image", id, { ok: false, error });
      settlePolishWaiters("video", id, { ok: false, error });
    }
    setVideoPromptPolishingIds(current => current.filter(id => !changed.includes(id)));
    shotDraftsRef.current = next.shots;
    imagePromptDraftsRef.current = next.prompts;
    setShotDrafts(next.shots);
    setImagePromptDrafts(next.prompts);
    setUploadedNames(current => Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id))));
    setSelectedId(current => alive.has(current) ? current : next.shots[0]?.id ?? "");
    setSelectedImagePromptId(current => next.prompts.some(prompt => prompt.id === current) ? current : next.prompts[0]?.id ?? "");
  };

  // 手改、规则、素材说明、批量更新和反馈重写都经过这里；模型结果也通过同一写入边界。
  const updateImagePrompts = (
    update: (current: ImagePromptPackage[]) => ImagePromptPackage[],
    options?: { generated?: boolean },
  ) => {
    const previous = imagePromptDraftsRef.current;
    const proposed = update(previous);
    const changed = proposed.filter(prompt => {
      const old = previous.find(item => item.id === prompt.id);
      return old && (old.prompt !== prompt.prompt || old.promptModel !== prompt.promptModel);
    }).map(prompt => prompt.id);
    invalidateImagePromptPolish(changed);
    if (!options?.generated) {
      for (const id of changed) settlePolishWaiters("image", id, { ok: false, error: "画面要求已修改，请检查后重新生成" });
    }
    const prompts = proposed.map(prompt => !options?.generated && changed.includes(prompt.id) && prompt.image
      ? { ...prompt, imageNeedsReview: true } : prompt);
    applyStoryboardWork({ shots: shotDraftsRef.current, prompts });
  };

  const beginImagePromptRewrite = (id: string) => {
    invalidateImagePromptPolish([id]);
    const version = polishStateRef.current.begin("image", id);
    setImagePromptPolishingIds(current => current.includes(id) ? current : [...current, id]);
    return version;
  };

  const updateSelectedShot = (update: (shot: Shot) => Shot) => {
    const previous = shotDraftsRef.current;
    const nextShots = previous.map(shot => shot.id === selectedId ? applyShotEdit(shot, update(shot)) : shot);
    applyStoryboardWork({ shots: nextShots, prompts: reconcileImagePrompts(nextShots, previous, imagePromptDraftsRef.current) });
    if (currentStage === "storyboard") setWorkflowStage("storyboard");
  };

  const updateDialogue = (dialogue: string) => {
    updateSelectedShot((shot) =>
      recalculateShotTiming({ ...shot, dialogue }, speechRate),
    );
  };

  /**
   * 分镜反馈渠道（2026-09-17）：机械拆分只能保证台词与案例事实对齐，画面信息
   * （谁在场、场景长什么样、动作链）经常不完整——例如两人对话场景只写了一个人。
   * 用户用自然语言指出问题，AI 重写 speaker/location/action/continuity；
   * 台词引号内逐字保护由服务端校验（shotRevisionDialoguePreserved）。
   * 应用走 updateSelectedShot 同款级联：storyboard 阶段自动重置确认状态并失效下游润色。
   */
  const reviseSelectedShotWithAi = async () => {
    const session = projectSessionRef.current;
    const original = videoSignatureFor(selected);
    const feedback = shotReviseFeedback.trim();
    if (!feedback) {
      announce("请先填写要让 AI 修改的内容");
      return;
    }
    if (shotRevising) return;
    setShotRevising(true);
    try {
      const caseContext = selected.caseId
        ? shotDrafts
            .filter(
              (item) => item.caseId === selected.caseId && item.id !== selected.id,
            )
            .slice(0, 4)
            .map((item) =>
              `${shotDisplayLabel(shotDrafts, item.id)}：出场 ${item.speaker}；场景 ${item.location}；对白 ${item.dialogue.slice(0, 60)}`,
            )
            .join("\n")
        : "";
      const response = await fetch("/api/ai/shot-revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectTitle,
          feedback,
          caseContext,
          shot: {
            id: selected.id,
            speaker: selected.speaker,
            location: selected.location,
            dialogue: selected.dialogue,
            action: selected.action,
            continuity: selected.continuity,
          },
        }),
      });
      const data = await responseData<{
        revision: {
          speaker: string;
          location: string;
          dialogue: string;
          action: string[];
          continuity: string;
        };
        note: string;
        model: string;
      }>(response);
      if (session !== projectSessionRef.current) return;
      const latest = shotDraftsRef.current.find(shot => shot.id === selected.id);
      if (!latest || latestVideoSignatureFor(latest) !== original) {
        announce("该镜头已发生修改，旧分镜重写结果未覆盖当前内容");
        return;
      }
      updateSelectedShot((shot) =>
        recalculateShotTiming(
          {
            ...shot,
            speaker: data.revision.speaker,
            location: data.revision.location,
            dialogue: data.revision.dialogue,
            action: data.revision.action,
            continuity: data.revision.continuity,
            prompt: { ...shot.prompt, action: data.revision.action.join("→") },
          },
          speechRate,
        ),
      );
      setShotReviseFeedback("");
      announce(
        data.note
          ? `已按反馈重写分镜：${data.note}`
          : "已按反馈重写分镜，台词逐字保留；请检查后重新确认",
      );
    } catch (error) {
      if (session !== projectSessionRef.current) return;
      announce(error instanceof Error ? error.message : "AI 修改分镜失败");
    } finally {
      if (session === projectSessionRef.current) setShotRevising(false);
    }
  };

  const applyProjectSpeechRate = (nextRate: number) => {
    const normalized = normalizeSpeechRate(nextRate);
    setSpeechRate(normalized);
    applyStoryboardWork({ shots: recalculateShotTimings(shotDraftsRef.current, normalized), prompts: imagePromptDraftsRef.current });
    announce(`项目默认口播已改为${speechRateLabel(normalized)}节奏`);
  };

  const applyShotSpeechRate = (value: string) => {
    const override = value === "project" ? undefined : normalizeSpeechRate(Number(value));
    applyStoryboardWork({ shots: shotDraftsRef.current.map((shot) =>
        shot.id === selectedId
          ? recalculateShotTiming(
              { ...shot, speechRateOverride: override },
              speechRate,
            )
          : shot,
      ), prompts: imagePromptDraftsRef.current });
    announce(
      override === undefined
        ? `${selectedDisplayLabel} 已恢复跟随项目节奏`
        : `${selectedDisplayLabel} 已使用${speechRateLabel(override)}节奏`,
    );
  };

  const createSpeechRateRuleCandidate = async () => {
    if (selected.speechRateOverride === undefined) {
      announce("请先为本镜选择不同于项目默认的口播节奏");
      return;
    }
    const now = new Date().toISOString();
    const rate = normalizeSpeechRate(selected.speechRateOverride);
    const entry: ProjectHistoryEntry = {
      id: createProjectId(),
      kind: "feedback",
      createdAt: now,
      title: `已记录${speechRateLabel(rate)}口播节奏`,
      stage: "storyboard",
      targetId: selected.id,
      issueType: "口播节奏",
      reason: `${selected.title} 使用${speechRateLabel(rate)}节奏更合适`,
      after: `${rate} 字/秒`,
      decision: "adopted",
    };
    const rule: ReuseRule = {
      id: createProjectId(),
      createdAt: now,
      updatedAt: now,
      title: `${selected.title} · ${speechRateLabel(rate)}口播`,
      instruction: `相似分镜优先使用${speechRateLabel(rate)}口播节奏（${rate} 字/秒），应用前由人工确认。`,
      stage: "storyboard",
      issueType: "口播节奏",
      scope: "project",
      status: "candidate",
      keywords: inferAssetTags(
        selected.title,
        `${selected.chapter} ${selected.dialogue} ${selected.location}`,
      ),
      sourceProjectId: activeProjectId,
      sourceHistoryId: entry.id,
      projectId: activeProjectId,
      adoptedCount: 0,
      rejectedCount: 0,
      speechRate: rate,
    };
    try {
      setProjectHistory((current) => [entry, ...current]);
      const workspace = await saveReuseRule(rule);
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      announce("已沉淀为待审核的口播节奏规则");
    } catch (error) {
      announce(error instanceof Error ? error.message : "口播节奏规则保存失败");
    }
  };

  const applySpeechRateRule = async (rule: ReuseRule) => {
    if (rule.speechRate === undefined) return;
    const session = projectSessionRef.current;
    applyStoryboardWork({ shots: shotDraftsRef.current.map((shot) =>
        shot.id === selectedId
          ? recalculateShotTiming(
              { ...shot, speechRateOverride: rule.speechRate },
              speechRate,
            )
          : shot,
      ), prompts: imagePromptDraftsRef.current });
    try {
      const workspace = await recordRuleDecision(rule.id, "adopted");
      if (session !== projectSessionRef.current) return;
      setReuseRules(workspace.rules);
      announce(`已应用${speechRateLabel(rule.speechRate)}口播规则并记录采用`);
    } catch {
      announce("节奏已应用，但采用次数保存失败");
    }
  };

  const rejectSpeechRateRule = async (rule: ReuseRule) => {
    try {
      const workspace = await recordRuleDecision(rule.id, "rejected");
      setReuseRules(workspace.rules);
      announce("已记录这条口播规则不适用于当前分镜");
    } catch {
      announce("不适用记录保存失败");
    }
  };

  const updateAction = (index: number, value: string) => {
    updateSelectedShot((shot) => {
      const action = shot.action.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      );
      return {
        ...shot,
        action,
        prompt: { ...shot.prompt, action: action.join("→") },
      };
    });
  };

  const addAction = () => {
    updateSelectedShot((shot) => {
      const action = [...shot.action, "补充必要动作"];
      return {
        ...shot,
        action,
        prompt: { ...shot.prompt, action: action.join("→") },
      };
    });
  };

  const removeAction = (index: number) => {
    updateSelectedShot((shot) => {
      const action = shot.action.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...shot,
        action,
        prompt: { ...shot.prompt, action: action.join("→") },
      };
    });
  };

  const moveAction = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    updateSelectedShot((shot) => {
      const action = reorderActions(shot.action, fromIndex, toIndex);
      return {
        ...shot,
        action,
        prompt: { ...shot.prompt, action: action.join("→") },
      };
    });
    announce(`已将第 ${fromIndex + 1} 个动作移到第 ${toIndex + 1} 位`);
  };

  const resetSelectedShot = () => {
    const sourceCase = caseDrafts.find(item => item.id === shotCaseId(selected));
    if (!sourceCase || !selected.sourceItems?.length) return;
    const [original] = buildCaseShots(sourceCase, [selected.sourceItems]);
    updateSelectedShot(current => ({ ...original, id: current.id, referenceId: current.id,
      image: current.image, status: current.status, confirmedSnapshot: current.confirmedSnapshot }));
    announce(`${selectedDisplayLabel} 已恢复为本项目原文内容，请重新确认`);
  };

  const copyText = async (text: string, success: string) => {
    try {
      await navigator.clipboard.writeText(text);
      announce(success);
    } catch {
      announce("浏览器未允许复制，请在右侧文本框中手动选择");
    }
  };


  const persistCurrentProject = async () => {
    if (!activeProjectId || !projectCreatedAt) return;
    const snapshot = buildCurrentProjectSnapshot();
    await saveProject(snapshot);
    setLastSavedAt(snapshot.updatedAt);
  };

  const switchProject = async (id: string) => {
    if (id === activeProjectId) {
      setManagementPanel("content");
      return;
    }
    try {
      await persistCurrentProject();
      await setActiveProject(id);
      const project = await getProject(id);
      if (!project) throw new Error("要切换的项目不存在");
      applyProjectSnapshot(project);
      setManagementPanel(null);
      announce(`已切换到“${project.title}”`);
    } catch (error) {
      announce(error instanceof Error ? error.message : "项目切换失败");
    }
  };

  const confirmNewProject = async () => {
    if (!pendingProject) return;
    try {
      await persistCurrentProject();
      const now = new Date().toISOString();
      const title =
        draftProjectName.trim() || pendingProject.fileName.replace(/\.docx$/iu, "");
      const project: ProjectSnapshot = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: createProjectId(),
        title,
        sourceFileName: pendingProject.fileName,
        createdAt: now,
        updatedAt: now,
        currentStage: "script",
        workflowStage: "script",
        selectedId: pendingProject.shots[0].id,
        selectedCaseId: pendingProject.cases[0].id,
        selectedImagePromptId: pendingProject.prompts[0].id,
        scriptDrafts: pendingProject.paragraphs,
        caseDrafts: pendingProject.cases,
        shotDrafts: pendingProject.shots,
        imagePromptDrafts: pendingProject.prompts,
        scriptReview:
          pendingProject.audit &&
          pendingProject.audit.status === "done" &&
          pendingProject.audit.items.length
            ? scriptAuditReview(pendingProject.review, pendingProject.audit)
            : pendingProject.review,
        extractionEngine: pendingProject.extractionEngine,
        storyboardRuleVersion: STORYBOARD_RULE_VERSION,
        speechRate: SPEECH_UNITS_PER_SECOND,
        uploadedNames: {},
        history: [
          {
            id: createProjectId(),
            kind: "created",
            createdAt: now,
            title: "已从 Word 创建项目",
            stage: "script",
            reason: pendingProject.fileName,
          },
          ],
        acceptanceRuns: [],
      };
      await saveProject(project);
      await refreshProjectSummaries();
      applyProjectSnapshot(project);
      setProjectDialogOpen(false);
      setPendingProject(null);
      announce("项目已创建，Word 原文与提取结果已载入");
    } catch {
      announce("项目创建失败，请保留当前页面并重试");
    }
  };

  const exportCurrentProject = async () => {
    if (!activeProjectId) return;
    try {
      const snapshot = buildCurrentProjectSnapshot();
      await saveProject(snapshot);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeTitle = projectTitle.replace(/[\\/:*?"<>|]/gu, "-");
      link.href = url;
      link.download = `${safeTitle}.ai-video-project.json`;
      link.click();
      URL.revokeObjectURL(url);
      setLastSavedAt(snapshot.updatedAt);
      announce("完整项目备份已导出");
    } catch {
      announce("导出失败，请稍后重试");
    }
  };

  const exportWholeWorkspace = async () => {
    try {
      await persistCurrentProject();
      const workspace = await loadWorkspace();
      const blob = new Blob([JSON.stringify(workspace, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `AI科普动画生产工作台-${new Date().toISOString().slice(0, 10)}.ai-video-workspace.json`;
      link.click();
      URL.revokeObjectURL(url);
      announce(`整个工作台已导出：${workspace.projects.length} 个项目`);
    } catch (error) {
      announce(error instanceof Error ? error.message : "整个工作台导出失败");
    }
  };

  const importWorkspaceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await persistCurrentProject();
      const incoming = normalizeWorkspaceSnapshot(JSON.parse(await file.text()));
      const workspace = await mergeWorkspaceBackup(incoming);
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      setProjectSummaries(
        workspace.projects.map(
          ({ id, title, sourceFileName, createdAt, updatedAt, workflowStage }) => ({
            id,
            title,
            sourceFileName,
            createdAt,
            updatedAt,
            workflowStage,
          }),
        ),
      );
      const project =
        workspace.projects.find((item) => item.id === workspace.activeProjectId) ??
        workspace.projects[0];
      applyProjectSnapshot(project);
      setManagementPanel(null);
      announce(`工作台备份已合并恢复：${workspace.projects.length} 个项目`);
    } catch (error) {
      announce(error instanceof Error ? error.message : "工作台备份导入失败");
    } finally {
      event.target.value = "";
    }
  };

  const saveAiSettings = async () => {
    if (await saveAiConnection()) announce("模型连接已保存");
  };
  const saveVisionSettings = async () => {
    if (await saveVisionConnection()) announce("视觉模型连接已保存");
  };

  const postMedia = async <T,>(body: Record<string, unknown>) =>
    responseData<T>(
      await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const saveProviderSettings = async () => {
    setProviderAction("save-settings");
    setProviderMessage("正在保存并检查本机 Provider…");
    try {
      const overview = await postMedia<ProviderOverview>({
        operation: "save-settings",
        baseUrl: providerBaseUrl,
      });
      setProviderOverview(overview);
      setProviderBaseUrl(overview.baseUrl);
      setProviderMessage(
        overview.online
          ? "Provider 已连接，可以配置账号。"
          : overview.error || "地址已保存，但 Provider 尚未启动。",
      );
      if (overview.online) await refreshProvider();
    } catch (error) {
      setProviderMessage(
        error instanceof Error ? error.message : "Provider 设置保存失败",
      );
    } finally {
      setProviderAction("");
    }
  };

  const startProvider = async () => {
    setProviderAction("start-provider");
    setProviderMessage("正在启动本机 Provider…");
    try {
      const overview = await postMedia<ProviderOverview>({
        operation: "start-provider",
      });
      setProviderOverview(overview);
      await refreshProvider();
      setProviderMessage("Provider 已启动，可以创建或登录豆包账号。");
    } catch (error) {
      setProviderMessage(
        error instanceof Error ? error.message : "Provider 启动失败",
      );
    } finally {
      setProviderAction("");
    }
  };

  const addProviderAccount = async () => {
    if (!newProviderAccountName.trim()) {
      setProviderMessage("请先填写账号名称，例如“豆包账号 A”。");
      return;
    }
    setProviderAction("create-account");
    setProviderMessage("正在创建隔离账号 profile…");
    try {
      const account = await postMedia<ProviderAccount>({
        operation: "create-account",
        displayName: newProviderAccountName.trim(),
      });
      setNewProviderAccountName("");
      setSelectedProviderAccountId(account.id);
      window.localStorage.setItem(MEDIA_ACCOUNT_KEY, account.id);
      await refreshProvider();
      setProviderMessage(`已创建“${account.alias}”，下一步请完成登录。`);
    } catch (error) {
      setProviderMessage(error instanceof Error ? error.message : "账号创建失败");
    } finally {
      setProviderAction("");
    }
  };

  const runAccountAction = async (
    account: ProviderAccount,
    operation: "check-account" | "login-account",
  ) => {
    setProviderAction(`${operation}:${account.id}`);
    setProviderMessage(
      operation === "login-account"
        ? `正在打开“${account.alias}”的独立登录窗口…`
        : `正在检查“${account.alias}”的登录状态…`,
    );
    try {
      const result = await postMedia<{
        loggedIn: boolean;
        reason?: string;
        quotaText?: string;
      }>({ operation, accountId: account.id });
      await refreshProvider();
      setProviderMessage(
        result.loggedIn
          ? `“${account.alias}”已登录${result.quotaText ? ` · ${result.quotaText}` : ""}`
          : result.reason || `“${account.alias}”尚未登录`,
      );
    } catch (error) {
      setProviderMessage(
        error instanceof Error ? error.message : "账号状态检查失败",
      );
    } finally {
      setProviderAction("");
    }
  };

  const replaceMediaJob = (job: MediaJob) => {
    if (job.projectId !== activeProjectRef.current) return;
    mediaRequestRef.current += 1;
    setMediaJobs((current) => [
      job,
      ...current.filter((item) => item.id !== job.id),
    ]);
  };

  const buildCleanImagePromptFallbacks = (
    sourceShots: Shot[],
    existingPrompts: ImagePromptPackage[],
    availableRules = reuseRules,
  ): ImagePromptPackage[] => {
    const existingById = new Map(existingPrompts.map((prompt) => [prompt.id, prompt]));
    return buildImagePrompts(sourceShots).map((prompt) => {
      const shot = sourceShots.find((candidate) => candidate.id === prompt.id);
      const existing = existingById.get(prompt.id);
      const matched = matchReuseRules(availableRules, {
        projectId: activeProjectId,
        stage: "imagePrompt",
        text: [
          prompt.title,
          shot?.location,
          shot?.speaker,
          shot?.dialogue,
          shot?.action,
          shot?.continuity,
        ].filter(Boolean).join(" "),
      });
      return {
        ...prompt,
        image: existing?.image,
        status: existing?.image ? existing.status : "missing" as const,
        mediaSource: existing?.mediaSource,
        imageSourceSignature: existing?.imageSourceSignature,
        imageNeedsReview: existing?.imageNeedsReview,
        prompt: appendRulesToPrompt(prompt.prompt, matched),
        promptModel: undefined,
      };
    });
  };

  const requestPolishedImagePrompts = async (
    prompts: ImagePromptPackage[],
    sourceShots: Shot[],
    availableRules = reuseRules,
    continuityShots: Shot[] = sourceShots,
  ) => {
    const fallbackById = new Map(
      prompts.map((prompt) => [prompt.id, cleanImagePromptForProvider(prompt.prompt)]),
    );
    const briefs: ImagePromptBrief[] = sourceShots.map((shot) => {
      const context = [
        shot.title,
        shot.location,
        shot.speaker,
        shot.dialogue,
        shot.action.join(" "),
        shot.continuity,
      ].filter(Boolean).join(" ");
      const rules = matchReuseRules(availableRules, {
        projectId: activeProjectId,
        stage: "imagePrompt",
        text: context,
      });
      const bindings = rules
        .map((rule) =>
          parseCharacterBindingInstruction(rule.title) ??
          parseCharacterBindingInstruction(rule.instruction),
        )
        .filter((binding): binding is { sourceRole: string; targetRole: string } => Boolean(binding));
      const characterAssets = referenceAssets
        .filter(
          (asset) =>
            asset.kind === "character" &&
            asset.roleName &&
            (context.includes(asset.roleName) ||
              bindings.some(
                (binding) =>
                  binding.targetRole.replace(/\s+/gu, "") ===
                  asset.roleName!.replace(/\s+/gu, ""),
              )),
        )
        .map((asset) => {
          const binding = bindings.find(
            (item) =>
              item.targetRole.replace(/\s+/gu, "") ===
              asset.roleName!.replace(/\s+/gu, ""),
          );
          return binding
            ? `已上传“${asset.title}”，用于锁定${binding.sourceRole}的人物外观`
            : `已上传“${asset.title}”，用于锁定${asset.roleName}的人物外观`;
        });
      // A single-shot polish request still needs the complete storyboard to
      // resolve "延续 S2-E1-01" (the previous implementation only received
      // `[shot]`, so every queued request was incorrectly treated as a fresh
      // prompt and the old action-heavy template came back).
      const styleAnchored = Boolean(findContinuityReferenceShot(continuityShots, shot.id));
      const promptActions = styleAnchored
        ? continuityVisualActions(shot, cleanImagePromptAction(shot.location))
        : shot.action.map(cleanImagePromptAction).filter(Boolean);
      return {
        id: shot.id,
        title: shot.title,
        scene: shot.location,
        characters: shot.speaker,
        dialogue: shot.dialogue,
        actions: promptActions,
        continuity: shot.continuity,
        rules: rules.map((rule) => `${rule.title}：${rule.instruction}`),
        referenceAssets: styleAnchored
          ? ["参考图为上一镜已选画面，画风与人物场景以它为准"]
          : [
              ...(referenceAssets.some((asset) => asset.kind === "style")
                ? ["已上传MG插画风格参考图，仅作画风与人物画法示范，图中人物不出场"]
                : []),
              ...characterAssets,
            ],
        fallbackPrompt: fallbackById.get(shot.id) ?? "",
        styleAnchored,
      };
    });
    const response = await fetchJsonWithTimeout(
      "/api/ai/image-prompts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectTitle, shots: briefs }),
      },
      "画面词润色",
    );
    const data = await responseData<{
      prompts: Array<{ id: string; prompt: string }>;
      model: string;
    }>(response);
    const polished = new Map(data.prompts.map((item) => [item.id, item.prompt]));
    return prompts.map((prompt) => ({
      ...prompt,
      prompt: polished.get(prompt.id) ?? cleanImagePromptForProvider(prompt.prompt),
      promptModel: polished.has(prompt.id) ? data.model : undefined,
    }));
  };

  /**
   * 2026-09-17「排队等润色」的等待者结算。
   * 润色成功、重试耗尽、或切换项目时调用；只有第一次结算生效（结算后即从表里摘掉）。
   * `rejected` 标记「模型违反内容规则」的确定性拒收，供结果文案区分建议（重试 vs 直接提交）。
   */
  const settlePolishWaiters = (
    kind: PolishKind,
    shotId: string,
    result: PolishResult,
  ) => {
    polishStateRef.current.settle(kind, shotId, result);
  };

  /**
   * 确定性拒收的收口（2026-09-17；2026-09-30 扩展到素材缺字段）：
   * 模型违反内容硬规则、或本镜素材不满足最低契约时**不做退避重试**——同样的输入重发
   * 必然同样失败，盲目重试只会让用户白等 40 秒，还把真实病因报成含糊的「重试也没成功」。
   * 这里直接标记耗尽、结算等待者，把真实原因原样交回用户，由他决定补齐素材还是手动重试。
   */
  const settleRejectedPolish = (
    kind: "image" | "video",
    shotId: string,
    reason: string,
    code: string,
  ) => {
    polishStateRef.current.exhaust(kind, shotId, {
      ok: false,
      error: reason,
      rejected: true,
      code,
    });
  };

  /** 是否属于「重发同样输入必然同样失败」的确定性拒收（模型违规或素材缺字段）。 */
  const isRejectedPolishError = (error: unknown): error is AiRequestError =>
    error instanceof AiRequestError && isDeterministicRejectionCode(error.code);

  /**
   * 确定性拒收的提示语。两类失败对用户意味着完全不同的下一步：
   *  - 模型违规：可以「用模板提交」绕过；
   *  - 素材缺字段：模板也补不出场景/动作，必须回去补字段，所以不引导他去点模板提交。
   *
   * 2026-10-08 二轮：服务端文案不再带镜头编号（它拿不到分镜列表、算不出顺序号），
   * 「是哪一镜」由这里补**对外展示的编号**——用户照着界面找得到。
   */
  const rejectionAnnouncement = (error: AiRequestError, shotId: string) =>
    `${shotDisplayLabel(shotDraftsRef.current, shotId)}：` +
    (error.code === AI_INPUT_REJECTED_CODE
      ? `${error.message}；这一镜的素材不完整，重发也不会成功，请先补齐该镜场景与动作`
      : `${error.message}；属模型违反内容规则，已停止自动重试，可直接用模板提交`);

  /** 登记一个等待者：等这一镜的润色出结果（成功或重试耗尽）。 */
  const awaitPolish = (kind: PolishKind, shotId: string) =>
    polishStateRef.current.waitFor(kind, shotId);

  /**
   * 画面词润色入队。
   * 2026-09-17 补齐三件事（此前画面词是三种润色里唯一完全不自救的）：
   *  1. 失败后与视频词同款自驱动重试（10s / 30s 各一次）；
   *  2. 重试耗尽即结算等待者，把原因交回「生成」按钮，不再让界面停在「润色中」；
   *  3. 支持 `priority`——用户点了「生成」的那一镜插队到队首优先润色。
   */
  const queueImagePromptPolish = (
    shot: Shot,
    fallbackPrompt: ImagePromptPackage,
    options?: { silent?: boolean; priority?: boolean },
  ) => {
    if (!aiConfiguration.configured) {
      if (!options?.silent) {
        announce("尚未连接文本模型，无法润色画面词；请先在「配置」完成连接");
      }
      return;
    }
    const session = projectSessionRef.current;
    const version = polishStateRef.current.begin("image", shot.id);
    setImagePromptPolishingIds((current) =>
      current.includes(shot.id) ? current : [...current, shot.id],
    );

    const scheduleAutoRetry = (reason: string) => {
      const fails = polishStateRef.current.recordRetry("image", shot.id);
      if (fails > POLISH_RETRY_DELAYS_MS.length) {
        polishStateRef.current.exhaust("image", shot.id, { ok: false, error: reason });
        announce(
          `${shotDisplayLabel(shotDraftsRef.current, shot.id)} 画面词${reason}；已重试 ${POLISH_RETRY_DELAYS_MS.length} 次仍未成功，停止自动重试——可改素材或重新点「生成」`,
        );
        return;
      }
      const delay = POLISH_RETRY_DELAYS_MS[fails - 1];
      announce(
        `${shotDisplayLabel(shotDraftsRef.current, shot.id)} 画面词${reason}；${delay / 1000} 秒后自动重试（第 ${fails}/${POLISH_RETRY_DELAYS_MS.length} 次）`,
      );
      window.setTimeout(() => {
        if (projectSessionRef.current !== session || !polishStateRef.current.isCurrent("image", shot.id, version)) return;
        // 必须按「重试触发那一刻」的素材重润，否则会把改之前的旧内容润成一份看似新的结果。
        const latestShot = shotDraftsRef.current.find((item) => item.id === shot.id);
        const latestDraft = imagePromptDraftsRef.current.find(
          (item) => item.id === shot.id,
        );
        if (!latestShot || !latestDraft) return;
        if (latestDraft.promptModel) {
          settlePolishWaiters("image", shot.id, { ok: true });
          return;
        }
        queueImagePromptPolish(latestShot, latestDraft, { silent: true });
      }, delay);
    };

    const run = async () => {
      if (session !== projectSessionRef.current || !polishStateRef.current.isCurrent("image", shot.id, version)) return;
      try {
        const [polished] = await requestPolishedImagePrompts(
          [fallbackPrompt],
          [shot],
          reuseRules,
          shotDraftsRef.current,
        );
        if (
          session !== projectSessionRef.current ||
          !polishStateRef.current.isCurrent("image", shot.id, version)
        ) {
          // 请求期间素材被改过 → 这份润色已过期，丢弃；新素材会自己重新入队，
          // 等待者继续等，不在这里结算。
          return;
        }
        if (!polished?.promptModel) {
          throw new Error("文本模型未返回可用润色结果");
        }
        updateImagePrompts((current) =>
          current.map((item) =>
            item.id === shot.id
              ? {
                  ...polished,
                  image: item.image,
                  status: item.image ? item.status : "missing",
                  mediaSource: item.mediaSource,
                  imageSourceSignature: item.imageSourceSignature,
                  imageNeedsReview: item.imageNeedsReview,
                }
              : item,
          ), { generated: true },
        );
        polishStateRef.current.reset("image", shot.id);
      } catch (error) {
        if (
          session === projectSessionRef.current &&
          polishStateRef.current.isCurrent("image", shot.id, version)
        ) {
          const reason =
            error instanceof Error ? error.message : "画面词润色失败";
          if (isRejectedPolishError(error)) {
            // 确定性拒收：重发同样输入只会同样失败，直接交回用户。
            // 服务端文案只说「错在哪」，镜头编号由 rejectionAnnouncement 补。
            announce(rejectionAnnouncement(error, shot.id));
            settleRejectedPolish("image", shot.id, reason, error.code);
          } else {
            scheduleAutoRetry(reason);
          }
        }
      } finally {
        if (
          session === projectSessionRef.current &&
          polishStateRef.current.isCurrent("image", shot.id, version)
        ) {
          setImagePromptPolishingIds((current) =>
            current.filter((id) => id !== shot.id),
          );
        }
      }
    };
    imagePromptPolishLaneRef.current.enqueue({ run }, options?.priority);
  };

  /**
   * 视频词润色：与画面词同款机制（串行队列 + 版本号防串台）。
   * 润色结果写进 `shot.videoPromptPolished`，提交时由 `promptText` 自动取用；
   * 对白不在润色范围内——组装时服务端逐字附加，模型无权改写。
   */
  const requestPolishedVideoPrompts = async (shots: Shot[]) => {
    const identityChecks = await Promise.all(
      shots.map(async (shot) => {
        try {
          const { references, sceneImage: sceneSource } = videoSourcesFor(shot);
          if (!references.length) return { note: undefined, status: "not-needed" as const };
          if (!sceneSource) return { note: undefined, status: "unavailable" as const };
          const [sceneImageDataUrl, referenceImages] = await Promise.all([
            referenceSourceToDataUrl(sceneSource),
            Promise.all(references.map(async (reference) => ({
              roleName: reference.roleName,
              characterName: reference.characterName,
              imageDataUrl: await referenceSourceToDataUrl(reference.image),
            }))),
          ]);
          const response = await fetchJsonWithTimeout(
            "/api/ai/character-match",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sceneImageDataUrl,
                references: referenceImages,
                shotContext: `${shot.location}；${shot.action.join("→")}；${shot.dialogue}`,
              }),
            },
            "角色身份匹配",
          );
          const data = await responseData<CharacterIdentityResult>(response);
          return {
            note: buildCharacterIdentityNote(data.matches),
            status: classifyCharacterIdentity(data.matches, references),
          };
        } catch {
          return { note: undefined, status: "unavailable" as const };
        }
      }),
    );
    if (identityChecks.some((check) => check.status === "unavailable")) {
      throw new Error("视觉身份匹配暂时不可用，文本模型不会替多人场景猜测人物归属");
    }
    const response = await fetchJsonWithTimeout(
      "/api/ai/video-prompts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectTitle,
          shots: shots.map((shot, index) => {
            const firstFrameReference = videoSourcesFor(shot).firstFrameReference;
            return {
              id: shot.id,
              title: shot.title,
              scene: shot.location,
              characters: shot.speaker,
              dialogue: shot.dialogue,
              actions: firstFrameReference
                ? continuityVisualActions(shot, cleanImagePromptAction(shot.location))
                : shot.action.filter(Boolean),
              referenceNote: shot.prompt.reference,
              performance: shot.prompt.dialogue,
              continuity: shot.continuity,
              constraints: shot.prompt.constraints,
              identityNotes: identityChecks[index]?.note,
              seconds: shot.videoSecondsOverride ?? shot.estimatedSeconds ?? 0,
              aspectRatio: "16:9",
              firstFrameReference,
            };
          }),
        }),
      },
      "视频词润色",
    );
    const data = await responseData<{
      prompts: Array<{ id: string; script: string; fallback?: boolean }>;
      model: string;
      fallbackCount?: number;
    }>(response);
    return {
      ...data,
      identityNotes: new Map(
        shots.map((shot, index) => [shot.id, identityChecks[index]?.note || ""]),
      ),
      identityStatuses: new Map(
        shots.map((shot, index) => [shot.id, identityChecks[index]?.status || "unavailable"]),
      ),
    };
  };

  const queueVideoPromptPolish = (
    shot: Shot,
    options?: { silent?: boolean; priority?: boolean },
  ) => {
    if (!aiConfiguration.configured) {
      if (!options?.silent) announce("尚未连接文本模型，无法润色视频词；请先在「配置」完成连接");
      return;
    }
    const session = projectSessionRef.current;
    const version = polishStateRef.current.begin("video", shot.id);
    const requestSignature = videoSignatureFor(shot);
    setVideoPromptPolishingIds((current) =>
      current.includes(shot.id) ? current : [...current, shot.id],
    );

    /**
     * 2026-09-17（用户拍板）自驱动重试闭环：失败/超时后 10s → 30s 各重试一次，
     * 不依赖用户操作——「他一定要能够自己触发」。两次重试耗尽即停止：
     * 标记 polishExhausted 不再自动重提，并结算等待者，让「生成」按钮还原、
     * 把原因交回用户，由用户手动决定再试还是直接用模板提交。
     */
    const scheduleAutoRetry = (reason: string) => {
      const fails = polishStateRef.current.recordRetry("video", shot.id);
      if (fails > POLISH_RETRY_DELAYS_MS.length) {
        polishStateRef.current.exhaust("video", shot.id, { ok: false, error: reason });
        // 这一镜不会再有结果了：从本轮汇总的等待名单里摘掉，否则汇总永远等下去。
        // 提示本身照旧单独弹——它写着下一步能做什么，不该被压进汇总。
        abandonAutoPolish(shot.id);
        announce(
          `${shotDisplayLabel(shotDraftsRef.current, shot.id)} 视频词${reason}；已重试 ${POLISH_RETRY_DELAYS_MS.length} 次仍未成功，停止自动重试——可改素材、点「立即重新润色」，或重新点「生成」`,
        );
        return;
      }
      const delay = POLISH_RETRY_DELAYS_MS[fails - 1];
      announce(
        `${shotDisplayLabel(shotDraftsRef.current, shot.id)} 视频词${reason}；${delay / 1000} 秒后自动重试（第 ${fails}/${POLISH_RETRY_DELAYS_MS.length} 次）`,
      );
      window.setTimeout(() => {
        if (projectSessionRef.current !== session || !polishStateRef.current.isCurrent("video", shot.id, version)) return;
        // 按「重试触发那一刻」的最新素材重润，避免把旧内容润成新结果。
        const latestShot = shotDraftsRef.current.find((item) => item.id === shot.id);
        if (!latestShot) return;
        if (latestShot.videoPromptPolished?.sourceSignature === latestVideoSignatureFor(latestShot)) {
          settlePolishWaiters("video", shot.id, { ok: true });
          return;
        }
        queueVideoPromptPolish(latestShot, { silent: true });
      }, delay);
    };

    const run = async () => {
      if (session !== projectSessionRef.current || !polishStateRef.current.isCurrent("video", shot.id, version)) return;
      try {
        const data = await requestPolishedVideoPrompts([shot]);
        const polished = data.prompts.find((item) => item.id === shot.id);
        if (
          session !== projectSessionRef.current ||
          !polishStateRef.current.isCurrent("video", shot.id, version)
        ) {
          // 请求期间素材被改过 → 这份润色已过期，丢弃；新素材会自己重新入队，
          // 等待者继续等，不在这里结算。
          return;
        }
        if (!polished?.script) throw new Error("文本模型未返回可用润色结果");
        // 签名变了说明素材在请求期间被改：这次结果不能用，但也不算失败——
        // 交给新素材那一轮去润。此时绝不能 settle ok，否则会提交一份过期提示词。
        const latest = shotDraftsRef.current.find((item) => item.id === shot.id);
        const stillFresh = latest
          ? latestVideoSignatureFor(latest) === requestSignature
          : false;
        polishStateRef.current.reset("video", shot.id);
        applyStoryboardWork({ shots: shotDraftsRef.current.map((item) => {
            if (item.id !== shot.id) return item;
            // 请求期间素材被改过（对白/动作/时长等）→ 这份润色稿已过期，丢弃；
            // 主润色 effect / 补润 effect 会按新素材重润。防止迟到的旧响应覆盖新素材。
            if (latestVideoSignatureFor(item) !== requestSignature) return item;
            return {
              ...item,
                videoPromptPolished: {
                  script: polished.script,
                  model: data.fallbackCount
                    ? `${data.model} · ${data.fallbackCount} 条结构模板兜底`
                    : data.model,
                  updatedAt: new Date().toISOString(),
                  identityNote: data.identityNotes.get(shot.id) || undefined,
                  identityStatus: data.identityStatuses.get(shot.id),
                  // 2026-10-08：把「这份稿子是按哪份素材写的」落盘。刷新页面后
                  // 内存签名清空，靠它才能认出「素材没变、不必重润」。
                  sourceSignature: requestSignature,
                },
            };
          }), prompts: imagePromptDraftsRef.current });
        if (stillFresh) {
          // 不在这里弹单镜提示：整轮跑完后由 finishAutoPolishBatch 出一条汇总，
          // 否则每镜各弹一条、后一条覆盖前一条，用户只看到一串不知道是什么的提示。
          recordAutoPolish(shot.id, {
            label: shotDisplayLabel(shotDraftsRef.current, shot.id),
            source: data.fallbackCount ? "fallback" : "model",
            model: data.model,
          });
          polishStateRef.current.reset("video", shot.id);
        }
      } catch (error) {
        if (
          session === projectSessionRef.current &&
          polishStateRef.current.isCurrent("video", shot.id, version)
        ) {
          const reason =
            error instanceof Error ? error.message : "视频词润色失败";
          if (isRejectedPolishError(error)) {
            // 确定性拒收：重发同样输入只会同样失败，直接交回用户。
            // 服务端文案只说「错在哪」，镜头编号由 rejectionAnnouncement 补。
            abandonAutoPolish(shot.id);
            announce(rejectionAnnouncement(error, shot.id));
            settleRejectedPolish("video", shot.id, reason, error.code);
          } else {
            scheduleAutoRetry(reason);
          }
        }
      } finally {
        if (
          session === projectSessionRef.current &&
          polishStateRef.current.isCurrent("video", shot.id, version)
        ) {
          setVideoPromptPolishingIds((current) =>
            current.filter((id) => id !== shot.id),
          );
        }
      }
    };
    videoPromptPolishLaneRef.current.enqueue({ run }, options?.priority);
  };

  /** 手动指定视频目标时长档位（5/10/15 秒），作为提交参数并写进提示词。 */
  const applyVideoDuration = (value: string) => {
    const override = value === "auto" ? undefined : Number(value);
    applyStoryboardWork({ shots: shotDraftsRef.current.map(shot => shot.id === selectedId
      ? { ...shot, videoSecondsOverride: override } : shot), prompts: imagePromptDraftsRef.current });
    announce(override === undefined ? `${selectedDisplayLabel} 视频时长已恢复自动`
      : `${selectedDisplayLabel} 目标时长已设为 ${override} 秒；关联续镜已同步检查`);
  };

  /**
   * 2026-09-16：视频词润色与画面词一致——**全后台自动执行，界面上不提供按钮**。
   * 进入视频词阶段、素材（对白/动作/约束/参考/时长）变化、或连接文本模型时触发；
   * 同一素材签名只润色一次，编辑后签名变化会自动重润（防抖 1.2 秒，避免逐字请求）。
   */
  const videoPromptSourceKey = shotDrafts.map(videoSignatureFor).join("||");
  // 新稿已进入 React 当前状态后才放行等待的提交，不能在 setState 后立即用旧闭包提交。
  useEffect(() => {
    for (const shot of shotDrafts) {
      if (!videoPromptPolishingIds.includes(shot.id) && shot.videoPromptPolished?.sourceSignature === videoSignatureFor(shot)) {
        polishStateRef.current.succeed("video", shot.id);
      }
    }
    for (const prompt of imagePromptDrafts) {
      if (prompt.promptModel && !imagePromptPolishingIds.includes(prompt.id)) {
        polishStateRef.current.succeed("image", prompt.id);
      }
    }
    // 素材 key 已包含视频的全部外部依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPromptSourceKey, shotDrafts, imagePromptDrafts, imagePromptPolishingIds, videoPromptPolishingIds]);


  // 2026-09-17：重试定时器要等 10~30 秒才触发，期间素材随时可能被改；
  // 快照 ref 让重试按「触发那一刻」的内容润色，而不是闭包里的旧内容。
  useEffect(() => {
    shotDraftsRef.current = shotDrafts;
    imagePromptDraftsRef.current = imagePromptDrafts;
  }, [shotDrafts, imagePromptDrafts]);

  /**
   * 2026-09-16：视频词润色与画面词一致——**全后台自动执行，界面上不提供按钮**。
   * 2026-09-17（用户要求「确定了就开始润色」）：起跑条件从「必须先进视频词阶段」
   * 放宽为「该镜素材已齐」——分镜已确认、有参考图或尾帧、参考图未过期即进队列。
   * 这样用户点「生成」时提示词往往已经润好了，不必现场等。
   * 同一素材签名只润色一次，编辑后签名变化会自动重润（防抖 1.2 秒，避免逐字请求）。
   */
  useEffect(() => {
    if (!aiConfiguration.configured) return;
    if (videoPromptAutoPolishTimerRef.current !== null) {
      window.clearTimeout(videoPromptAutoPolishTimerRef.current);
    }
    videoPromptAutoPolishTimerRef.current = window.setTimeout(() => {
      videoPromptAutoPolishTimerRef.current = null;
      const queued: string[] = [];
      for (const shot of shotDrafts) {
        if (!canUseVideoPromptForShotWithTail(shot)) continue;
        // 2026-09-16 晚：参考图过期的镜头不进入视频词润色——先解决图的问题。
        if (referenceImageStaleFor(shot)) continue;
        const signature = videoSignatureFor(shot);
        const previousSignature = videoPromptAutoPolishRef.current.get(shot.id);
        if (previousSignature !== signature) polishStateRef.current.reset("video", shot.id);
        if (polishStateRef.current.isExhausted("video", shot.id) || polishStateRef.current.hasRetry("video", shot.id)) continue;
        // 2026-10-08：判据多了一路**落盘**签名。此前只看内存 Map，刷新即清空，
        // 于是每次打开项目都把全部可用镜头重润一遍、重弹一遍。
        if (
          !needsVideoPromptRepolish({
            hasPolished: Boolean(shot.videoPromptPolished),
            storedSignature: shot.videoPromptPolished?.sourceSignature,
            currentSignature: signature,
          })
        ) {
          continue;
        }
        videoPromptAutoPolishRef.current.set(shot.id, signature);
        queued.push(shot.id);
        queueVideoPromptPolish(shot, { silent: true });
      }
      // 本轮实际入队的镜头登记给汇总：跑完之后只弹一条，逐镜明细可展开。
      if (queued.length) expectAutoPolish(queued);
    }, 1_200);
    return () => {
      if (videoPromptAutoPolishTimerRef.current !== null) {
        window.clearTimeout(videoPromptAutoPolishTimerRef.current);
        videoPromptAutoPolishTimerRef.current = null;
      }
    };
    // 依赖素材签名与镜头可润色状态：改完内容自动重润，不需要任何按钮。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPromptSourceKey, currentStage, aiConfiguration.configured, videoReadyShotCount]);

  // 画面词润色门槛的兜底：存量项目（分镜已确认但从未润色）进入画面词阶段时自动补润，
  // 否则「未润色不能提交」的置灰按钮永远解不开。失败后依赖不再变化，不会死循环重试；
  // 用户切换阶段/重新确认分镜会重新触发。排队走 setTimeout，避免 effect 内同步 setState。
  useEffect(() => {
    if (currentStage !== "imagePrompt" || !aiConfiguration.configured) return;
    if (!selectedImagePrompt || selectedImagePrompt.promptModel) return;
    if (selectedImagePromptPolishing) return;
    // 2026-09-17：重试在飞/已耗尽的镜头不再由补润 effect 重复插队，
    // 避免 effect 与重试定时器互相抢版本，也避免无限重提同一个镜头。
    if (polishStateRef.current.hasRetry("image", selectedImagePrompt.id)) return;
    if (polishStateRef.current.isExhausted("image", selectedImagePrompt.id)) return;
    const shot = shotDrafts.find((item) => item.id === selectedImagePrompt.id);
    if (!shot || !shot.storyboardConfirmed) return;
    const draft = selectedImagePrompt;
    const timer = window.setTimeout(() => queueImagePromptPolish(shot, draft), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, aiConfiguration.configured, selectedImagePrompt?.id, selectedImagePrompt?.promptModel, selectedImagePromptPolishing]);

  // 视频词润色补润兜底（2026-09-17，与画面词同构）：选中镜应润色而未润色时自动补提——
  // 覆盖「上次润色失败后无人再提」和「签名已记但请求挂死」两类场景。
  // 2026-09-17 二次修订：不再要求先进视频词阶段（提前起跑）；重试在飞或已耗尽的镜头
  // 不在这里重复插队——重试由 scheduleAutoRetry 那个定时器负责，避免两处互相抢版本。
  useEffect(() => {
    if (!aiConfiguration.configured) return;
    if (selectedShotVideoPromptPolishing) return;
    if (selected.videoPromptPolished) return;
    if (polishStateRef.current.hasRetry("video", selected.id)) return;
    if (polishStateRef.current.isExhausted("video", selected.id)) return;
    if (!canUseVideoPromptForShotWithTail(selected) || referenceImageStaleFor(selected)) return;
    const shot = selected;
    expectAutoPolish([shot.id]);
    const timer = window.setTimeout(() => queueVideoPromptPolish(shot, { silent: true }), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, aiConfiguration.configured, selected.id, selected.videoPromptPolished, selectedShotVideoPromptPolishing, videoReadyShotCount]);

  async function candidateFile(candidate: MediaCandidate) {
    const response = await fetch(candidate.previewUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("候选媒体文件读取失败");
    const blob = await response.blob();
    return new File([blob], candidate.fileName || candidate.id, {
      type: candidate.mimeType || blob.type,
    });
  }

  async function requestImageRetry(
    inputs: ImageRetryCandidateInput[],
    currentPrompt: string,
  ) {
    const rejections = await Promise.all(
      inputs.map(async ({ job, candidate, feedback }) => ({
        imageDataUrl: await blobToDataUrl(await candidateFile(candidate)),
        candidatePrompt: job.promptSnapshot,
        userFeedback: feedback,
      })),
    );
    const response = await fetch("/api/ai/image-retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rejections,
        currentPrompt,
        shotContext: selectedPromptShots
          .map(
            (shot) =>
              `${shotDisplayLabel(shotDrafts, shot.id)}｜${shot.speaker}｜${shot.location}｜${shot.action.join(" → ")}｜${shot.dialogue}`,
          )
          .join("\n"),
        fixedCharacterRules: needsAuditorAsset
          ? "审计员A必须保持眼镜、发型、脸型和服装一致。"
          : "",
      }),
    });
    const data = (await response.json().catch(() => ({}))) as ImageRetryResult & {
      error?: string;
      stageLabel?: string;
      model?: string;
      upstreamStatus?: number;
    };
    if (!response.ok) {
      const context = [
        data.stageLabel,
        data.model,
        data.upstreamStatus ? `HTTP ${data.upstreamStatus}` : "",
      ].filter(Boolean).join(" · ");
      throw new Error(`${context ? `${context}：` : ""}${data.error || `请求失败（${response.status}）`}`);
    }
    return data;
  }

  const createSelectedMediaJob = async (
    retryOfJobId?: string,
    options?: { skipPolishGate?: boolean },
  ) => {
    const session = projectSessionRef.current;
    const sourceSignature = videoSignatureFor(selected);
    const retryJob = retryOfJobId
      ? mediaJobs.find((job) => job.id === retryOfJobId)
      : undefined;
    if (
      needsProviderHistoryCheck(retryJob?.errorCode) &&
      !window.confirm(
        "这条任务可能已经在豆包生成并消耗额度。请先核对对应账号的豆包生成记录；确认仍需新生成后再继续。",
      )
    ) {
      setMediaMessage("已取消重新生成，请先核对豆包历史记录。");
      return;
    }
    if (mediaSubmitBlocker) {
      setMediaMessage(mediaSubmitBlocker);
      return;
    }
    // 2026-09-17：正常入口由 handleGenerateClick 保证「润色已完成才走到这里」。
    // 这里保留兜底，防止别的入口（任务卡上的「重新生成」）绕过润色闸门。
    if (mediaPolishPending && !options?.skipPolishGate) {
      setMediaMessage(
        "提示词还没润色完成；请用下方「生成」按钮排队等待，润色一完成会自动提交。",
      );
      return;
    }
    if (videoIdentitySubmitBlocker) {
      setMediaMessage(videoIdentitySubmitBlocker);
      return;
    }
    // 2026-09-16（用户决策）：前台不再暴露模型选择，视频统一走后台固定的可用模型。
    // 实测依据：mini 只能到 10 秒（15 秒会被豆包判为「订阅标准套餐专属能力」），
    // fast 可以到 15 秒，因此后台固定用 fast。
    const jobVideoModel = DEFAULT_VIDEO_MODEL;
    const jobVideoSeconds = videoDurationBucket(
      selected.videoSecondsOverride ?? selected.estimatedSeconds,
    );
    // 2026-09-26（用户拍板）：没有参考图不允许生成视频——分镜图是画面锚，
    // 038eb112 实证 0 参考图提交的成片完全不跟随分镜。宁可不生成，也不发空参考任务。
    if (selectedMediaType === "video" && selectedVideoReferencePlan.images.length === 0) {
      setMediaMessage(
        `${shotDisplayLabel(shotDrafts, selectedMediaTargetId)} 没有可用参考图（本镜未采用分镜画面，也没有上一镜视频尾帧），已拒绝提交——请先为本镜生成并采用一张分镜画面。`,
      );
      return;
    }
    setMediaAction("create-job");
    setMediaMessage(
      pendingLegacyImageFeedback.length
        ? `正在用视觉与文本模型整理 ${pendingLegacyImageFeedback.length} 条旧退回意见…`
        : automaticallyAssignProvider
        ? "正在选择空闲账号并提交任务…"
        : selectedMediaType === "image"
          ? "正在提交豆包图片任务…"
          : "正在提交豆包视频任务…",
    );
    try {
      let imagePrompt = selectedImagePrompt.prompt;
      if (selectedMediaType === "image" && pendingLegacyImageFeedback.length) {
        const legacyInputs = pendingLegacyImageFeedback.map((entry) => {
          const source = parseMediaFeedbackSource(entry.before);
          const job = source ? mediaJobs.find((item) => item.id === source.jobId) : undefined;
          const candidate = job?.candidates.find((item) => item.id === source?.candidateId);
          return job && candidate && entry.reason
            ? { job, candidate, feedback: entry.reason }
            : undefined;
        }).filter((item): item is ImageRetryCandidateInput => Boolean(item));
        if (legacyInputs.length !== pendingLegacyImageFeedback.length) {
          throw new Error("旧退回意见对应的候选图不完整，暂未提交豆包");
        }
        const rewriteVersion = beginImagePromptRewrite(selectedMediaTargetId);
        let retryResult: ImageRetryResult;
        try {
          retryResult = await requestImageRetry(legacyInputs, imagePrompt);
        } finally {
          if (session === projectSessionRef.current && polishStateRef.current.isCurrent("image", selectedMediaTargetId, rewriteVersion)) {
            setImagePromptPolishingIds(current => current.filter(id => id !== selectedMediaTargetId));
          }
        }
        if (session !== projectSessionRef.current) return;
        if (!polishStateRef.current.isCurrent("image", selectedMediaTargetId, rewriteVersion)) {
          setMediaMessage("画面要求已修改，旧反馈重写结果已丢弃，请按当前内容重新生成");
          return;
        }
        imagePrompt = retryResult.prompt;
        updateImagePrompts((current) =>
          current.map((item) =>
            item.id === selectedMediaTargetId
              ? { ...item, prompt: retryResult.prompt, promptModel: retryResult.textModel }
              : item,
          ),
        );
        const resolvedIds = new Set(pendingLegacyImageFeedback.map((entry) => entry.id));
        setProjectHistory((current) =>
          current.map((entry) =>
            resolvedIds.has(entry.id) ? { ...entry, after: retryResult.prompt } : entry,
          ),
        );
        for (const input of legacyInputs) {
          const reviewed = await postMedia<MediaJob>({
            operation: "save-review",
            jobId: input.job.id,
            candidateId: input.candidate.id,
            review: retryResult.review,
          }).catch(() => undefined);
          if (reviewed && session === projectSessionRef.current) replaceMediaJob(reviewed);
        }
        setMediaMessage("旧退回意见已完成 AI 整理，正在提交豆包图片任务…");
      }
      // 2026-09-17 生图逻辑：图片跟随文字引用——提示词里引用了哪张图才传哪张图（Seedream 指南：
      // 参考约束不得悬空、多图必须分工）。新版续镜草稿（buildImagePrompts）以上一镜图为唯一
      // 参考，不再写风格图/人物图约束；旧格式草稿仍引用风格图/人物图，按引用传图保持兼容。
      const imagePromptText = selectedMediaType === "image"
        ? cleanImagePromptForProvider(imagePrompt)
        : "";
      const tailFrameReference =
        selectedMediaType === "image" && continuityReferenceTailFrame && continuityReferenceShot
          ? { shot: continuityReferenceShot, frame: continuityReferenceTailFrame }
          : undefined;
      const imageContinuityInstruction = selectedMediaType === "image" && continuityReferenceShot
        ? continuityReferenceTailFrame
          ? tailFrameEnhancementInstruction(shotDisplayLabel(shotDraftsRef.current, continuityReferenceShot.id))
          : !/上一镜/u.test(imagePromptText)
            ? `本次已上传上一镜 ${shotDisplayLabel(shotDraftsRef.current, continuityReferenceShot.id)} 的已选图作为连续性参考；画风、人物、服装、场景、机位和道具状态以该图为准。`
            : ""
        : "";
      // 2026-09-18 视频参考图：从「分镜图 或 上一镜尾帧」的单张，改为按本镜真实需要组装
      // 多张（画面基准 + 角色形象 + 项目画风）。清单与置顶说明都由 selectedVideoReferencePlan
      // 统一产出，界面展示的就是真正上传的，不再出现「界面说一张、实际传另一张」。
      const prompt = selectedMediaType === "image"
        ? tailFrameReference
          ? imageContinuityInstruction
          : imagePromptText + (imageContinuityInstruction ? `\n${imageContinuityInstruction}` : "")
        : promptText(selectedVideoPromptShot, selectedVideoReferenceNote);
      const referenceImageSources =
        selectedMediaType === "video"
          ? selectedVideoReferencePlan.images.map((image) => ({
            dataUrl: image.dataUrl,
            fileName: image.fileName,
          }))
          : tailFrameReference
            ? [{
                dataUrl: tailFrameReference.frame,
                fileName: `${shotDisplayLabel(shotDraftsRef.current, tailFrameReference.shot.id)}-尾帧高清化.png`,
              }]
            : [
              ...(styleAsset?.image && /风格图|扁平线条/u.test(imagePromptText)
                ? [{ dataUrl: styleAsset.image, fileName: "剪映扁平线条风参考.png" }]
                : []),
              ...(needsAuditorAsset && auditorAsset?.image && /人物图/u.test(imagePromptText)
                ? [{ dataUrl: auditorAsset.image, fileName: "审计员A.png" }]
                : []),
              ...(continuityReferenceShot && continuityReferenceImage
                ? [{
                    dataUrl: continuityReferenceImage,
                    fileName: `${shotDisplayLabel(shotDraftsRef.current, continuityReferenceShot.id)}-连续性参考.png`,
                  }]
                : []),
            ];
      const referenceImages = await Promise.all(
        referenceImageSources.map(async (reference) => ({
          ...reference,
          dataUrl: await referenceSourceToDataUrl(reference.dataUrl),
        })),
      );
      if (session !== projectSessionRef.current) return;
      const currentShot = shotDraftsRef.current.find(shot => shot.id === selected.id);
      const currentPrompt = imagePromptDraftsRef.current.find(draft => draft.id === selectedImagePrompt.id);
      if (!currentShot || (selectedMediaType === "video"
        ? latestVideoSignatureFor(currentShot) !== sourceSignature
        : currentPrompt?.prompt !== imagePrompt || !currentShot.storyboardConfirmed ||
          resolveContinuityReference(shotDraftsRef.current, imagePromptDraftsRef.current, selectedImageShot?.id ?? "").image !== continuityReferenceImage)) {
        setMediaMessage("准备提交时素材已发生变化，请检查当前镜头后重新生成");
        return;
      }
      const job = await postMedia<MediaJob>({
        operation: "create-job",
        projectId: activeProjectId,
        projectTitle,
        targetId: selectedMediaTargetId,
        // 展示编号只在导出文件名和候选图 aria 里用；内部键 `targetId` 仍是索引。
        targetLabel: shotDisplayLabel(shotDraftsRef.current, selectedMediaTargetId),
        mediaType: selectedMediaType,
        accountId: selectedProviderAccountId,
        prompt,
        referenceImages,
        retryOfJobId,
        videoModel: selectedMediaType === "video" ? jobVideoModel : undefined,
        videoDurationSeconds: selectedMediaType === "video" ? jobVideoSeconds : undefined,
      });
      if (session !== projectSessionRef.current) return;
      replaceMediaJob(job);
      const mediaLabel = selectedMediaType === "image" ? "图片" : "视频";
      const assignedAccount = providerAccounts.find(
        (account) => account.id === job.accountId,
      );
      setMediaMessage(
        `${automaticallyAssignProvider ? "已自动分配给" : "已提交给"}“${
          assignedAccount?.alias || job.accountId
        }”，该${mediaLabel}只生成一次，页面会自动更新进度。`,
      );
    } catch (error) {
      if (session !== projectSessionRef.current) return;
      setMediaMessage(error instanceof Error ? error.message : "媒体任务提交失败");
    } finally {
      if (session === projectSessionRef.current) setMediaAction("");
    }
  };

  /**
   * 2026-09-17（用户拍板）「生成」按钮的新语义：不再是「点一下立刻提交豆包」，
   * 而是「排队等提示词润色完成，润色一完成就自动提交豆包」。按钮全程可点，不再被润色置灰。
   *
   *  1. 硬阻断（未连模型 / 缺参考图 / 缺账号）照旧直接拒绝；
   *  2. 提示词已润色 → 维持旧行为，立刻提交；
   *  3. 提示词还没润色 → 该镜插队优先润色 + 登记等待者，按钮显示「润色中…完成后自动提交」；
   *  4. 润色成功 → 自动提交；重试两次仍失败 → 按钮还原、把原因交回用户，
   *     同时给出「用未润色模板强行提交」的逃生口（需二次确认）。
   */
  const latestMediaSubmitRef = useRef<{ targetId: string; run: typeof createSelectedMediaJob } | null>(null);
  useEffect(() => {
    latestMediaSubmitRef.current = { targetId: selectedMediaTargetId, run: createSelectedMediaJob };
  });

  const handleGenerateClick = async (retryOfJobId?: string) => {
    if (mediaSubmitBlocker) {
      setMediaMessage(mediaSubmitBlocker);
      return;
    }
    if (!mediaPolishPending) {
      await createSelectedMediaJob(retryOfJobId, { skipPolishGate: true });
      return;
    }
    // 图片侧的润色主体是「画面词草稿」（id 与镜头 id 一致），视频侧就是镜头本身。
    const kind = selectedMediaType;
    const polishTargetId =
      kind === "image" ? selectedImagePrompt.id : selected.id;
    // 连点保护：已经在等这一条就直接忽略（按钮此时通常也是不可点的）。
    if (polishStateRef.current.hasWaiters(kind, polishTargetId)) return;
    const session = projectSessionRef.current;
    const settled = awaitPolish(kind, polishTargetId);
    setUnpolishedEscape(null);
    setPendingMediaElapsed(0);
    setPendingMediaSubmit({
      targetId: selectedMediaTargetId,
      mediaType: kind,
    });

    // 这是用户明确的意图：清掉上一轮失败计数与「已耗尽」标记，并插队到润色队列队首，
    // 不让用户干等前面几条。
    if (kind === "image") {
      const shot = shotDrafts.find((item) => item.id === polishTargetId);
      const draft = imagePromptDrafts.find((item) => item.id === polishTargetId);
      polishStateRef.current.reset("image", polishTargetId);
      if (shot && draft) {
        queueImagePromptPolish(shot, draft, { priority: true });
      } else {
        // 兜底：找不到对应草稿时不入队，必须立刻结算等待者，否则按钮会停在「润色中」永不还原。
        settlePolishWaiters("image", polishTargetId, {
          ok: false,
          error: "该镜头的画面词草稿已不存在，请重新确认分镜后再试",
        });
      }
    } else {
      polishStateRef.current.reset("video", polishTargetId);
      // 手动重润也登记进汇总：结果提示同样是「哪几镜、模型还是模板兜底」，
      // 不必为手动路径再写一套文案。
      expectAutoPolish([selected.id]);
      queueVideoPromptPolish(selected, { priority: true });
    }

    const result = await settled;
    if (session !== projectSessionRef.current) return;
    setPendingMediaSubmit(null);
    if (result.ok) {
      const latest = latestMediaSubmitRef.current;
      if (!latest || latest.targetId !== selectedMediaTargetId) {
        announce("已切换镜头，本次自动提交取消；润色结果已保留");
        return;
      }
      await latest.run(retryOfJobId);
      return;
    }
    // 2026-10-08 二轮：`label` 带上对外展示的编号——服务端文案里已经没有镜头编号了，
    // 这里是用户唯一能对上界面的一处。`selectedMediaTargetId` 就是提交时的镜头键，
    // 画面词阶段它等于 `shot.id`。
    const label = `${shotDisplayLabel(shotDraftsRef.current, selectedMediaTargetId)} ${
      kind === "image" ? "画面词" : "视频词"
    }`;
    const reason = result.error ?? "未知原因";
    setUnpolishedEscape({
      targetId: selectedMediaTargetId,
      error: reason,
      rejected: result.rejected,
      code: result.code,
    });
    // 三类失败的下一步不一样，不能都说「再点一次试试」：
    //  - 素材缺字段：退回去补这一镜的场景/动作，模板里也没有这两个字段，别劝他点模板；
    //  - 模型违反内容规则（改台词等）：重发同样输入大概率还是同样结果，建议直接用模板提交；
    //  - 瞬时失败（过载/超时）：重试有意义，先建议重试。
    if (result.code === AI_INPUT_REJECTED_CODE) {
      setMediaMessage(
        `${label}没能提交：${reason}。这是这一镜的素材本身不完整，重发同样素材也不会成功——请回到分镜补齐该镜的场景与动作后重试，或直接用未润色模板提交。`,
      );
      announce(`${label}没能提交：${reason}`);
    } else {
      setMediaMessage(
        result.rejected
          ? `${label}润色没通过：${reason}。重发同样的素材大概率还是同样结果——未润色模板里的台词是逐字正确的，建议直接用模板提交。`
          : `${label}润色失败：${reason}。可重新点「生成」再试，或用未润色模板强行提交。`,
      );
      announce(
        result.rejected
          ? `${label}润色没通过：${reason}`
          : `${label}润色失败：${reason}`,
      );
    }
  };

  /**
   * 「排队等润色」期间显示已等待秒数，让用户知道后台真的在动。
   * 用「每秒 +1」而不是时间戳相减：`Date.now()` 不是纯函数，
   * 出现在组件内定义的函数里会被 react-hooks/purity 判定为渲染期副作用。
   */
  useEffect(() => {
    if (!pendingMediaSubmit) return;
    const timer = window.setInterval(() => {
      setPendingMediaElapsed((current) => current + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [pendingMediaSubmit]);

  /** 逃生口：润色反复失败后，用户二次确认才允许用未润色模板直接提交。 */
  const submitUnpolishedAnyway = async () => {
    const context = unpolishedEscape;
    if (!context) return;
    if (context.targetId !== selectedMediaTargetId) {
      setUnpolishedEscape(null);
      announce("已切换镜头，请在当前镜头重新发起生成");
      return;
    }
    if (
      !window.confirm(
        "这次提交的提示词**没有经过 AI 润色**，用的是干净模板。\n\n模板不含润色模型补充的镜头时序细节，出片质量可能下降，但可以直接生成、不占用重试时间。\n\n确认用未润色模板提交吗？",
      )
    ) {
      return;
    }
    setUnpolishedEscape(null);
    await createSelectedMediaJob(undefined, { skipPolishGate: true });
  };

  /**
   * 2026-09-17 尾帧链：视频验收通过后把结尾画面写入该镜，下一镜提交视频时自动
   * 以它为参考图。记录抽帧时刻的视觉签名——分镜再被修改，尾帧即自动过期。
   */
  const commitVideoLastFrame = (shotId: string, frameDataUrl: string) => {
    applyStoryboardWork({ shots: shotDraftsRef.current.map(shot => shot.id === shotId
      ? { ...shot, videoLastFrame: frameDataUrl, videoLastFrameSignature: shotVisualSignature(shot) } : shot),
      prompts: imagePromptDraftsRef.current });
  };

  const adoptMediaCandidate = async (job: MediaJob, candidate: MediaCandidate) => {
    const session = projectSessionRef.current;
    if (job.projectId !== activeProjectRef.current) return;
    const originalShot = shotDraftsRef.current.find(shot => shot.id === job.targetId);
    if (!originalShot) return;
    const originalSignature = latestVideoSignatureFor(originalShot);
    const inputUnchanged = () => {
      const latest = shotDraftsRef.current.find(shot => shot.id === job.targetId);
      return latest && latestVideoSignatureFor(latest) === originalSignature;
    };
    const actionKey = `adopt:${candidate.id}`;
    setMediaAction(actionKey);
    setMediaMessage(
      job.mediaType === "image" ? "正在采用候选图…" : "正在验收候选视频…",
    );
    try {
      let selectedImageDataUrl: string | undefined;
      let adoptedVideoLastFrame: string | undefined;
      if (job.mediaType === "image") {
        selectedImageDataUrl = await blobToDataUrl(await candidateFile(candidate));
      } else if (job.mediaType === "video") {
        adoptedVideoLastFrame = await extractVideoLastFrame(
          await candidateFile(candidate),
        );
      }
      if (session !== projectSessionRef.current) return;
      if (!inputUnchanged()) {
        announce("采用期间镜头素材已修改，请重新核对候选后采用");
        return;
      }
      const result = await postMedia<{
        job: MediaJob;
        originalFileName: string;
      }>({
        operation: "adopt-candidate",
        jobId: job.id,
        candidateId: candidate.id,
      });
      if (session !== projectSessionRef.current) return;
      replaceMediaJob(result.job);
      if (!inputUnchanged()) {
        announce("候选记录已保存，但镜头素材已修改；本次未回填旧图片或尾帧，请重新核对");
        return;
      }
      if (selectedImageDataUrl) {
        commitSelectedReference(
          job.targetId,
          selectedImageDataUrl,
          `豆包候选 · ${candidate.fileName || candidate.id}`,
          { jobId: job.id, candidateId: candidate.id },
        );
      }
      if (job.mediaType === "video" && adoptedVideoLastFrame) {
        commitVideoLastFrame(job.targetId, adoptedVideoLastFrame);
      }
      setMediaMessage(
        job.mediaType === "image"
          ? "候选图已人工采用并按原图写入项目。"
          : adoptedVideoLastFrame
            ? "候选视频已人工验收并写入项目，结尾画面已抽取，下一镜可自动衔接。"
            : "候选视频已人工验收并写入项目。",
      );
      announce(
        job.mediaType === "image"
          ? `${job.targetLabel ?? job.targetId} 候选图已采用`
          : `${job.targetLabel ?? job.targetId} 候选视频已验收`,
      );
    } catch (error) {
      if (session !== projectSessionRef.current) return;
      setMediaMessage(error instanceof Error ? error.message : "候选采用失败");
    } finally {
      if (session === projectSessionRef.current) setMediaAction("");
    }
  };

  const beginMediaCandidateRejection = (
    job: MediaJob,
    candidate: MediaCandidate,
  ) => {
    setPendingMediaRejection({
      jobId: job.id,
      candidateId: candidate.id,
    });
    setMediaRejectionReason("");
    if (mediaFeedbackProgress?.candidateId !== candidate.id) {
      setMediaFeedbackProgress(null);
    }
  };

  const rejectMediaCandidate = async (
    job: MediaJob,
    candidate: MediaCandidate,
    feedbackReason = "",
  ) => {
    const session = projectSessionRef.current;
    if (job.projectId !== activeProjectRef.current) return;
    const normalizedFeedback = feedbackReason.trim().slice(0, 400);
    const selectedPrompt = imagePromptDraftsRef.current.find((item) => item.id === job.targetId);
    const rewriteVersion = job.mediaType === "image" && normalizedFeedback ? beginImagePromptRewrite(job.targetId) : undefined;
    const revokesSelectedImage =
      job.mediaType === "image" &&
      candidateMatchesSelectedImage(
        job,
        candidate,
        selectedPrompt?.mediaSource,
        uploadedNames[job.targetId],
      );
    const actionKey = `reject:${candidate.id}`;
    setMediaAction(actionKey);
    try {
      let retryResult: ImageRetryResult | undefined;
      if (job.mediaType === "image" && normalizedFeedback) {
        setMediaFeedbackProgress({
          candidateId: candidate.id,
          state: "processing",
          title: "正在识图并重写提示词",
          detail: "先由视觉模型定位画面问题，再由文本模型只修改当前镜头；完成前不会提交新的豆包任务。",
        });
        setMediaMessage("正在处理退回意见…");
        retryResult = await requestImageRetry(
          [{ job, candidate, feedback: normalizedFeedback }],
          selectedPrompt?.prompt || job.promptSnapshot,
        );
        if (session !== projectSessionRef.current) return;
      }

      let updated = await postMedia<MediaJob>({
        operation: "reject-candidate",
        jobId: job.id,
        candidateId: candidate.id,
        ...(normalizedFeedback ? { reason: normalizedFeedback } : {}),
      });
      if (session !== projectSessionRef.current) return;
      if (retryResult) {
        updated = await postMedia<MediaJob>({
          operation: "save-review",
          jobId: job.id,
          candidateId: candidate.id,
          review: retryResult.review,
        }).catch(() => updated);
        if (session !== projectSessionRef.current) return;
        if (rewriteVersion !== undefined && !polishStateRef.current.isCurrent("image", job.targetId, rewriteVersion)) {
          replaceMediaJob(updated);
          setMediaMessage("退回意见已保存；画面要求已发生新修改，旧重写结果未覆盖当前内容");
          setMediaFeedbackProgress({ candidateId: candidate.id, state: "error", title: "重写结果已过期", detail: "请按当前画面要求重新识别并重写。" });
          return;
        }
        updateImagePrompts((current) =>
          current.map((item) =>
            item.id === job.targetId
              ? { ...item, prompt: retryResult!.prompt, promptModel: retryResult!.textModel }
              : item,
          ),
        );
      }
      replaceMediaJob(updated);
      if (retryResult) {
        const historyEntry: ProjectHistoryEntry = {
          id: createProjectId(),
          kind: "feedback",
          createdAt: new Date().toISOString(),
          title: `${job.targetLabel ?? job.targetId} 候选图已退回`,
          stage: "imagePrompt",
          targetId: job.targetId,
          issueType: IMAGE_RETRY_FEEDBACK_TYPE,
          reason: normalizedFeedback,
          before: mediaFeedbackSource(job.id, candidate.id),
          after: retryResult.prompt,
          decision: "rejected",
        };
        setProjectHistory((current) => [
          historyEntry,
          ...current,
        ]);
        setMediaFeedbackProgress({
          candidateId: candidate.id,
          state: "success",
          title: "当前镜头提示词已更新",
          detail: `${retryResult.visionModel} 已完成识图，${retryResult.textModel} 已重写；本次修改只作用于当前镜头。`,
          historyId: historyEntry.id,
        });
      } else if (normalizedFeedback) {
        // 视频候选（或图片无反馈重试）：退回原因原样留痕，供后续视频词反馈闭环与规则沉淀。
        const historyEntry: ProjectHistoryEntry = {
          id: createProjectId(),
          kind: "feedback",
          createdAt: new Date().toISOString(),
          title: `${job.targetLabel ?? job.targetId} ${job.mediaType === "video" ? "候选视频" : "候选图"}已退回`,
          stage: job.mediaType === "video" ? "videoPrompt" : "imagePrompt",
          targetId: job.targetId,
          issueType: "候选退回意见",
          reason: normalizedFeedback,
          before: mediaFeedbackSource(job.id, candidate.id),
          decision: "rejected",
        };
        setProjectHistory((current) => [historyEntry, ...current]);
      }
      setPendingMediaRejection(null);
      setMediaRejectionReason("");
      if (revokesSelectedImage && imagePromptDraftsRef.current.find(item => item.id === job.targetId)?.image === selectedPrompt?.image) {
        clearSelectedReference(job.targetId);
        setMediaMessage(
          retryResult
            ? `已撤回采用；${retryResult.visionModel} 已识别问题，${retryResult.textModel} 已重写下一版画面词。`
            : "已撤回采用并记录为不采用，可继续选择或生成新候选。",
        );
        announce(`已撤回 ${job.targetLabel ?? job.targetId} 的采用图片`);
      } else {
        setMediaMessage(
          retryResult
            ? `${retryResult.visionModel} 已识别问题，${retryResult.textModel} 已把意见整合进新画面词。`
            : "已记录为不采用，可继续生成新候选。",
        );
      }
    } catch (error) {
      if (session !== projectSessionRef.current) return;
      const message = error instanceof Error ? error.message : "候选状态保存失败";
      setMediaMessage(message);
      if (job.mediaType === "image" && normalizedFeedback) {
        setMediaFeedbackProgress({
          candidateId: candidate.id,
          state: "error",
          title: "反馈处理失败",
          detail: `${message} 当前提示词未修改，也没有提交新的豆包任务；你的反馈已保留，稍候点「重新识别并重写」即可再试。`,
        });
      }
    } finally {
      if (session === projectSessionRef.current) {
        setMediaAction("");
        if (rewriteVersion !== undefined && polishStateRef.current.isCurrent("image", job.targetId, rewriteVersion)) {
          setImagePromptPolishingIds(current => current.filter(id => id !== job.targetId));
        }
      }
    }
  };

  const importProjectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await persistCurrentProject();
      const imported = normalizeProjectSnapshot(JSON.parse(await file.text()));
      const now = new Date().toISOString();
      const project: ProjectSnapshot = {
        ...imported,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        id: createProjectId(),
        title: `${imported.title}（导入）`,
        createdAt: now,
        updatedAt: now,
        history: [
          {
            id: createProjectId(),
            kind: "imported",
            createdAt: now,
            title: "已从项目备份导入",
            reason: file.name,
          },
          ...imported.history,
        ],
      };
      await saveProject(project);
      await refreshProjectSummaries();
      applyProjectSnapshot(project);
      setManagementPanel(null);
      announce("项目备份已导入并完整恢复");
    } catch (error) {
      announce(error instanceof Error ? error.message : "项目导入失败");
    } finally {
      event.target.value = "";
    }
  };

  const openFeedback = () => {
    let targetId = sourceFileName;
    let before = "";
    if (["storyboard", "videoPrompt"].includes(currentStage)) {
      targetId = selected.id;
      before = JSON.stringify(
        {
          dialogue: selected.dialogue,
          action: selected.action,
          continuity: selected.continuity,
          prompt: selected.prompt,
        },
        null,
        2,
      );
    } else if (["imagePrompt", "reference"].includes(currentStage)) {
      targetId = selectedImagePrompt.id;
      before = selectedImagePrompt.prompt;
    } else if (currentStage === "cases") {
      targetId = selectedCase.id;
      before = JSON.stringify(selectedCase, null, 2);
    } else if (currentStage === "scriptReview") {
      targetId = sourceFileName;
      before = JSON.stringify(scriptReview, null, 2);
    }
    setFeedbackDraft({
      stage: currentStage,
      targetId,
      issueType: FEEDBACK_TYPES[0],
      reason: "",
      before,
      after: "",
      decision: "pending",
    });
    setManagementPanel(null);
    setFeedbackDialogOpen(true);
  };

  const saveRuleCandidate = async (
    candidate: AiRuleCandidate,
    source: ProjectHistoryEntry,
  ) => {
    const projectCandidate: AiRuleCandidate = { ...candidate, scope: "project" };
    const duplicate = findDuplicateRule(reuseRules, projectCandidate, activeProjectId);
    if (duplicate) return { rule: duplicate, created: false };
    const now = new Date().toISOString();
    const rule: ReuseRule = {
      id: createProjectId(),
      createdAt: now,
      updatedAt: now,
      title: projectCandidate.title,
      instruction: projectCandidate.instruction,
      stage: projectCandidate.stage,
      issueType: projectCandidate.issueType,
      scope: "project",
      status: "candidate",
      keywords: projectCandidate.keywords,
      sourceProjectId: activeProjectId,
      sourceHistoryId: source.id,
      projectId: activeProjectId,
      adoptedCount: 0,
      rejectedCount: 0,
    };
    const workspace = await saveReuseRule(rule);
    setReuseRules(workspace.rules);
    setReferenceAssets(workspace.assets);
    return { rule, created: true };
  };

  const createManualRuleFromHistory = async (entry: ProjectHistoryEntry) => {
    if (entry.kind !== "feedback" || !entry.reason) return;
    const instruction = entry.issueType === IMAGE_RETRY_FEEDBACK_TYPE
      ? entry.reason
      : entry.after
      ? `${entry.reason} 推荐做法：${entry.after.slice(0, 240)}`
      : entry.reason;
    try {
      const result = await saveRuleCandidate(
        {
          title: `${entry.issueType ?? "项目"}复用规则`,
          instruction,
          stage: entry.stage ?? "imagePrompt",
          issueType: entry.issueType ?? "其他",
          scope: "project",
          keywords: inferAssetTags(entry.issueType ?? "", `${entry.reason} ${entry.after ?? ""}`),
          reason: "由人工反馈直接建立，等待启用。",
        },
        entry,
      );
      announce(
        result.created
          ? "已建立项目规则候选，请在规则与素材库中审核启用"
          : "已有相同的项目规则候选，未重复创建",
      );
    } catch (error) {
      announce(error instanceof Error ? error.message : "规则候选保存失败");
    }
  };

  const recordFeedback = async (useAi = false) => {
    if (!feedbackDraft.reason.trim()) {
      announce("请先填写反馈原因");
      return;
    }
    const entry: ProjectHistoryEntry = {
      id: createProjectId(),
      kind: "feedback",
      createdAt: new Date().toISOString(),
      title: `已记录${feedbackDraft.issueType}反馈`,
      stage: feedbackDraft.stage,
      targetId: feedbackDraft.targetId.trim() || undefined,
      issueType: feedbackDraft.issueType,
      reason: feedbackDraft.reason.trim(),
      before: feedbackDraft.before.trim() || undefined,
      after: feedbackDraft.after.trim() || undefined,
      decision: feedbackDraft.decision,
    };
    setProjectHistory((current) => [entry, ...current]);
    if (!useAi) {
      setFeedbackDialogOpen(false);
      announce("反馈已写入项目历史，可随时转为人工规则候选");
      return;
    }

    setAiRuleLoading(true);
    try {
      const response = await fetch("/api/ai/rule-candidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectTitle, ...feedbackDraft }),
      });
      const data = (await response.json()) as {
        error?: string;
        candidate?: AiRuleCandidate;
        model?: string;
      };
      if (!response.ok || !data.candidate) {
        throw new Error(data.error ?? "模型未生成规则候选");
      }
      const result = await saveRuleCandidate(
        { ...data.candidate, scope: "project" },
        entry,
      );
      setFeedbackDialogOpen(false);
      announce(
        result.created
          ? "模型已整理为项目规则候选，人工启用后才参与本项目复用"
          : "已有相同的项目规则候选，反馈已保存且未重复创建",
      );
    } catch (error) {
      setFeedbackDialogOpen(false);
      announce(
        `${error instanceof Error ? error.message : "模型整理失败"}；反馈已保留，可手动转为规则`,
      );
    } finally {
      setAiRuleLoading(false);
    }
  };

  const applyBatchProductionRule = async () => {
    const session = projectSessionRef.current;
    const instruction = batchRuleDraft.trim();
    if (!instruction) {
      announce("请先写下要批量处理的要求");
      return;
    }
    if (batchRuleInFlightRef.current) return;
    batchRuleInFlightRef.current = true;
    setBatchRuleLoading(true);
    setBatchRuleResult("");
    try {
      const binding = parseCharacterBindingInstruction(instruction);
      const appliesToWholeProject = !binding && /(?:全片|全部画面|所有画面|整体画风|统一画风|统一风格)/u.test(instruction);
      let candidate: AiRuleCandidate;
      let usedModel = false;
      if (binding) {
        const targetAsset = referenceAssets.find((asset) =>
          asset.kind === "character" &&
          asset.roleName?.replace(/\s+/gu, "") === binding.targetRole.replace(/\s+/gu, ""),
        );
        candidate = {
          title: `${binding.sourceRole}沿用${binding.targetRole}形象`,
          instruction:
            `${binding.sourceRole}出现时，人物外观统一沿用${binding.targetRole}的固定人物参考图；` +
            `保留“${binding.sourceRole}”的角色名和原对白，只替换外观，不改变当前场景、动作与构图。` +
            (targetAsset ? `生成时使用素材库中的“${targetAsset.title}”。` : ""),
          stage: "imagePrompt",
          issueType: "人物一致性",
          scope: "project",
          keywords: [binding.sourceRole],
          reason: "由脚本审查中的批量要求建立。",
        };
      } else if (aiConfiguration.configured) {
        try {
          const response = await fetch("/api/ai/rule-candidate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectTitle,
              stage: "imagePrompt",
              issueType: "批量画面规则",
              targetId: "all-image-prompts",
              reason: instruction,
              before: `${imagePromptDrafts.length} 个画面提示词`,
              decision: "adopted",
            }),
          });
          const data = (await response.json()) as {
            error?: string;
            candidate?: AiRuleCandidate;
          };
          if (!response.ok || !data.candidate) {
            throw new Error(data.error ?? "文本模型未返回规则");
          }
          candidate = {
            ...data.candidate,
            stage: "imagePrompt",
            scope: "project",
            keywords: appliesToWholeProject ? [] : data.candidate.keywords,
          };
          usedModel = true;
        } catch {
          candidate = {
            title: "项目批量画面规则",
            instruction,
            stage: "imagePrompt",
            issueType: "批量画面规则",
            scope: "project",
            keywords: [],
            reason: "文本模型暂不可用，按原话保存。",
          };
        }
      } else {
        candidate = {
          title: "项目批量画面规则",
          instruction,
          stage: "imagePrompt",
          issueType: "批量画面规则",
          scope: "project",
          keywords: [],
          reason: "未连接文本模型，按原话保存。",
        };
      }

      if (session !== projectSessionRef.current) return;
      const now = new Date().toISOString();
      const historyEntry: ProjectHistoryEntry = {
        id: createProjectId(),
        kind: "feedback",
        createdAt: now,
        title: `应用批量规则：${candidate.title}`,
        stage: "imagePrompt",
        targetId: "all-image-prompts",
        issueType: candidate.issueType,
        reason: instruction,
        after: candidate.instruction,
        decision: "adopted",
      };
      const ruleSeed: ReuseRule = {
        id: createProjectId(),
        createdAt: now,
        updatedAt: now,
        title: candidate.title,
        instruction: candidate.instruction,
        stage: "imagePrompt",
        issueType: candidate.issueType,
        scope: "project",
        status: "active",
        keywords: candidate.keywords,
        sourceProjectId: activeProjectId,
        sourceHistoryId: historyEntry.id,
        projectId: activeProjectId,
        adoptedCount: 0,
        rejectedCount: 0,
      };
      let affectedCount = 0;
      const applyRule = (current: ImagePromptPackage[]) => current.map((prompt) => {
        const relatedShots = shotDraftsRef.current.filter(
          (shot) => (shot.referenceId ?? shot.id) === prompt.id,
        );
        const context = [
          prompt.title,
          prompt.prompt,
          ...relatedShots.flatMap((shot) => [
            shot.title,
            shot.speaker,
            shot.dialogue,
            shot.action.join(" "),
            shot.continuity,
          ]),
        ].filter(Boolean).join(" ");
        const matches = !ruleSeed.keywords.length || matchingKeywords(ruleSeed, context).length > 0;
        if (!matches) return prompt;
        affectedCount += 1;
        return {
          ...prompt,
          prompt: appendRulesToPrompt(prompt.prompt, [ruleSeed]),
          promptModel: undefined,
        };
      });
      applyRule(imagePromptDraftsRef.current);
      const rule = {
        ...ruleSeed,
        status: affectedCount > 0 ? "active" as const : "candidate" as const,
        adoptedCount: affectedCount,
      };
      const workspace = await saveReuseRule(rule);
      if (session !== projectSessionRef.current) return;
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      affectedCount = 0;
      updateImagePrompts(applyRule);
      setProjectHistory((current) => [historyEntry, ...current]);
      if (affectedCount > 0) {
        setBatchRuleResult(
          `${usedModel ? "文本模型已整理" : "已按当前要求整理"}，已修改 ${affectedCount} 个画面；规则已作为项目级启用规则存入规则库。`,
        );
        announce(`批量规则已应用到 ${affectedCount} 个画面并沉淀复用`);
      } else {
        const keywordHint = ruleSeed.keywords.length
          ? `当前画面没有出现“${ruleSeed.keywords.join(" / ")}”`
          : "当前项目还没有可修改的画面";
        setBatchRuleResult(`${keywordHint}，规则已存为待审核，未改动现有画面。`);
        announce("没有找到匹配画面，规则已存为待审核");
      }
    } catch (error) {
      if (session !== projectSessionRef.current) return;
      const message = error instanceof Error ? error.message : "批量规则保存失败";
      setBatchRuleResult(message);
      announce(message);
    } finally {
      if (session === projectSessionRef.current) {
        batchRuleInFlightRef.current = false;
        setBatchRuleLoading(false);
      }
    }
  };

  /**
   * 导入后的自动内容审核：让文本模型通读脚本，核对程序的分段与分类有没有和原文语义说反。
   *
   * 这是 2026-09-18 新增的独立步骤（不是既有的「AI 结构复核」——那个是人工触发的、
   * 针对案例边界与对白归属的重排建议）。两者的分工是：
   *   - 本步骤：**自动**、只读、只提问，回答「这段到底是现场动作还是后期特效」；
   *   - AI 结构复核：**人工触发**、可改写案例结构，回答「这几个案例该怎么切」。
   *
   * 失败与未配置都不阻断流程，只把状态显示在导入那一步。
   */
  const runScriptAudit = async (input: {
    paragraphs: ScriptParagraph[];
    cases: ExtractedCase[];
    title: string;
  }): Promise<ScriptAuditState | null> => {
    const empty = scriptAuditCounts([]);
    if (!aiConfiguration.configured) {
      const skipped: ScriptAuditState = {
        status: "skipped",
        summary: "未连接文本模型，已跳过脚本内容审核。",
        items: [],
        counts: empty,
        dropped: scriptAuditDropped(),
        model: "",
      };
      setScriptAudit(skipped);
      return skipped;
    }
    setScriptAudit({
      status: "running",
      summary: "正在让文本模型通读脚本，核对分段与分类…",
      items: [],
      counts: empty,
      dropped: scriptAuditDropped(),
      model: aiConfiguration.model,
    });
    try {
      const response = await fetch("/api/ai/script-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectTitle: input.title,
          paragraphs: input.paragraphs,
          cases: input.cases,
        }),
      });
      const data = (await response.json()) as Partial<ScriptAuditResult> & {
        error?: string;
        model?: string;
      };
      if (!response.ok || !Array.isArray(data.items)) {
        throw new Error(data.error ?? "脚本内容审核失败");
      }
      const result: ScriptAuditState = {
        status: "done",
        summary: data.summary || "脚本内容审核完成。",
        items: data.items,
        counts: data.counts ?? scriptAuditCounts(data.items),
        dropped: data.dropped ?? scriptAuditDropped(),
        model: data.model || aiConfiguration.model,
      };
      setScriptAudit(result);
      return result;
    } catch (error) {
      const failed: ScriptAuditState = {
        status: "error",
        summary:
          error instanceof Error ? error.message : "脚本内容审核失败，可先进入工作台。",
        items: [],
        counts: empty,
        dropped: scriptAuditDropped(),
        model: aiConfiguration.model,
      };
      setScriptAudit(failed);
      return failed;
    }
  };

  const reviewExtractionWithAi = async () => {
    if (!aiConfiguration.configured) {
      setManagementPanel("settings");
      editAiConnection();
      announce("先连接一个文本模型，再回到提取阶段复核结构");
      return;
    }
    setAiExtractionLoading(true);
    setAiExtractionReview(null);
    try {
      const response = await fetch("/api/ai/extraction-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectTitle,
          paragraphs: scriptDrafts,
          cases: caseDrafts,
          rules: matchedExtractionRules.map((rule) => rule.instruction),
        }),
      });
      const data = (await response.json()) as Partial<ExtractionReviewResult> & {
        error?: string;
        model?: string;
        rulesUsed?: number;
      };
      if (!response.ok || !data.cases || !data.issues || !data.summary) {
        throw new Error(data.error ?? "模型没有返回可用的结构复核结果");
      }
      const result = {
        summary: data.summary,
        cases: data.cases,
        issues: data.issues,
        changed: Boolean(data.changed),
        model: data.model || aiConfiguration.model,
        rulesUsed: data.rulesUsed ?? 0,
      };
      setAiExtractionReview(result);
      announce(
        result.changed
          ? `模型提出 ${result.cases.length} 个最小案例，等待你确认`
          : "规则结果与模型复核一致",
      );
    } catch (error) {
      announce(error instanceof Error ? error.message : "结构复核失败");
    } finally {
      setAiExtractionLoading(false);
    }
  };

  const applyAiExtractionReview = () => {
    if (!aiExtractionReview) return;
    const nextCases = aiExtractionReview.cases;
    const dialogueCount = nextCases.reduce(
      (sum, item) => sum + item.dialogueCount,
      0,
    );
    const checks: ScriptReviewReport["checks"] = [
        ...scriptReview.checks
          .filter((check) => check.label !== "AI 结构复核")
          .map((check) => {
            if (check.label === "大案例识别") {
              return {
                ...check,
                status: nextCases.length ? "PASS" as const : "BLOCKED" as const,
                detail: nextCases.length
                  ? `结构复核确认 ${new Set(nextCases.map((item) => item.group)).size} 个内容主题`
                  : "没有可用的内容主题",
              };
            }
            if (check.label === "最小案例识别") {
              return {
                ...check,
                status: "PASS" as const,
                detail: `规则初提后，文本模型建议 ${nextCases.length} 个最小案例`,
              };
            }
            if (check.label === "人物对白覆盖") {
              return {
                ...check,
                status: dialogueCount ? "PASS" as const : "BLOCKED" as const,
                detail: `结构复核标出 ${dialogueCount} 句人物对白`,
              };
            }
            return check;
          }),
        {
          label: "AI 结构复核",
          status: aiExtractionReview.issues.length
            ? "REVISE"
            : dialogueCount
              ? "PASS"
              : "BLOCKED",
          detail: aiExtractionReview.issues.length
            ? `${aiExtractionReview.issues.length} 项规则与 AI 分歧需要人工核对`
            : `原文段落编号与对白归属已通过程序校验 · ${aiExtractionReview.model}`,
        },
      ];
    const status: ScriptReviewReport["status"] = checks.some((check) => check.status === "BLOCKED")
      ? "BLOCKED"
      : checks.some((check) => check.status === "REVISE")
        ? "REVISE"
        : "PASS";
    const nextReview: ScriptReviewReport = {
      status,
      checks,
      flags: aiExtractionReview.issues.map((issue) => issue.message),
      issues: aiExtractionReview.issues,
    };

    if (aiExtractionReview.changed) {
      const nextWork = rebuildCurrentStoryboard(nextCases, scriptDrafts);
      const nextShots = nextWork.shots;
      const nextPrompts = nextWork.prompts;
      setCaseDrafts(nextCases);
      applyStoryboardWork(nextWork);
      setSelectedCaseId(nextCases[0].id);
      setSelectedId(nextShots[0].id);
      setSelectedImagePromptId(nextPrompts[0].id);
      setWorkflowStage(status === "PASS" ? "cases" : "scriptReview");
      setCurrentStage(status === "PASS" ? "cases" : "scriptReview");
      setSourceChanged(true);
    } else {
      setWorkflowStage(status === "PASS" ? workflowStage : "scriptReview");
      setCurrentStage(status === "PASS" ? "cases" : "scriptReview");
    }
    setScriptReview(nextReview);
    setExtractionEngine((current) =>
      `${current.replace(/\s·\s[^·]+结构复核.*$/u, "")} · ${aiExtractionReview.model} 结构复核`,
    );
    setProjectHistory((current) => [
      {
        id: createProjectId(),
        kind: "feedback",
        createdAt: new Date().toISOString(),
        title: "已采用文本模型结构复核结果",
        stage: "cases",
        targetId: sourceFileName,
        issueType: "脚本提取",
        reason: `${aiExtractionReview.summary}；使用 ${aiExtractionReview.rulesUsed} 条已启用提取规则。`,
        before: caseDrafts.map((item) => `${item.id}:${item.sourceIds.join(",")}`).join("；"),
        after: nextCases.map((item) => `${item.id}:${item.sourceIds.join(",")}`).join("；"),
        decision: "adopted",
      },
      ...current,
    ]);
    setAiExtractionReview(null);
    announce(
      aiExtractionReview.changed
        ? "已采用结构建议，下游分镜与画面词已按新案例重建"
        : "复核结论已写入脚本审查",
    );
  };

  const handleScriptUpload = async (
    event: ChangeEvent<HTMLInputElement>,
    context: "replace" | "new" = "replace",
  ) => {
    const session = projectSessionRef.current;
    const file = event.target.files?.[0];
    if (!file) return;
    setAiExtractionReview(null);
    setIsParsingWord(true);
    if (context === "new") {
      setNewProjectUploadStatus("uploading");
      setNewProjectUploadSummary(null);
    }
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/parse-docx", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as {
        error?: string;
        fileName?: string;
        paragraphs?: ScriptParagraph[];
        cases?: ExtractedCase[];
        review?: ScriptReviewReport;
        engine?: string;
        extractionMode?: string;
      };
      if (
        !response.ok ||
        !data.paragraphs ||
        !data.fileName ||
        !data.cases?.length ||
        !data.review
      ) {
        throw new Error(data.error ?? "Word 解析失败");
      }
      const nextShots = buildShotsFromCases(data.cases, data.paragraphs);
      const nextPrompts = buildImagePrompts(nextShots);
      const nextReview = {
        ...data.review,
        issues: Array.isArray(data.review.issues)
          ? data.review.issues
          : issuesFromFlags(data.review.flags),
      };
      if (context === "new") {
        const inferredTitle = data.fileName.replace(/\.docx$/iu, "");
        setPendingProject({
          fileName: data.fileName,
          paragraphs: data.paragraphs,
          cases: data.cases,
          shots: nextShots,
          prompts: nextPrompts,
          review: nextReview,
          extractionEngine: publicEngineLabel(
            data.engine ?? "脚本结构提取器",
          ),
          audit: null,
        });
        setDraftProjectName((current) => current.trim() || inferredTitle);
        // Word 已经读完，接下来只剩审核；上传态在这里收尾，避免下面那段仍显示「正在读取 Word」。
        setIsParsingWord(false);
        // 导入完成 → 自动内容审核 → 才允许进入脚本工作台。用户不需要点任何按钮，
        // 但这一步是真实存在的、有顺序的：审核跑完（不论结果）按钮才可用，
        // 审核失败或未配置模型都不阻断，避免用一个可能出错的模型判断卡死流程。
        setNewProjectUploadStatus("auditing");
        setNewProjectUploadSummary({
          fileName: data.fileName,
          paragraphCount: data.paragraphs.length,
          caseCount: data.cases.length,
        });
        announce(
          `已读取 ${data.paragraphs.length} 段，并识别 ${data.cases.length} 个最小案例`,
        );
        const audit = await runScriptAudit({
          paragraphs: data.paragraphs,
          cases: data.cases,
          title: inferredTitle,
        });
        setPendingProject((current) =>
          current ? { ...current, audit } : current,
        );
        setNewProjectUploadStatus("ready");
        if (audit?.status === "done") {
          announce(
            audit.items.length
              ? `脚本内容审核发现 ${audit.items.length} 项需要确认`
              : "脚本内容审核未发现问题",
          );
        }
        return;
      }

      if (session !== projectSessionRef.current) return;
      projectSessionRef.current += 1;
      resetProductionRequests();
      setScriptDrafts(data.paragraphs);
      setCaseDrafts(data.cases);
      setShotDrafts(nextShots);
      setImagePromptDrafts(nextPrompts);
      shotDraftsRef.current = nextShots;
      imagePromptDraftsRef.current = nextPrompts;
      setScriptReview(nextReview);
      setExtractionEngine(
        publicEngineLabel(data.engine ?? "脚本结构提取器"),
      );
      setSelectedCaseId(data.cases[0].id);
      setSelectedId(nextShots[0].id);
      setSelectedImagePromptId(nextPrompts[0].id);
      const previousSourceFileName = sourceFileName;
      setSourceFileName(data.fileName);
      setProjectHistory((current) => [
        {
          id: createProjectId(),
          kind: "source-replaced",
          createdAt: new Date().toISOString(),
          title: "已替换当前项目的原始 Word",
          stage: "script",
          reason: `${previousSourceFileName} → ${data.fileName}`,
        },
        ...current,
      ]);
      setSourceChanged(true);
      setCurrentStage("script");
      setWorkflowStage("script");
      announce(
        `已读取 ${data.paragraphs.length} 段，并识别 ${data.cases.length} 个最小案例`,
      );
      // 替换 Word 同样走一遍自动内容审核，结果并进脚本审查记录（不阻断已有流程）。
      void runScriptAudit({
        paragraphs: data.paragraphs,
        cases: data.cases,
        title: data.fileName.replace(/\.docx$/iu, ""),
      }).then((audit) => {
        if (!audit || audit.status !== "done" || !audit.items.length) return;
        setScriptReview((current) => scriptAuditReview(current, audit));
        announce(
          `脚本内容审核发现 ${audit.items.length} 项需要确认，见「脚本审查」`,
        );
      });
    } catch (error) {
      if (context === "new") setNewProjectUploadStatus("error");
      announce(error instanceof Error ? error.message : "Word 解析失败");
    } finally {
      setIsParsingWord(false);
      event.target.value = "";
    }
  };

  const commitSelectedReference = (
    promptId: string, selectedImage: string, sourceName: string,
    mediaSource?: ImagePromptPackage["mediaSource"],
  ) => {
    const signatureShot = shotDraftsRef.current.find(shot => shot.id === promptId || shot.referenceId === promptId);
    if (!signatureShot) return;
    const signature = shotVisualSignature(signatureShot);
    applyStoryboardWork({
      shots: shotDraftsRef.current.map(shot => shot.id === signatureShot.id
        ? { ...shot, image: selectedImage, imageSourceSignature: signature, status: "ready" } : shot),
      prompts: imagePromptDraftsRef.current.map(prompt => prompt.id === promptId
        ? { ...prompt, image: selectedImage, status: "ready", mediaSource,
          imageSourceSignature: signature, imageNeedsReview: false } : prompt),
    });
    setUploadedNames(current => ({ ...current, [promptId]: sourceName }));
  };

  /** 2026-09-16 晚：分镜修改后用户看过图、决定不重选——把签名刷新为当前分镜，解除过期。 */
  const reaffirmReferenceImage = (promptId: string) => {
    const shot = shotDraftsRef.current.find(item => item.id === promptId || item.referenceId === promptId);
    if (!shot) return;
    applyStoryboardWork({ shots: shotDraftsRef.current,
      prompts: imagePromptDraftsRef.current.map(prompt => prompt.id === promptId
        ? { ...prompt, imageSourceSignature: shotVisualSignature(shot), imageNeedsReview: false } : prompt) });
    announce(`${shotDisplayLabel(shotDraftsRef.current, promptId)} 已按当前分镜及衔接确认保留参考图`);
  };

  const clearSelectedReference = (promptId: string) => {
    applyStoryboardWork({
      shots: shotDraftsRef.current.map(shot => shot.id === promptId || shot.referenceId === promptId
        ? { ...shot, image: undefined, imageSourceSignature: undefined, status: "missing" } : shot),
      prompts: imagePromptDraftsRef.current.map(prompt => prompt.id === promptId
        ? { ...prompt, image: undefined, status: "missing", mediaSource: undefined,
          imageSourceSignature: undefined, imageNeedsReview: false } : prompt),
    });
    setUploadedNames(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== promptId)));
    const index = stages.findIndex(stage => stage.key === "imagePrompt");
    setWorkflowStage(current => stages.findIndex(stage => stage.key === current) > index ? "imagePrompt" : current);
  };

  const withdrawSelectedImage = () => {
    const sourceName = uploadedNames[selectedImagePrompt.id];
    const sourceJob = mediaJobs.find((job) =>
      job.mediaType === "image" &&
      job.targetId === selectedImagePrompt.id &&
      job.candidates.some((candidate) =>
        candidateMatchesSelectedImage(
          job,
          candidate,
          selectedImagePrompt.mediaSource,
          sourceName,
        ),
      ),
    );
    const sourceCandidate = sourceJob?.candidates.find((candidate) =>
      candidateMatchesSelectedImage(
        sourceJob,
        candidate,
        selectedImagePrompt.mediaSource,
        sourceName,
      ),
    );
    if (sourceJob && sourceCandidate) {
      beginMediaCandidateRejection(sourceJob, sourceCandidate);
      return;
    }
    clearSelectedReference(selectedImagePrompt.id);
    setMediaMessage("已撤回当前已选图，可重新选择、上传或生成。");
    announce("已撤回当前已选图");
  };

  const applyReferenceFile = async (file: File, sourceLabel: string) => {
    if (!file || !selectedImagePrompt) return;
    const session = projectSessionRef.current;
    const original = shotDraftsRef.current.find(shot => (shot.referenceId ?? shot.id) === selectedImagePrompt.id);
    if (!original) return;
    const signature = videoPromptSourceSignature(original);
    try {
      const promptId = selectedImagePrompt.id;
      const selectedImage = await blobToDataUrl(file);
      if (session !== projectSessionRef.current) return;
      const latest = shotDraftsRef.current.find(shot => shot.id === original.id);
      if (!latest || videoPromptSourceSignature(latest) !== signature) {
        announce("读取图片期间分镜已修改，请检查当前分镜后重新上传");
        return;
      }
      commitSelectedReference(promptId, selectedImage, file.name || sourceLabel);
      announce(`${shotDisplayLabel(shotDrafts, promptId)} 已从${sourceLabel}回填原图`);
    } catch {
      if (session !== projectSessionRef.current) return;
      announce("图片读取失败，请改用 PNG、JPG 或 WebP 文件");
    }
  };

  const handleReferenceUpload = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file) await applyReferenceFile(file, "上传文件");
    event.target.value = "";
  };

  const handleReferencePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (currentStage !== "imagePrompt") return;
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/"),
    );
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void applyReferenceFile(file, "剪贴板图片");
  };

  const depositCurrentAsset = async () => {
    if (!selectedImagePrompt.image || selectedImagePrompt.status !== "ready") {
      announce("请先回填一张已选图片");
      return;
    }
    const existing = referenceAssets.find(
      (asset) =>
        asset.sourceProjectId === activeProjectId &&
        asset.sourcePromptId === selectedImagePrompt.id,
    );
    const now = new Date().toISOString();
    const asset: ReferenceAsset = {
      id: existing?.id ?? createProjectId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceProjectId: activeProjectId,
      sourcePromptId: selectedImagePrompt.id,
      title: `${projectTitle} · ${selectedImagePrompt.title}`,
      image: selectedImagePrompt.image,
      prompt: selectedImagePrompt.prompt,
      tags: inferAssetTags(selectedImagePrompt.title, selectedImagePrompt.prompt),
      usageCount: existing?.usageCount ?? 0,
      kind: existing?.kind ?? "scene",
      roleName: existing?.roleName,
      builtIn: existing?.builtIn,
    };
    try {
      const workspace = await saveReferenceAsset(asset);
      setReferenceAssets(workspace.assets);
      setReuseRules(workspace.rules);
      announce(existing ? "素材库记录已更新" : "已沉淀到全局图片素材库");
    } catch (error) {
      announce(error instanceof Error ? error.message : "素材沉淀失败");
    }
  };

  const reuseReferenceAsset = async (asset: ReferenceAsset) => {
    if (asset.kind === "character") {
      announce("人物资产用于锁定角色，不会替代当前镜头的成图");
      return;
    }
    commitSelectedReference(selectedImagePrompt.id, asset.image, `素材库 · ${asset.title}`);
    try {
      const workspace = await saveReferenceAsset({
        ...asset,
        updatedAt: new Date().toISOString(),
        usageCount: asset.usageCount + 1,
      });
      setReferenceAssets(workspace.assets);
      setReuseRules(workspace.rules);
      setCurrentStage("imagePrompt");
      setManagementPanel(null);
      announce("素材库图片已作为当前参考图复用");
    } catch {
      announce("图片已放入当前项目，但素材使用次数保存失败");
    }
  };

  const applyCharacterAsset = async (asset: ReferenceAsset) => {
    const instruction = `${asset.roleName ?? "该角色"}的眼镜、发型、脸型和服装严格参考上传的人物图；只参考人物外观，不复制参考图的背景、姿态和构图。`;
    updateImagePrompts((current) =>
      current.map((item) =>
        item.id === selectedImagePrompt.id && !item.prompt.includes(instruction)
          ? {
              ...item,
              prompt: `${cleanImagePromptForProvider(item.prompt)}\n${instruction}`,
              promptModel: undefined,
            }
          : item,
      ),
    );
    try {
      const workspace = await saveReferenceAsset({
        ...asset,
        updatedAt: new Date().toISOString(),
        usageCount: asset.usageCount + 1,
      });
      setReferenceAssets(workspace.assets);
      setReuseRules(workspace.rules);
      setManagementPanel(null);
      setCurrentStage("imagePrompt");
      announce(`${asset.roleName ?? "人物"}参考要求已加入当前画面词`);
    } catch {
      announce("人物参考要求已加入，但素材使用次数保存失败");
    }
  };

  const downloadReferenceAsset = (asset: ReferenceAsset) => {
    const link = document.createElement("a");
    link.href = asset.image;
    link.download = `${asset.roleName || asset.title || "人物参考"}.png`.replace(
      /[<>:"/\\|?*]/gu,
      "_",
    );
    link.click();
    announce(`${asset.title} 已下载，可与提示词一起上传到豆包`);
  };

  const updateRuleStatus = async (rule: ReuseRule, status: ReuseRule["status"]) => {
    try {
      const workspace = await saveReuseRule({
        ...rule,
        status,
        updatedAt: new Date().toISOString(),
      });
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      announce(status === "active" ? "规则已启用，将参与相似提示词匹配" : "规则已停用");
    } catch (error) {
      announce(error instanceof Error ? error.message : "规则状态保存失败");
    }
  };

  const editRuleLocally = (id: string, patch: Partial<ReuseRule>) => {
    setReuseRules((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  };

  const saveRuleEdits = async (rule: ReuseRule) => {
    if (!rule.title.trim() || !rule.instruction.trim()) {
      announce("规则标题和规则内容不能为空");
      return;
    }
    try {
      const workspace = await saveReuseRule({
        ...rule,
        title: rule.title.trim(),
        instruction: rule.instruction.trim(),
        projectId:
          rule.scope === "project" ? rule.projectId || activeProjectId : undefined,
        updatedAt: new Date().toISOString(),
      });
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      announce("规则修改已保存");
    } catch (error) {
      announce(error instanceof Error ? error.message : "规则修改保存失败");
    }
  };

  const undoRuleEdit = async (rule: ReuseRule) => {
    try {
      const workspace = await undoReuseRule(rule.id);
      setReuseRules(workspace.rules);
      setReferenceAssets(workspace.assets);
      announce("已恢复这条规则的上一个版本；再次撤销可切回当前版本");
    } catch (error) {
      announce(error instanceof Error ? error.message : "规则撤销失败");
    }
  };

  const editAssetLocally = (id: string, patch: Partial<ReferenceAsset>) => {
    setReferenceAssets((current) =>
      current.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
    );
  };

  const saveAssetEdits = async (asset: ReferenceAsset) => {
    if (!asset.title.trim()) {
      announce("素材名称不能为空");
      return;
    }
    if (asset.kind === "character" && !asset.roleName?.trim()) {
      announce("人物资产需要填写角色名称");
      return;
    }
    try {
      const workspace = await saveReferenceAsset({
        ...asset,
        title: asset.title.trim(),
        updatedAt: new Date().toISOString(),
      });
      setReferenceAssets(workspace.assets);
      setReuseRules(workspace.rules);
      announce("素材名称和标签已保存");
    } catch (error) {
      announce(error instanceof Error ? error.message : "素材信息保存失败");
    }
  };

  const applyImageRule = async (rule: ReuseRule) => {
    const alreadyRecorded = projectHistory.some(
      (entry) =>
        entry.kind === "feedback" &&
        entry.issueType === "规则复用" &&
        entry.targetId === selectedImagePrompt.id &&
        entry.before === rule.id,
    );
    if (alreadyRecorded) {
      announce("当前画面已经记录过这条规则的使用结果");
      return;
    }
    updateImagePrompts((current) =>
      current.map((item) =>
        item.id === selectedImagePrompt.id
          ? {
              ...item,
              prompt: appendRulesToPrompt(item.prompt, [rule]),
              promptModel: undefined,
            }
          : item,
      ),
    );
    setProjectHistory((current) => [
      {
        id: createProjectId(),
        kind: "feedback",
        createdAt: new Date().toISOString(),
        title: `采用复用规则：${rule.title}`,
        stage: "imagePrompt",
        targetId: selectedImagePrompt.id,
        issueType: "规则复用",
        reason: rule.instruction,
        before: rule.id,
        decision: "adopted",
      },
      ...current,
    ]);
    try {
      const workspace = await recordRuleDecision(rule.id, "adopted");
      setReuseRules(workspace.rules);
      announce("规则已加入当前提示词，并记录一次采用");
    } catch {
      announce("规则已加入提示词，但采用次数保存失败");
    }
  };

  const rejectImageRule = async (rule: ReuseRule) => {
    const alreadyRecorded = projectHistory.some(
      (entry) =>
        entry.kind === "feedback" &&
        entry.issueType === "规则复用" &&
        entry.targetId === selectedImagePrompt.id &&
        entry.before === rule.id,
    );
    if (alreadyRecorded) {
      announce("当前画面已经记录过这条规则的使用结果");
      return;
    }
    setProjectHistory((current) => [
      {
        id: createProjectId(),
        kind: "feedback",
        createdAt: new Date().toISOString(),
        title: `拒绝复用规则：${rule.title}`,
        stage: "imagePrompt",
        targetId: selectedImagePrompt.id,
        issueType: "规则复用",
        reason: rule.instruction,
        before: rule.id,
        decision: "rejected",
      },
      ...current,
    ]);
    try {
      const workspace = await recordRuleDecision(rule.id, "rejected");
      setReuseRules(workspace.rules);
      announce("已记录当前任务不适用这条规则");
    } catch (error) {
      announce(error instanceof Error ? error.message : "拒绝记录保存失败");
    }
  };

  const selectCase = (item: ExtractedCase) => {
    setSelectedCaseId(item.id);
    window.requestAnimationFrame(() => {
      document
        .getElementById(`paragraph-${item.sourceIds[0]}`)
        ?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "center",
        });
    });
  };

  const toggleParagraphExtraction = (paragraphId: number) => {
    const paragraph = scriptDrafts.find((item) => item.id === paragraphId);
    if (!paragraph || !selectedCase) return;
    const currentOwner = caseDrafts.find((item) => item.sourceIds.includes(paragraphId));
    const removing = currentOwner?.id === selectedCase.id;
    const nextCases = caseDrafts.map((item) => {
      const withoutSource = item.sourceIds.filter((id) => id !== paragraphId);
      const withoutItems = (item.items ?? []).filter((row) => row.sourceId !== paragraphId);
      const isTarget = item.id === selectedCase.id && !removing;
      const sourceIds = isTarget
        ? [...withoutSource, paragraphId].sort((left, right) => left - right)
        : withoutSource;
      const items = isTarget
        ? [...withoutItems, ...paragraphCaseItems(paragraph)]
            .sort((left, right) => left.sourceId - right.sourceId || (left.sourceSegment ?? 0) - (right.sourceSegment ?? 0))
        : withoutItems;
      const title = items.find((row) => row.type === "title_context")?.text;
      const scene = items.find((row) =>
        row.type === "visual_direction" && /场景设定|场景[：:]|画面[：:]/u.test(row.text),
      )?.text;
      return {
        ...item,
        sourceIds,
        items,
        dialogueCount: items.filter((row) => row.type === "dialogue").length,
        context: {
          ...item.context,
          title,
          scene,
        },
        note: "案例范围已人工调整，等待脚本审查确认。",
      };
    });
    const nextWork = rebuildCurrentStoryboard(nextCases, scriptDrafts);
    const nextShots = nextWork.shots;
    const shotCounts = new Map<string, number>();
    nextShots.forEach((shot) => {
      const caseId = shotCaseId(shot);
      shotCounts.set(caseId, (shotCounts.get(caseId) ?? 0) + 1);
    });
    setCaseDrafts(nextCases.map((item) => ({
      ...item,
      storyboardCount: shotCounts.get(item.id) ?? 0,
    })));
    applyStoryboardWork(nextWork);
    setSourceChanged(true);
    setWorkflowStage("scriptReview");
    setScriptReview((current) => ({
      ...current,
      status: "REVISE",
      flags: [...new Set([...current.flags, `第${paragraphId}段的案例范围已人工调整`])],
      issues: [
        ...current.issues.filter((issue) => issue.sourceId !== paragraphId),
        {
          message: `第${paragraphId}段的案例范围已人工调整。`,
          sourceId: paragraphId,
          caseId: removing ? undefined : selectedCase.id,
          sourceText: paragraph.text,
          reason: removing
            ? "该段已从当前案例移除。"
            : currentOwner
              ? `该段已从 ${currentOwner.id} 移入 ${selectedCase.id}。`
              : `该段已纳入 ${selectedCase.id}。`,
          question: "请确认当前案例范围是否正确。",
          action: "继续点选可撤销或重新纳入；确认后进入脚本审查。",
        },
      ],
    }));
    announce(removing
      ? `第${paragraphId}段已从 ${selectedCase.id} 移除，再点一次可恢复`
      : currentOwner
        ? `第${paragraphId}段已从 ${currentOwner.id} 移入 ${selectedCase.id}`
        : `第${paragraphId}段已纳入 ${selectedCase.id}`);
  };

  const updateManualParagraphKind = (
    paragraphId: number,
    kind: ScriptParagraph["kind"],
    requestedCaseId?: string,
  ) => {
    const paragraph = scriptDrafts.find((item) => item.id === paragraphId);
    if (!paragraph) return;
    const shouldInclude = kind === "dialogue" || kind === "action" || kind === "note" || kind === "heading";
    const targetCaseId = requestedCaseId ||
      caseDrafts.find((item) => item.sourceIds.includes(paragraphId))?.id ||
      selectedCaseId ||
      caseDrafts[0]?.id;
    if (shouldInclude && !targetCaseId) return;
    const manualItems = paragraphCaseItems(paragraph, kind);
    const nextScript = scriptDrafts.map((item) =>
      item.id === paragraphId ? { ...item, kind } : item,
    );
    const nextCases = caseDrafts.map((item) => {
      const isTarget = shouldInclude && item.id === targetCaseId;
      const movedAway = item.sourceIds.filter((id) => id !== paragraphId);
      const withoutParagraph = (item.items ?? []).filter(
        (row) => row.sourceId !== paragraphId,
      );
      if (!isTarget) {
        return {
          ...item,
          sourceIds: movedAway,
          items: withoutParagraph,
          dialogueCount: withoutParagraph.filter((row) => row.type === "dialogue").length,
        };
      }
      const sourceIds = item.sourceIds.includes(paragraphId)
        ? item.sourceIds
        : [...item.sourceIds, paragraphId].sort((left, right) => left - right);
      const nextItems = shouldInclude
        ? [...withoutParagraph, ...manualItems]
            .sort((left, right) => left.sourceId - right.sourceId || (left.sourceSegment ?? 0) - (right.sourceSegment ?? 0))
        : withoutParagraph;
      const dialogueCount = nextItems.filter((row) => row.type === "dialogue").length;
      return {
        ...item,
        sourceIds,
        items: nextItems,
        dialogueCount,
        context: kind === "heading"
          ? { ...item.context, title: paragraph.text }
          : kind === "note" && /场景设定|场景[：:]|画面[：:]/u.test(paragraph.text)
            ? { ...item.context, scene: paragraph.text }
            : item.context,
        note: "已人工修改，等待重新确认脚本审查。",
      };
    });
    const nextWork = rebuildCurrentStoryboard(nextCases, nextScript);
    setScriptDrafts(nextScript);
    setCaseDrafts(nextCases);
    applyStoryboardWork(nextWork);
    setSourceChanged(true);
    setWorkflowStage("scriptReview");
    setCurrentStage("scriptReview");
    setScriptReview((current) => ({
      ...current,
      status: "REVISE",
      flags: [...new Set([
        ...current.flags,
        `第${paragraphId}段已人工改为${kind === "dialogue" ? "对白" : kind === "action" ? "动作" : kind === "note" ? "场景/说明" : kind === "heading" ? "标题" : kind === "meta" ? "结构" : "排除"}`,
      ])],
      issues: [
        ...current.issues.filter((issue) => issue.sourceId !== paragraphId),
        {
          message: `第${paragraphId}段已人工修改，需重新确认案例归属和下游分镜。`,
          sourceId: paragraphId,
          caseId: shouldInclude ? targetCaseId : undefined,
          sourceText: paragraph.text,
          reason: "人工分类会重建当前案例的对白、动作和分镜。",
          question: "请确认这次修改后的段落类型和说话人是否正确。",
          action: "继续核对后，再进入分镜制作。",
        },
      ],
    }));
    announce(`第${paragraphId}段已修改，受影响案例的分镜已重建`);
  };

  const updateManualParagraphText = (paragraphId: number, text: string) => {
    setScriptDrafts((current) => current.map((item) =>
      item.id === paragraphId ? { ...item, text } : item,
    ));
    setSourceChanged(true);
  };

  const commitManualParagraphText = (paragraphId: number, text: string) => {
    const paragraph = scriptDrafts.find((item) => item.id === paragraphId);
    if (!paragraph) return;
    const nextParagraph = { ...paragraph, text };
    const nextScript = scriptDrafts.map((item) =>
      item.id === paragraphId ? nextParagraph : item,
    );
    const nextCases = caseDrafts.map((item) => {
      if (!item.sourceIds.includes(paragraphId)) return item;
      const withoutParagraph = (item.items ?? []).filter(
        (row) => row.sourceId !== paragraphId,
      );
      const previousParagraphItems = (item.items ?? []).filter(
        (row) => row.sourceId === paragraphId,
      );
      const replacementItems = paragraphCaseItems(nextParagraph).map((row) => {
        if (row.type !== "dialogue") return row;
        const previous = previousParagraphItems.find((candidate) =>
          candidate.type === "dialogue" && candidate.sourceSegment === row.sourceSegment,
        );
        return previous?.speaker && row.speaker?.startsWith(previous.speaker)
          ? { ...row, speaker: previous.speaker }
          : row;
      });
      const nextItems = [
        ...withoutParagraph,
        ...replacementItems,
      ].sort((left, right) =>
        left.sourceId - right.sourceId || (left.sourceSegment ?? 0) - (right.sourceSegment ?? 0),
      );
      return {
        ...item,
        items: nextItems,
        dialogueCount: nextItems.filter((row) => row.type === "dialogue").length,
        context: {
          ...item.context,
          title: paragraph.kind === "heading" ? text : item.context?.title,
          scene: paragraph.kind === "note" && /场景设定|场景[：:]|画面[：:]/u.test(text)
            ? text
            : item.context?.scene,
        },
        note: "正文已人工修改，等待重新确认脚本审查。",
      };
    });
    const nextWork = rebuildCurrentStoryboard(nextCases, nextScript);
    setScriptDrafts(nextScript);
    setCaseDrafts(nextCases);
    applyStoryboardWork(nextWork);
    setSourceChanged(true);
    setScriptReview((current) => ({
      ...current,
      status: "REVISE",
      flags: [...new Set([...current.flags, `第${paragraphId}段正文已人工修改`])],
      issues: [
        ...current.issues.filter((issue) => issue.sourceId !== paragraphId),
        {
          message: `第${paragraphId}段正文已修改。`,
          sourceId: paragraphId,
          sourceText: text,
          reason: "正文变更会同步重建相关对白、动作与下游分镜。",
          question: "请确认修改后的文字和段落类型是否正确。",
          action: "确认无误后，点击“应用人工修正并重新审查”。",
        },
      ],
    }));
    announce(`第${paragraphId}段正文已保存，相关分镜已同步重建`);
  };

  const updateManualParagraphSpeaker = (
    paragraphId: number,
    sourceSegment: number | undefined,
    speaker: string,
  ) => {
    const cleanSpeaker = speaker.trim().slice(0, 40);
    if (!cleanSpeaker) return;
    const nextCases = caseDrafts.map((item) => ({
      ...item,
      items: (item.items ?? []).map((row) =>
        row.sourceId === paragraphId &&
        row.type === "dialogue" &&
        row.sourceSegment === sourceSegment
          ? { ...row, speaker: cleanSpeaker }
          : row,
      ),
    }));
    const nextWork = rebuildCurrentStoryboard(nextCases, scriptDrafts);
    setCaseDrafts(nextCases);
    applyStoryboardWork(nextWork);
    setSourceChanged(true);
    setScriptReview((current) => ({
      ...current,
      status: "REVISE",
      issues: current.issues,
    }));
    announce(`第${paragraphId}段${sourceSegment ? `第${sourceSegment}句` : ""}说话人已改为“${cleanSpeaker}”`);
  };

  const confirmManualScriptReview = () => {
    const dialogueItems = caseDrafts.flatMap((item) =>
      (item.items ?? []).filter((row) => row.type === "dialogue"),
    );
    const unresolvedSpeakers = dialogueItems.filter((item) =>
      !item.speaker?.trim() || /^(?:待确认人物|[A-ZＡ-Ｚ甲乙丙丁])$/u.test(item.speaker.trim()),
    );
    const missingContext = caseDrafts.filter((item) =>
      !item.context?.title && !item.context?.scene,
    );
    const caseIds = caseDrafts.map((item) => item.id);
    const validCaseIds = new Set(caseIds).size === caseIds.length &&
      caseIds.every((id) => /^S\d+-E\d+$/u.test(id));
    const checks: ScriptReviewReport["checks"] = [
      {
        label: "大案例识别",
        status: caseDrafts.length ? "PASS" : "BLOCKED",
        detail: caseDrafts.length
          ? `人工确认 ${new Set(caseDrafts.map((item) => item.group)).size} 个内容主题`
          : "没有可用的内容主题",
      },
      {
        label: "最小案例识别",
        status: caseDrafts.length ? "PASS" : "BLOCKED",
        detail: caseDrafts.length ? `人工确认 ${caseDrafts.length} 个最小案例` : "没有最小案例",
      },
      {
        label: "标题与场景上下文",
        status: missingContext.length ? "REVISE" : "PASS",
        detail: missingContext.length
          ? `${missingContext.length} 个案例尚未关联标题或场景说明`
          : "标题、场景与动作上下文会随对白进入分镜规划",
      },
      {
        label: "人物对白覆盖",
        status: dialogueItems.length ? "PASS" : "BLOCKED",
        detail: dialogueItems.length ? `人工确认 ${dialogueItems.length} 句人物对白` : "没有人物对白",
      },
      {
        label: "角色简称",
        status: unresolvedSpeakers.length ? "REVISE" : "PASS",
        detail: unresolvedSpeakers.length
          ? `${unresolvedSpeakers.length} 句对白仍需补全说话人`
          : "所有对白均有可追踪说话人",
      },
      {
        label: "案例 ID",
        status: validCaseIds ? "PASS" : "BLOCKED",
        detail: validCaseIds ? "案例 ID 唯一且格式正确" : "案例 ID 有重复或格式错误",
      },
      {
        label: "人工复核",
        status: missingContext.length || unresolvedSpeakers.length ? "REVISE" : "PASS",
        detail: "已按当前人工标记重新计算案例、对白和下游分镜",
      },
    ];
    const status: ScriptReviewReport["status"] = checks.some((check) => check.status === "BLOCKED")
      ? "BLOCKED"
      : checks.some((check) => check.status === "REVISE")
        ? "REVISE"
        : "PASS";
    const issues: ScriptReviewIssue[] = [
      ...unresolvedSpeakers.map((item) => ({
        message: `第${item.sourceId}段仍需确认说话人`,
        sourceId: item.sourceId,
        sourceText: scriptDrafts.find((paragraph) => paragraph.id === item.sourceId)?.text,
        reason: "说话人仍是简称或待确认占位名。",
        question: "这句话由谁说出？",
        action: "在左侧对应对白下方填写完整角色名。",
      })),
      ...missingContext.map((item) => ({
        message: `${item.id} 尚未关联标题或场景`,
        caseId: item.id,
        sourceId: item.sourceIds[0],
        reason: "缺少标题或场景上下文会降低后续分镜理解准确性。",
        question: "哪一段是这个案例的标题或场景说明？",
        action: "先在“提取”阶段把对应段落点选进案例，再回这里改为“场景”或“标题”。",
      })),
    ];
    setScriptReview({
      status,
      checks,
      flags: issues.map((issue) => issue.message),
      issues,
    });
    setWorkflowStage("scriptReview");
    setCurrentStage("scriptReview");
    setSourceChanged(true);
    announce(status === "PASS" ? "人工修正已确认，可以进入镜头制作" : "已重新审查，请继续处理标出的项目");
  };

  const focusReviewIssue = (issue: ScriptReviewIssue) => {
    if (!issue.sourceId) return;
    setCurrentStage("scriptReview");
    window.requestAnimationFrame(() => {
      const paragraph = document.getElementById(`paragraph-${issue.sourceId}`);
      paragraph?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
      paragraph?.focus({ preventScroll: true });
    });
  };

  const selectProductionItem = (id: string) => {
    if (shotDrafts.some((item) => item.id === id)) setSelectedId(id);
    if (imagePromptDrafts.some((item) => item.id === id)) {
      setSelectedImagePromptId(id);
    }
  };

  const applyCaseStructure = (
    chunks: ExtractedCaseItem[][],
    selectedIndex: number,
    message: string,
  ) => {
    if (!selectedShotCase) return;
    // ── 2026-10-07（Layer 1）───────────────────────────────────────────────
    // 这里以前整片清空重建被编辑案例的分镜，再用
    // `!prompt.id.startsWith(`${selectedShotCaseId}-`)` 把「被编辑案例之外」的画面词
    // 原样保留——于是**用户手动拆一次分镜，该案例内所有已采用的图和确认状态全被清掉**，
    // 哪怕绝大多数分镜根本没被改动。
    //
    // 现在统一走内容身份配对：没被拆分/合并影响的分镜拿回自己的图、画面词与确认状态，
    // 只有真正被改动的那一两镜回到待确认。`storyboardConfirmed` 也跟着回来——
    // 确认状态是生成视频的闸门，误清会让用户以为要全部重做一遍。
    const rebuiltRaw = recalculateShotTimings(
      buildCaseShots(selectedShotCase, chunks),
      speechRate,
    );
    const caseShotsBefore = shotDrafts.filter(
      (shot) => shotCaseId(shot) === selectedShotCaseId,
    );
    const inherited = inheritShotAssets(rebuiltRaw, caseShotsBefore, { preserveEdits: true });
    const rebuilt = withShotNumbers(
      inherited.map((entry) => ({ ...entry.shot, caseId: selectedShotCaseId })),
    );
    const firstCaseIndex = shotDrafts.findIndex(
      (shot) => shotCaseId(shot) === selectedShotCaseId,
    );
    const nextShots = shotDrafts.filter(
      (shot) => shotCaseId(shot) !== selectedShotCaseId,
    );
    nextShots.splice(Math.max(0, firstCaseIndex), 0, ...rebuilt);
    applyStoryboardWork({ shots: nextShots, prompts: reconcileImagePrompts(nextShots, shotDrafts, imagePromptDrafts) });
    const nextSelected = rebuilt[Math.min(selectedIndex, rebuilt.length - 1)];
    setSelectedId(nextSelected.id);
    setSelectedImagePromptId(nextSelected.referenceId ?? nextSelected.id);
    // 上传的参考图文件名只清理**这一案例里已经不存在**的那些编号，
    // 不能整案例清空——否则用户为未改动分镜上传过的图名也没了。
    setUploadedNames((current) => {
      const alive = new Set(rebuilt.map((shot) => shot.id));
      return Object.fromEntries(
        Object.entries(current).filter(([id]) =>
          id.startsWith(`${selectedShotCaseId}-`) ? alive.has(id) : true,
        ),
      );
    });
    setWorkflowStage("storyboard");
    setCurrentStage("storyboard");
    setShotStructureDialog(null);
    announce(message);
  };

  const confirmShotSplit = () => {
    if (!selected.sourceItems?.length || !selectedSplitKey) return;
    const [before, after] = splitShotItems(selected, selectedSplitKey);
    if (!before.length || !after.length || !selectedShotCase) return;
    const chunks = selectedCaseShots.map((shot) => shot.sourceItems ?? []);
    chunks.splice(selectedShotCaseIndex, 1, before, after);
    applyCaseStructure(
      chunks,
      selectedShotCaseIndex,
      `${selectedDisplayLabel} 已拆分，受影响镜头的场景与动作链已重新生成`,
    );
  };

  const confirmShotMerge = () => {
    if (!selected.sourceItems?.length || !nextCaseShot?.sourceItems?.length) return;
    const chunks = selectedCaseShots.map((shot) => shot.sourceItems ?? []);
    chunks.splice(selectedShotCaseIndex, 2, [
      ...selected.sourceItems,
      ...nextCaseShot.sourceItems,
    ]);
    applyCaseStructure(
      chunks,
      selectedShotCaseIndex,
      `${selectedDisplayLabel} 已与下一镜合并，场景与动作链已重新生成`,
    );
  };

  const openSplitDialog = () => {
    if (!splitOptions.length) {
      announce("当前镜头没有可用的自然拆分点");
      return;
    }
    setSelectedSplitKey(splitOptions[0].key);
    setShotStructureDialog("split");
  };

  const advanceTo = (nextStage: StageKey) => {
    setCurrentStage(nextStage);
    const nextIndex = stages.findIndex((item) => item.key === nextStage);
    if (nextIndex > workflowStageIndex) setWorkflowStage(nextStage);
  };

  const runCaseExtraction = () => {
    setSourceChanged(true);
    advanceTo("cases");
    announce(`正在查看已识别的 ${caseDrafts.length} 个最小案例`);
  };

  const enterStoryboard = () => {
    if (sourceChanged) {
      const nextWork = rebuildCurrentStoryboard(caseDrafts, scriptDrafts);
      applyStoryboardWork(nextWork);
      setSourceChanged(false);
      announce(`已同步 ${nextWork.shots.length} 个可编辑镜头，未改内容与已有成果已保留`);
    }
    advanceTo("storyboard");
  };

  const confirmCurrentShot = () => {
    const selectedIndex = shotDrafts.findIndex((shot) => shot.id === selected.id);
    // 确认 = 审阅点：存字段快照（供「改了哪里」展示），并把无签名的存量已采用图
    // 补签为当前分镜（老数据兼容）；已有签名但不匹配的图保持过期，不静默放行。
    const confirmedShot = {
      ...selected,
      storyboardConfirmed: true,
      confirmedSnapshot: makeShotConfirmedSnapshot(selected),
    };
    const confirmedDraftId = selected.referenceId ?? selected.id;
    const confirmedDraft = imagePromptDrafts.find((item) => item.id === confirmedDraftId);
    const confirmedImageStale = referenceImageStale(selected, confirmedDraft);
    const nextUnconfirmedShot = [
      ...shotDrafts.slice(selectedIndex + 1),
      ...shotDrafts.slice(0, selectedIndex),
    ].find((shot) => !shot.storyboardConfirmed);
    applyStoryboardWork({ shots: shotDraftsRef.current.map((shot) =>
        shot.id === selected.id
          ? confirmedShot
          : shot,
      ), prompts: imagePromptDraftsRef.current });
    if (confirmedDraft?.image && !confirmedDraft.imageSourceSignature) {
      updateImagePrompts((current) =>
        current.map((item) =>
          item.id === confirmedDraftId
            ? { ...item, imageSourceSignature: shotVisualSignature(selected) }
            : item,
        ),
      );
    }
    const [fallbackPrompt] = buildCleanImagePromptFallbacks(
      [confirmedShot],
      imagePromptDrafts,
    );
    if (fallbackPrompt && !confirmedDraft?.promptModel) {
      if (confirmedDraft?.prompt) fallbackPrompt.prompt = appendRulesToPrompt(confirmedDraft.prompt, matchReuseRules(reuseRules, {
        projectId: activeProjectId, stage: "imagePrompt", text: [selected.title, selected.location, selected.speaker, selected.dialogue, ...selected.action].join(" "),
      }));
      updateImagePrompts((current) =>
        current.map((prompt) =>
          prompt.id === confirmedShot.id ? fallbackPrompt : prompt,
        ), { generated: true },
      );
      queueImagePromptPolish(confirmedShot, fallbackPrompt);
    }
    if (nextUnconfirmedShot) selectProductionItem(nextUnconfirmedShot.id);
    announce(
      confirmedImageStale
        ? `${selectedDisplayLabel} 已确认；注意参考图已因分镜或衔接变化过期，请重新选图或确认保留后再生成视频`
        : nextUnconfirmedShot
          ? `${selectedDisplayLabel} 已确认，画面词已在后台开始润色`
          : `${selectedDisplayLabel} 已确认，全部分镜可以直接进入画面词`,
    );
  };

  const confirmStoryboard = () => {
    if (unconfirmedShotCount > 0) {
      announce(`还需确认 ${unconfirmedShotCount} 个镜头`);
      return;
    }
    setSelectedImagePromptId(imagePromptDrafts[0].id);
    advanceTo("imagePrompt");
    announce(
      imagePromptPolishingIds.length
        ? `已进入画面词，剩余 ${imagePromptPolishingIds.length} 条继续在后台润色`
        : `全部分镜已确认，${imagePromptDrafts.length} 条画面词已准备完成`,
    );
  };

  const renderVisualFrame = (
    title: string,
    image: string | undefined,
    status: "ready" | "missing",
    description: string,
    video: string | undefined = undefined,
  ) => (
    <div className="visual-frame">
      <header className="canvas-header">
        <div>
          <span className="canvas-kicker">
            {focusedMediaCandidate
              ? focusedMediaJob?.mediaType === "video"
                ? "候选视频预览"
                : "候选图预览"
              : stage.label}
          </span>
          <h2>{title}</h2>
        </div>
        {focusedMediaCandidate ? (
          <button
            className="preview-return-button"
            type="button"
            onClick={() => setMediaPreviewSelection(null)}
          >
            <X size={12} />
            {image ? "返回已选参考图" : "返回提示词"}
          </button>
        ) : (
          <span className={`status-badge ${
            currentStage === "storyboard"
              ? selected.storyboardConfirmed ? "ready" : "waiting"
              : video || status === "ready" ? "ready" : status
          }`}>
            {currentStage === "storyboard" ? (
              <ClipboardCheck size={12} />
            ) : video || status === "ready" ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertTriangle size={12} />
            )}
            {currentStage === "storyboard"
              ? selected.storyboardConfirmed ? "分镜已确认" : "待分镜确认"
              : video
                ? "已验收视频"
                : status === "ready"
                  ? "已选图"
                  : "待选图"}
          </span>
        )}
      </header>
      <div className="visual-stage">
        {focusedMediaCandidate && focusedMediaJob ? (
          <div className="focused-media-preview">
            {focusedMediaJob.mediaType === "image" ? (
              <Image
                src={focusedMediaCandidate.previewUrl}
                alt={`${title} 的候选图 ${(focusedMediaCandidateIndex ?? 0) + 1}`}
                fill
                priority
                sizes="(max-width: 980px) 100vw, 52vw"
                unoptimized
              />
            ) : (
              <video
                src={focusedMediaCandidate.previewUrl}
                controls
                preload="metadata"
              />
            )}
            <span>
              候选 {(focusedMediaCandidateIndex ?? 0) + 1} ·{" "}
              {focusedMediaCandidate.status === "adopted"
                ? "已采用"
                : focusedMediaCandidate.status === "rejected"
                  ? "不采用"
                  : "待选择"}
            </span>
          </div>
        ) : video ? (
          <div className="focused-media-preview">
            <video src={video} controls preload="metadata" playsInline />
            <span>已验收视频 · 当前镜头</span>
          </div>
        ) : image ? (
          <div className="visual-image">
            <Image
              src={image}
              alt={`${title} 的参考图`}
              fill
              priority
              sizes="(max-width: 980px) 100vw, 52vw"
            />
            <span>16:9 · 已选参考图</span>
          </div>
        ) : currentStage === "storyboard" ? (
          <div className="storyboard-preview">
            <span className="preview-label">文字分镜 · 无需参考图</span>
            <div className="storyboard-scene">
              <span>{selectedDisplayLabel}</span>
              <h3>{selected.title}</h3>
              <p>{selected.dialogue}</p>
            </div>
            <dl>
              <div><dt>人物</dt><dd>{selected.speaker}</dd></div>
              <div><dt>场景</dt><dd>{selected.location}</dd></div>
              <div><dt>动作</dt><dd>{selected.action.join(" → ")}</dd></div>
            </dl>
          </div>
        ) : currentStage === "imagePrompt" ? (
          <div className="prompt-preview">
            <span className="preview-label">画面提示词预览</span>
            <span className={`polish-status ${selectedImagePrompt.promptModel ? "polished" : "draft"}`}>
              {selectedImagePrompt.promptModel ? `已润色 · ${selectedImagePrompt.promptModel}` : "未润色草稿"}
            </span>
            <div className="storyboard-scene">
              <span>{selectedImageDisplayLabel}</span>
              <h3>{selectedImagePrompt.title}</h3>
              <p>{selectedImageShot ? summarizeShot(selectedImageShot) : selectedImagePrompt.title}</p>
            </div>
            <dl>
              <div>
                <dt>场景</dt>
                <dd>
                  {selectedImageShot?.location
                    ?.replace(/^[^，。；\n]{0,6}(?:场景设定|地点设定|场景|地点)[：:]\s*/u, "")
                    .replace(/[。．.\s]+$/u, "") || "-"}
                </dd>
              </div>
              <div>
                <dt>人物</dt>
                <dd>{selectedImageShot?.speaker || "-"}</dd>
              </div>
              <div>
                <dt>动作</dt>
                <dd>{(selectedImageShot?.action ?? []).filter(Boolean).join(" → ") || "-"}</dd>
              </div>
            </dl>
            <details className="prompt-details">
              <summary>
                {selectedImagePrompt.promptModel ? "查看已润色完整提示词" : "查看未润色完整草稿"}
              </summary>
              <pre>{selectedImagePrompt.prompt}</pre>
            </details>
            <small>生成并人工选图后，可在右侧直接采用候选图；外部图片也可上传或粘贴。</small>
          </div>
        ) : currentStage === "videoPrompt" ? (
          <div className="prompt-preview">
            <span className="preview-label">视频提示词已生成</span>
            <h3>{selected.title}</h3>
            <p>{selected.prompt.action}</p>
            <small>参考图尚未就绪，但不影响查看或修改提示词。</small>
          </div>
        ) : (
          <div className="missing-visual">
            <span>
              <UploadCloud size={27} />
            </span>
            <strong>这个画面还没有参考图</strong>
            <p>{description}</p>
            <label className="primary-button compact">
              <UploadCloud size={15} />
              选择参考图
              <input type="file" accept="image/*" onChange={handleReferenceUpload} />
            </label>
          </div>
        )}
      </div>
    </div>
  );

  /**
   * 导入后的自动内容审核面板。新建项目对话框（导入那一步）与脚本阶段侧栏共用。
   *
   * 刻意只给「结论 + 问题清单」，**不提供一键改写**——它回答的是
   * 「程序把这段归成什么、和原文说的是不是一回事」，改原文是人的决定。
   */
  const renderScriptAuditPanel = (options?: { compact?: boolean }) => {
    if (!scriptAudit) return null;
    const { status, summary, items, counts, model } = scriptAudit;
    const visible = options?.compact ? items.slice(0, 4) : items;
    const tone =
      status === "running"
        ? "running"
        : status === "error"
          ? "error"
          : status === "skipped"
            ? "skipped"
            : items.length
              ? "revise"
              : "pass";
    return (
      <section className={`script-audit-panel ${tone}`} aria-live="polite">
        <header>
          {status === "running" ? (
            <Clock3 size={16} />
          ) : items.length ? (
            <AlertTriangle size={16} />
          ) : (
            <ClipboardCheck size={16} />
          )}
          <strong>脚本内容审核</strong>
          <span className={`script-audit-tag ${tone}`}>
            {status === "running"
              ? "进行中"
              : status === "error"
                ? "未完成"
                : status === "skipped"
                  ? "已跳过"
                  : items.length
                    ? `发现 ${items.length} 项`
                    : "通过"}
          </span>
        </header>
        <p className="script-audit-summary">{summary}</p>
        {items.length > 0 && (
          <p className="script-audit-counts">{scriptAuditCountsLabel(counts)}</p>
        )}
        {visible.length > 0 && (
          <ul className="script-audit-list">
            {visible.map((item, index) => (
              <li key={`${item.kind}-${item.sourceId ?? "x"}-${index}`}>
                <span className="script-audit-kind">
                  {SCRIPT_AUDIT_KIND_LABELS[item.kind]}
                </span>
                <span className="script-audit-message">
                  {item.sourceId ? `第 ${item.sourceId} 段：` : ""}
                  {item.message}
                </span>
                {item.action && <small>{item.action}</small>}
              </li>
            ))}
          </ul>
        )}
        {items.length > visible.length && (
          <p className="script-audit-more">
            另外 {items.length - visible.length} 项见「脚本审查」页。
          </p>
        )}
        <footer>
          {model ? `模型：${model} · ` : ""}
          只提出问题、不改写原文；不阻断流程。
        </footer>
      </section>
    );
  };

  const renderMainContent = () => {
    if (currentStage === "script") {
      return (
        <div className="text-workspace">
          <header className="canvas-header">
            <div>
              <span className="canvas-kicker">脚本导入</span>
              <div className="canvas-title-line">
                <h2>原始 Word 全文</h2>
                <span>{sourceFileName}</span>
              </div>
            </div>
            <span className="source-pill">
              <FileText size={13} />
              .docx 原文
            </span>
          </header>
          <div className="document-scroll">
            <DocumentRows paragraphs={scriptDrafts} />
          </div>
        </div>
      );
    }

    if (currentStage === "cases") {
      return (
        <div className="text-workspace">
          <header className="canvas-header">
            <div>
              <span className="canvas-kicker">案例提取</span>
              <h2>{selectedCase.id} · {selectedCase.title}</h2>
            </div>
            <span className="source-pill case-legend-summary">
              <Layers3 size={13} />
              {caseDrafts.length} 个案例已标记
            </span>
          </header>
          <div className="document-scroll">
            <DocumentRows
              paragraphs={scriptDrafts}
              cases={caseDrafts}
              selectedCaseId={selectedCase.id}
              selectable
              onToggleExtraction={toggleParagraphExtraction}
            />
          </div>
        </div>
      );
    }

    if (currentStage === "scriptReview") {
      return (
        <div className="text-workspace">
          <header className="canvas-header">
            <div>
              <span className="canvas-kicker">脚本审查</span>
              <div className="review-title-line">
                <h2>范围与对白覆盖审查</h2>
                <div className="review-inline-metrics" aria-label="审查统计">
                  <span><strong>{new Set(caseDrafts.map((item) => item.group)).size}</strong> 内容主题</span>
                  <span><strong>{caseDrafts.length}</strong> 最小案例</span>
                  <span><strong>{caseDrafts.reduce((sum, item) => sum + item.dialogueCount, 0)}</strong> 人物对白</span>
                </div>
              </div>
            </div>
            <span className={`status-badge ${scriptReview.status.toLowerCase()}`}>
              {scriptReview.status === "PASS" ? (
                <CheckCircle2 size={12} />
              ) : (
                <AlertTriangle size={12} />
              )}
              {scriptReview.status}
            </span>
          </header>
          <div className="document-scroll">
            <DocumentRows
              paragraphs={scriptDrafts}
              cases={caseDrafts}
              reviewMode
              reviewIssues={scriptReview.issues}
              editable
              onKindChange={updateManualParagraphKind}
              onTextChange={updateManualParagraphText}
              onTextCommit={commitManualParagraphText}
              onSpeakerChange={updateManualParagraphSpeaker}
            />
          </div>
        </div>
      );
    }

    if (currentStage === "storyboard") {
      return (
        <div className="visual-workspace">
          {renderVisualFrame(
            `${selectedDisplayLabel} · ${selected.title}`,
            selected.image,
            selected.status,
            "分镜内容已经通过文字审查；参考图不影响你继续查看和修改镜头结构。",
          )}
          <ShotFilmstrip
            items={shotDrafts}
            selectedId={selected.id}
            onSelect={selectProductionItem}
            showConfirmation
            polishingIds={imagePromptPolishingIds}
          />
        </div>
      );
    }

    if (currentStage === "imagePrompt") {
      return (
        <div className="visual-workspace">
          {renderVisualFrame(
            `${selectedImageDisplayLabel} · ${selectedImagePrompt.title}`,
            selectedImagePrompt.image,
            selectedImagePrompt.status,
            "右侧已经有完整画面提示词；生成并选图后，再把原图上传到参考图阶段。",
          )}
          <PromptFilmstrip
            items={imagePromptDrafts}
            shots={shotDrafts}
            selectedId={selectedImagePrompt.id}
            onSelect={selectProductionItem}
          />
        </div>
      );
    }

    if (!selectedVideoPromptReady) {
      // 2026-09-16 晚：三态解锁提示——参考图过期（分镜画面字段在采用后被改）/
      // 分镜未重新确认 / 尚未选图；过期与未确认都会列出具体改动字段。
      const selectedDraftId = selected.referenceId ?? selected.id;
      const staleImage = selectedStaleImage;
      const changedLabels =
        selectedConfirmedChanges.length > 0
          ? selectedConfirmedChanges.join("、")
          : "部分内容";
      return (
        <div className="visual-workspace">
          <div className="visual-frame">
            <header className="canvas-header">
              <div>
                <span className="canvas-kicker">视频提示词</span>
                <h2>{selectedDisplayLabel} · 当前镜头尚未解锁</h2>
              </div>
              <span className="status-badge waiting"><Clock3 size={12} />WAITING</span>
            </header>
            <div className="visual-stage">
              <div className="locked-stage">
                <PackageCheck size={28} />
                <strong>
                  {staleImage
                    ? "参考图已过期：分镜、画面要求或衔接来源已变化"
                    : selected.image && !selected.storyboardConfirmed
                      ? "参考图已采用，但分镜修改后尚未重新确认"
                      : "先确认当前分镜并采用参考图"}
                </strong>
                <p>
                  {staleImage
                    ? `已采用的参考图不再用于生成，避免「拿旧图配新分镜」。请重新生成或重新选图；若确认当前图仍然适用，可点「仍要采用当前图」。`
                    : selected.image && !selected.storyboardConfirmed
                      ? "编辑分镜内容、调整口播节奏或恢复原始内容都会重置确认状态（已采用的参考图不受影响、无需重新选图）。请回到「分镜」阶段，对该镜头点「保存并确认当前镜头」即可解锁视频词。"
                      : videoReadyShotCount > 0
                        ? `已有 ${videoReadyShotCount} / ${shotDrafts.length} 镜可生成视频。请从下方选择已完成选图的镜头，其他镜头不会阻塞。`
                        : "每个镜头独立解锁；当前还没有同时完成分镜确认与人工选图的镜头。"}
                </p>
                {(staleImage || (selected.image && !selected.storyboardConfirmed)) && (
                  <p>
                    <small>上次确认后已修改：{changedLabels}</small>
                  </p>
                )}
                {staleImage && (
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        selectProductionItem(selected.id);
                        setCurrentStage("imagePrompt");
                      }}
                    >
                      去重新选图
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => reaffirmReferenceImage(selectedDraftId)}
                    >
                      仍要采用当前图
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <ShotFilmstrip
            items={shotDrafts}
            selectedId={selected.id}
            onSelect={selectProductionItem}
            adoptedVideoPreviewByShotId={adoptedVideoPreviewByShotId}
          />
        </div>
      );
    }

    return (
      <div className="visual-workspace">
        {renderVisualFrame(
          `${selectedDisplayLabel} · ${selected.title}`,
          selected.image,
          selected.status,
          `当前镜头已确认并采用参考图，可以查看、修改并单独提交视频；其余 ${remainingVideoPromptCount} 镜不会阻塞。`,
          selectedAdoptedMediaCandidate?.previewUrl,
        )}
        <ShotFilmstrip
          items={shotDrafts}
          selectedId={selected.id}
          onSelect={selectProductionItem}
          adoptedVideoPreviewByShotId={adoptedVideoPreviewByShotId}
        />
      </div>
    );
  };

  const renderShotSettings = () => (
    <>
      <div className={`storyboard-context ${workflowStageIndex > stages.findIndex((item) => item.key === "storyboard") ? "reviewing" : ""}`}>
        <span>{workflowStageIndex > stages.findIndex((item) => item.key === "storyboard") ? <History size={14} /> : <FileText size={14} />}</span>
        <div>
          <strong>{workflowStageIndex > stages.findIndex((item) => item.key === "storyboard") ? "回顾分镜" : "分镜草稿"} · {selectedDisplayLabel}</strong>
          <small>{isArchivedExtraction ? "分镜生产单 V5.3" : "脚本提取结果"}{workflowStageIndex > stages.findIndex((item) => item.key === "storyboard") ? " · 内容修改只会让当前案例的下游失效" : " · 可继续编辑、拆分或合并"} · {selected.storyboardConfirmed ? "已确认，修改后需重新确认" : "待确认，保存即确认"}</small>
        </div>
      </div>
      {selected.sourceItems?.length ? (
        <div className="shot-structure-card">
          <div className="shot-structure-summary">
            <span>
              <Clock3 size={14} />
              <strong>镜头结构</strong>
            </span>
            <b className={(selected.estimatedSeconds ?? 0) > MAX_SHOT_SECONDS ? "over" : ""}>
              预计 {selected.estimatedSeconds ?? 0} 秒
            </b>
          </div>
          <p>{selected.planningNote}</p>
          <small className="shot-structure-rule">单镜目标 ≤15 秒 · 优先按说话人切换或自然句点拆分</small>
          <label className="shot-pace-control">
            <span>本镜口播节奏</span>
            <select
              value={selected.speechRateOverride ?? "project"}
              onChange={(event) => applyShotSpeechRate(event.target.value)}
            >
              <option value="project">跟随项目 · {speechRateLabel(speechRate)}</option>
              {SPEECH_RATE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label} · {preset.value} 字/秒
                </option>
              ))}
            </select>
          </label>
          {selected.speechRateOverride !== undefined && (
            <button className="text-button pace-rule-button" type="button" onClick={() => void createSpeechRateRuleCandidate()}>
              <Sparkles size={13} />把这次节奏调整沉淀为规则
            </button>
          )}
          <div className="shot-structure-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={openSplitDialog}
              disabled={!splitOptions.length}
              title={!splitOptions.length ? "当前镜头没有自然拆分点" : undefined}
            >
              <Scissors size={13} />拆分此镜
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setShotStructureDialog("merge")}
              disabled={!nextCaseShot}
              title={!nextCaseShot ? "当前已经是本案例最后一镜" : undefined}
            >
              <Combine size={13} />与下一镜合并
            </button>
          </div>
        </div>
      ) : null}
      {matchedSpeechRules.length > 0 && (
        <section className="matched-rule-box pace-rule-matches">
          <header><Sparkles size={14} /><strong>匹配到 {matchedSpeechRules.length} 条口播规则</strong></header>
          {matchedSpeechRules.map((rule) => (
            <article key={rule.id}>
              <div>
                <strong>{rule.title}</strong>
                <p>{rule.instruction}</p>
              </div>
              <span>
                <button type="button" onClick={() => void applySpeechRateRule(rule)}>应用</button>
                <button type="button" onClick={() => void rejectSpeechRateRule(rule)}>不适用</button>
              </span>
            </article>
          ))}
        </section>
      )}
      <div className="fact-list">
        <div>
          <span><UserRound size={14} />说话顺序</span>
          <strong>{selected.speaker}</strong>
        </div>
        <div>
          <span><MapPin size={14} />场景</span>
          <strong>{selected.location}</strong>
        </div>
        <div>
          <span><Clock3 size={14} />口播与时长</span>
          <strong>
            {selected.speaker === "无人物对白"
              ? "无旁白 · 视觉叙事"
              : selected.estimatedSeconds
                ? `${speechRateLabel(selectedSpeechRate)}节奏 · 预计 ${selected.estimatedSeconds} 秒`
                : "节奏与机位待分镜审查"}
          </strong>
        </div>
      </div>
      <label className="editor-field">
        <span><MessageSquareText size={14} />本镜完整对白</span>
        <textarea
          rows={7}
          value={selected.dialogue}
          onChange={(event) => updateDialogue(event.target.value)}
        />
      </label>
      <div className="action-editor">
        <span className="field-title"><ClipboardCheck size={14} />整体动作链 <small>拖动手柄可调整先后</small></span>
        <ol>
          {selected.action.map((action, index) => (
            <li
              key={`${selected.id}-${index}`}
              className={`${draggedActionIndex === index ? "is-dragging" : ""} ${actionDropIndex === index && draggedActionIndex !== index ? "is-drag-over" : ""}`.trim()}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setActionDropIndex(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromIndex = draggedActionIndex ?? Number(event.dataTransfer.getData("text/plain"));
                if (Number.isInteger(fromIndex)) moveAction(fromIndex, index);
                setDraggedActionIndex(null);
                setActionDropIndex(null);
              }}
            >
              <button
                className="action-drag-handle"
                type="button"
                draggable
                aria-label={`拖动第 ${index + 1} 个动作，也可用上下方向键调整`}
                title="拖动排序；也可按上下方向键"
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(index));
                  setDraggedActionIndex(index);
                  setActionDropIndex(index);
                }}
                onDragEnd={() => {
                  setDraggedActionIndex(null);
                  setActionDropIndex(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" && index > 0) {
                    event.preventDefault();
                    moveAction(index, index - 1);
                  }
                  if (event.key === "ArrowDown" && index < selected.action.length - 1) {
                    event.preventDefault();
                    moveAction(index, index + 1);
                  }
                }}
              >
                <GripVertical size={14} />
              </button>
              <span className="action-order-number">{index + 1}</span>
              <input
                value={action}
                onChange={(event) => updateAction(index, event.target.value)}
                aria-label={`编辑第 ${index + 1} 个动作`}
              />
              <button
                type="button"
                onClick={() => removeAction(index)}
                disabled={selected.action.length === 1}
                aria-label={`删除第 ${index + 1} 个动作`}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
        <button className="text-button" type="button" onClick={addAction}>
          <Plus size={13} />
          增加动作
        </button>
      </div>
      <label className="editor-field">
        <span><ShieldCheck size={14} />连续性约束</span>
        <textarea
          rows={4}
          value={selected.continuity}
          onChange={(event) =>
            updateSelectedShot((shot) => ({
              ...shot,
              continuity: event.target.value,
            }))
          }
        />
      </label>
      <div className="editor-field">
        <span><Wand2 size={14} />AI 按反馈修改分镜</span>
        <textarea
          rows={3}
          placeholder="例：画面里应有两个人物——小李与王老师同框对话，不要只画小李一个人"
          value={shotReviseFeedback}
          onChange={(event) => setShotReviseFeedback(event.target.value)}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="secondary-button"
            type="button"
            disabled={shotRevising || !shotReviseFeedback.trim()}
            title={!shotReviseFeedback.trim() ? "先在上方填写反馈再让 AI 修改" : undefined}
            onClick={() => void reviseSelectedShotWithAi()}
          >
            <Wand2 size={13} />
            {shotRevising ? "AI 修改中…" : "AI 按反馈修改"}
          </button>
          <small style={{ color: "var(--text-secondary, #6b7280)" }}>
            台词引号内逐字保留；修改后本镜需重新确认，已采用参考图不受影响。
          </small>
        </div>
      </div>
    </>
  );

  const renderMediaGenerationPanel = () => (
    <section className="media-generation-card" aria-label="豆包媒体生成">
      <header>
        <div>
          <span className="media-provider-icon">
            {selectedMediaType === "image" ? <ImageIcon size={16} /> : <Film size={16} />}
          </span>
          <span>
            <strong>豆包{selectedMediaType === "image" ? "候选图" : "候选视频"}</strong>
            <small>{providerOverview.online ? "本机 Provider 已连接" : "本机 Provider 离线"}</small>
          </span>
        </div>
        <span className={`media-provider-state ${providerOverview.online ? "online" : "offline"}`}>
          {providerOverview.online ? "ONLINE" : "OFFLINE"}
        </span>
      </header>

      <div className="media-submit-row">
        <label>
          <span>本次使用账号</span>
          <select
            value={selectedProviderAccountId}
            onChange={(event) => {
              setSelectedProviderAccountId(event.target.value);
              window.localStorage.setItem(MEDIA_ACCOUNT_KEY, event.target.value);
            }}
          >
            <option value={AUTO_PROVIDER_ACCOUNT_ID}>
              自动分配空闲账号 · {quotaEligibleProviderAccounts.length} 个额度可用
              {currentStage === "videoPrompt"
                ? `（本镜需 ${selectedVideoSeconds} 秒）`
                : ""}
            </option>
            {providerAccounts.map((account) => (
              <option value={account.id} key={account.id}>
                {account.alias} · {accountStatusLabel(account.loginStatus)}
                {currentStage === "videoPrompt" ? ` · ${accountQuotaLabel(account)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button compact" type="button" onClick={() => setManagementPanel("settings")}>
          <Settings2 size={14} />配置
        </button>
      </div>

      <div className="media-routing-note">
        <Combine size={14} />
        <span>
          <strong>每个镜头只提交 1 次</strong>
          <small>
            {automaticallyAssignProvider
              ? selectedMediaType === "image"
                ? loggedInProviderAccounts.length >= 2
                  ? "单个账号可同时生成 2 个图片任务；多个账号继续按繁忙程度自动分流。"
                  : "当前账号可同时生成 2 个图片任务，更多任务会自动排队。"
                : `视频任务按账号串行，并按剩余额度挑账号：本镜需要 ${selectedVideoSeconds} 秒，当前 ${quotaEligibleProviderAccounts.length} 个账号额度够用。`
              : `当前固定使用“${selectedProviderAccount?.alias || "所选账号"}”。`}
          </small>
        </span>
      </div>

      {selectedMediaType === "image" && continuityReferenceShot && (
        <div className="media-routing-note">
          <Layers3 size={14} />
          <span>
            <strong>
              {continuityReferenceImage
                ? continuityReferenceTailFrame
                  ? `已附带上一镜 ${shotDisplayLabel(shotDrafts, continuityReferenceShot.id)} 的验收视频尾帧`
                  : `已附带上一镜 ${shotDisplayLabel(shotDrafts, continuityReferenceShot.id)} 的已选图`
                : `等待上一镜 ${shotDisplayLabel(shotDrafts, continuityReferenceShot.id)} 的已选图`}
            </strong>
            <small>
              {continuityReferenceImage
                ? continuityReferenceTailFrame
                  ? "生成图片时会先高清重绘这张尾帧，修复压缩和运动模糊；人工采用后，再用它生成本镜视频。"
                  : "生成时自动作为连续性参考，保持人物、服装、场景、机位和道具状态衔接。"
                : "先完成并采用上一镜参考图，当前连续镜头才可提交生成。"}
            </small>
          </span>
        </div>
      )}

      {selectedMediaType === "video" &&
        selectedVideoTailSource?.videoLastFrame &&
        !selected.image &&
        !selectedVideoDraftImage && (
        <div className="media-routing-note">
          <Film size={14} />
          <span>
            <strong>
              已附带上一镜 {shotDisplayLabel(shotDrafts, selectedVideoTailSource.id)} 的结尾画面（尾帧链）
            </strong>
            <small>
              提交时将它作为本镜首帧参考图上传，镜头1从这个画面状态开始并自然接续；
              手动为本镜采用参考图可覆盖尾帧。
            </small>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => {
                setSelectedImagePromptId(selected.referenceId ?? selected.id);
                setCurrentStage("imagePrompt");
              }}
            >
              <Wand2 size={13} />用尾帧生成高清首帧图
            </button>
          </span>
        </div>
      )}

      {pendingLegacyImageFeedback.length > 0 && (
        <div className="media-routing-note" role="note">
          <MessageSquareText size={15} />
          <span>
            <strong>{pendingLegacyImageFeedback.length} 条旧退回意见等待 AI 整理</strong>
            <small>下次点击生成时，会先识别对应候选图并重写完整画面词；整理成功后才提交豆包，不会直接拼接原话。</small>
          </span>
        </div>
      )}

      {mediaSubmitBlocker && (
        <div className="media-blocker">
          <AlertTriangle size={14} />
          <span>
            {videoPromptSubmitBlocker
              ? `${videoPromptSubmitBlocker}，当前镜头暂不能生成视频。`
              : continuitySubmitBlocker
              ? `${continuitySubmitBlocker}，当前连续镜头暂不能生成。`
              : polishNotConfiguredBlocker
              ? `${polishNotConfiguredBlocker}。`
              : `${mediaSubmitBlocker}。打开“配置”完成连接；当前手工流程仍可继续。`}
          </span>
        </div>
      )}

      {!mediaSubmitBlocker && polishSubmitHint && (
        <div className="media-routing-note" role="note">
          <Sparkles size={15} />
          <span>
            <strong>{polishSubmitHint}</strong>
            <small>
              润色失败会在后台自动重试 2 次（间隔 10 / 30 秒）；仍不成功才把按钮交回你手里，不会再出现按钮永远是灰的情况。
            </small>
          </span>
        </div>
      )}

      <button
        className={`primary-button full media-generate-button ${activeSelectedMediaJob ? "has-active-job" : ""}`}
        type="button"
        disabled={
          Boolean(mediaSubmitBlocker) ||
          mediaAction === "create-job" ||
          pendingMediaSubmit !== null
        }
        onClick={() => void handleGenerateClick()}
      >
        {mediaAction === "create-job" || pendingMediaSubmit ? (
          <RefreshCw className="spin" size={15} />
        ) : (
          <Sparkles size={15} />
        )}
        {pendingMediaSubmit
          ? `润色中…完成后自动提交（已等 ${pendingMediaElapsed} 秒）`
          : mediaAction === "create-job"
            ? pendingLegacyImageFeedback.length
              ? "AI 整理旧反馈中…"
              : "正在提交…"
            : activeSelectedMediaJob
              ? `再生成一组${selectedMediaType === "image" ? "图片" : "视频"}`
              : automaticallyAssignProvider
                ? `自动分配账号生成${selectedMediaType === "image" ? "图片" : "视频"}`
                : `用所选账号生成${selectedMediaType === "image" ? "图片" : "视频"}`}
      </button>

      {pendingMediaSubmit && (
        <div className="media-generation-progress" role="status" aria-live="polite">
          <span className="media-progress-icon" aria-hidden="true">
            <RefreshCw className="spin" size={17} />
          </span>
          <span className="media-progress-copy">
            <strong>
              正在等提示词润色完成，润色一好就自动提交豆包（已等 {pendingMediaElapsed} 秒）
            </strong>
            <small>
              失败会在后台自动重试 2 次（间隔 10 / 30 秒），不需要你操作；
              等待期间改素材会按新内容重新润色，然后继续自动提交。
            </small>
          </span>
        </div>
      )}

      {unpolishedEscape && (
        <>
          <div className="media-blocker" role="note">
            <AlertTriangle size={14} />
            <span>
              {/* 2026-10-08 二轮：服务端文案里不再回显内部键，这里补上对外展示的编号，
                  用户才能照着界面找到是哪一镜。 */}
              <strong>
                {unpolishedEscape.code === AI_INPUT_REJECTED_CODE
                  ? "素材不完整："
                  : unpolishedEscape.rejected
                    ? "润色没通过："
                    : "润色没能完成："}
                {shotDisplayLabel(shotDrafts, unpolishedEscape.targetId)}：
                {unpolishedEscape.error}
              </strong>
              <small>
                {unpolishedEscape.code === AI_INPUT_REJECTED_CODE
                  ? "这一镜缺少可用的场景或动作，服务端因此拒绝了 AI 润色——重发同样的素材必然同样失败，已停止自动重试。可以回到分镜补齐该镜的场景与动作后重试；也可以直接用未润色模板提交：模板用的是原始素材里的动作链，仍能生成，只是不做镜头时序润色。"
                  : unpolishedEscape.rejected
                    ? "模型这次违反了内容规则（改动了必须逐字保留的内容），重发同样的素材大概率还是同样结果；已停止自动重试。未润色模板是机械组装，台词逐字正确——建议直接用模板提交。"
                    : "可以重新点上面的「生成」再试一次润色；或者用未润色模板直接提交豆包（质量可能下降，需二次确认）。"}
              </small>
            </span>
          </div>
          <button
            className="secondary-button compact"
            type="button"
            onClick={() => void submitUnpolishedAnyway()}
          >
            <AlertTriangle size={13} />用未润色模板提交（需确认）
          </button>
        </>
      )}

      {(mediaAction === "create-job" || activeSelectedMediaJob) && (
        <div className="media-generation-progress" role="status" aria-live="polite">
          <span className="media-progress-icon" aria-hidden="true">
            <Sparkles size={17} />
          </span>
          <span className="media-progress-copy">
            <strong>
              {mediaAction === "create-job"
                ? pendingLegacyImageFeedback.length
                  ? "正在识别退回图片并重写画面词"
                  : "正在把任务送到豆包"
                : activeSelectedMediaJob?.status === "queued"
                  ? "任务已提交，正在等待执行"
                  : `豆包正在生成${selectedMediaType === "image" ? "候选图片" : "候选视频"}`}
            </strong>
            <small>
              {mediaAction === "create-job"
                ? pendingLegacyImageFeedback.length
                  ? "使用已连接的低成本视觉与文本模型；完成前不会提交豆包。"
                  : "正在整理提示词与参考图，请稍候…"
                : `已交给“${providerAccounts.find((account) => account.id === activeSelectedMediaJob?.accountId)?.alias || activeSelectedMediaJob?.accountId}”${activeSelectedMediaJobs.length > 1 ? `，当前镜头有 ${activeSelectedMediaJobs.length} 个任务进行中` : ""}；完成后会自动显示候选。`}
            </small>
          </span>
          <span className="media-progress-track" aria-hidden="true"><i /></span>
        </div>
      )}

      {mediaMessage && <p className="media-inline-message" role="status">{mediaMessage}</p>}

      <div className="media-job-list">
        {selectedMediaJobs.length ? (
          <>
            {visibleSelectedMediaJobs.map((job) => (
              <article className={`media-job ${["queued", "running"].includes(job.status) ? "active" : ""}`} key={job.id}>
            <div className="media-job-heading">
              <span>
                <strong>{mediaJobStatusLabel(job.status)}</strong>
                <small>{providerAccounts.find((account) => account.id === job.accountId)?.alias || job.accountId} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small>
              </span>
              <span className={`media-job-status ${job.status}`}>{mediaJobStatusLabel(job.status)}</span>
            </div>
            {job.errorMessage && (
              <div className="media-job-error">
                <AlertTriangle size={13} />
                <span>{job.errorMessage}</span>
                <button type="button" onClick={() => void createSelectedMediaJob(job.id)}>
                  {needsProviderHistoryCheck(job.errorCode)
                    ? "核对后再生成"
                    : "重新生成"}
                </button>
              </div>
            )}
            {job.candidates.length > 0 && (
              <div className="media-candidate-grid">
                {job.candidates.map((candidate, candidateIndex) => (
                  <article
                    className={`media-candidate ${candidate.status} ${
                      focusedMediaJob?.id === job.id &&
                      focusedMediaCandidate?.id === candidate.id
                        ? "previewing"
                        : ""
                    }`}
                    key={candidate.id}
                  >
                    <button
                      className="media-candidate-preview"
                      type="button"
                      title="在中央工作区放大预览"
                      aria-label={`${job.targetLabel ?? job.targetId} 候选 ${candidateIndex + 1}，在中央工作区放大预览`}
                      aria-pressed={
                        focusedMediaJob?.id === job.id &&
                        focusedMediaCandidate?.id === candidate.id
                      }
                      onClick={() =>
                        setMediaPreviewSelection({
                          jobId: job.id,
                          candidateId: candidate.id,
                          targetId: job.targetId,
                          mediaType: job.mediaType,
                        })
                      }
                    >
                      {job.mediaType === "image" ? (
                        <Image src={candidate.previewUrl} alt={`${job.targetLabel ?? job.targetId} 豆包候选图`} fill sizes="320px" unoptimized />
                      ) : (
                        <video src={candidate.previewUrl} muted playsInline preload="metadata" />
                      )}
                      <span className="media-candidate-state">
                        {candidate.status === "adopted" && <CheckCircle2 size={12} />}
                        {candidate.status === "adopted" ? "当前采用" : candidate.status === "rejected" ? "不采用" : "待选择"}
                      </span>
                    </button>
                    {candidate.status === "adopted" && (
                      <div className="media-adopted-banner">
                        <CheckCircle2 size={14} />
                        <span>当前采用 · 后续镜头会以此图为参考</span>
                      </div>
                    )}
                    {/* 2026-09-16 晚：采用的图与最新分镜不一致时明确示警，并给出两个出口。 */}
                    {candidate.status === "adopted" &&
                      job.targetId === (selectedImageShot?.referenceId ?? selectedImageShot?.id) &&
                      selectedImageShot &&
                      referenceImageStaleFor(selectedImageShot) && (
                      <div className="plain-note warning">
                        <AlertTriangle size={13} />
                        <p>
                          <strong>参考图已过期</strong>
                          <small>
                            分镜或衔接来源在采用此图后变化过（{shotConfirmedChanges(selectedImageShot).join("、") || "部分内容"}）；
                            该图已不能直接用于生成视频。可重新生成候选，或确认当前图仍然适用。
                          </small>
                        </p>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => reaffirmReferenceImage(job.targetId)}
                        >
                          仍要采用当前图
                        </button>
                      </div>
                    )}
                    {candidate.visionReview && (
                      <div className={`vision-review-result ${candidate.visionReview.status.toLowerCase()}`}>
                        <strong>{candidate.visionReview.status}</strong>
                        <p>{candidate.visionReview.evidence || "视觉模型未提供可见依据"}</p>
                        {candidate.visionReview.retrySuggestion && <small>建议：{candidate.visionReview.retrySuggestion}</small>}
                      </div>
                    )}
                    {candidateFeedbackReason(projectHistory, job.id, candidate.id) && (
                      <div className="media-candidate-feedback">
                        <MessageSquareText size={13} />
                        <span>
                          <strong>你的退回意见</strong>
                          <small>{candidateFeedbackReason(projectHistory, job.id, candidate.id)}</small>
                        </span>
                      </div>
                    )}
                    {mediaFeedbackProgress?.candidateId === candidate.id && (
                      <div
                        className={`media-feedback-progress ${mediaFeedbackProgress.state}`}
                        role={mediaFeedbackProgress.state === "error" ? "alert" : "status"}
                      >
                        {mediaFeedbackProgress.state === "processing"
                          ? <RefreshCw className="spin" size={14} />
                          : mediaFeedbackProgress.state === "success"
                            ? <CheckCircle2 size={14} />
                            : <AlertTriangle size={14} />}
                        <span>
                          <strong>{mediaFeedbackProgress.title}</strong>
                          <small>{mediaFeedbackProgress.detail}</small>
                        </span>
                        {mediaFeedbackProgress.state === "success" && mediaFeedbackProgress.historyId && (
                          <button
                            type="button"
                            onClick={() => {
                              const entry = projectHistory.find((item) => item.id === mediaFeedbackProgress.historyId);
                              if (entry) void createManualRuleFromHistory(entry);
                            }}
                          >
                            沉淀为项目规则候选
                          </button>
                        )}
                      </div>
                    )}
                    {pendingMediaRejection?.jobId === job.id &&
                      pendingMediaRejection.candidateId === candidate.id && (
                        <div className="media-rejection-editor">
                          <label htmlFor={`media-rejection-${candidate.id}`}>
                            {job.mediaType === "video" ? "为什么不采用？" : "哪里不满意？"}
                          </label>
                          <textarea
                            id={`media-rejection-${candidate.id}`}
                            autoFocus
                            rows={3}
                            maxLength={400}
                            value={mediaRejectionReason}
                            onChange={(event) => setMediaRejectionReason(event.target.value)}
                            placeholder="例如：人物离镜头太远；桌上的文件位置不对；角色表情过于僵硬。"
                            aria-describedby={`media-rejection-help-${candidate.id}`}
                          />
                          <div className="media-rejection-help" id={`media-rejection-help-${candidate.id}`}>
                            <small>
                              {job.mediaType === "video"
                                ? "保存后会记录本次视频不采用原因，供后续视频词优化和项目规则沉淀；不会自动重新提交。"
                                : "保存后先识别这张图片，再由低成本文本模型把意见整合进新画面词；完成前不会发送豆包。"}
                            </small>
                            <span>{Array.from(mediaRejectionReason).length}/400</span>
                          </div>
                          <div className="media-rejection-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setPendingMediaRejection(null);
                                setMediaRejectionReason("");
                              }}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(mediaAction) || (job.mediaType === "video" && !mediaRejectionReason.trim())}
                              onClick={() =>
                                void rejectMediaCandidate(
                                  job,
                                  candidate,
                                  job.mediaType === "video" ? mediaRejectionReason : "",
                                )
                              }
                            >
                              {job.mediaType === "video" ? "保存原因并不采用" : "仅不采用"}
                            </button>
                            {job.mediaType === "image" && (
                              <button
                                className="adopt"
                                type="button"
                                disabled={Boolean(mediaAction) || !mediaRejectionReason.trim()}
                                onClick={() => void rejectMediaCandidate(job, candidate, mediaRejectionReason)}
                              >
                                {mediaAction === `reject:${candidate.id}`
                                  ? "AI 识别并重写中…"
                                  : mediaFeedbackProgress?.candidateId === candidate.id && mediaFeedbackProgress.state === "error"
                                    ? "重新识别并重写"
                                    : "AI 整理并不采用"}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    <div className="media-candidate-actions">
                      <button className="adopt" type="button" disabled={Boolean(mediaAction) || candidate.status === "adopted"} onClick={() => void adoptMediaCandidate(job, candidate)}>
                        <Check size={13} />{mediaAction === `adopt:${candidate.id}` ? "处理中…" : job.mediaType === "image" ? "采用图片" : "验收通过"}
                      </button>
                      <button
                        type="button"
                        disabled={
                          Boolean(mediaAction) ||
                          candidate.status === "rejected" ||
                          (pendingMediaRejection?.jobId === job.id &&
                            pendingMediaRejection.candidateId === candidate.id)
                        }
                        onClick={() => beginMediaCandidateRejection(job, candidate)}
                      >
                        <X size={13} />
                        {pendingMediaRejection?.jobId === job.id && pendingMediaRejection.candidateId === candidate.id
                          ? "填写反馈中"
                          : candidate.status === "adopted"
                            ? "撤回采用"
                            : "不采用"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
              </article>
            ))}
            {historicalFailedMediaJobs.length > 0 && (
              <details className="media-job-history">
                <summary>
                  <History size={13} />
                  历史失败记录 · {historicalFailedMediaJobs.length}
                  <small>不会影响当前账号与新任务</small>
                  <ChevronDown size={13} />
                </summary>
                <div className="media-job-history-list">
                  {historicalFailedMediaJobs.map((job) => (
                    <article className="media-job" key={job.id}>
                      <div className="media-job-heading">
                        <span>
                          <strong>{mediaJobStatusLabel(job.status)}</strong>
                          <small>{providerAccounts.find((account) => account.id === job.accountId)?.alias || job.accountId} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small>
                        </span>
                        <span className={`media-job-status ${job.status}`}>{mediaJobStatusLabel(job.status)}</span>
                      </div>
                      {job.errorMessage && (
                        <div className="media-job-error">
                          <AlertTriangle size={13} />
                          <span>{job.errorMessage}</span>
                          <button type="button" onClick={() => void createSelectedMediaJob(job.id)}>
                            {needsProviderHistoryCheck(job.errorCode)
                              ? "核对后再生成"
                              : "重新生成"}
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="media-empty-state">
            <Film size={18} />
            <span>当前{selectedMediaType === "image" ? "画面" : "镜头"}还没有站内生成记录。</span>
          </div>
        )}
      </div>
    </section>
  );

  const renderInspectorContent = () => {
    if (currentStage === "script") return null;

    if (currentStage === "cases") {
      return (
        <>
          <div className="inspector-lead">
            <Layers3 size={18} />
            <div><strong>{caseDrafts.length} 个最小案例</strong><p>先选案例，再点中间段落纳入或移除；再次点击即可撤销。</p></div>
          </div>
          <section className="extraction-review-box">
            <header>
              <span><Sparkles size={15} /></span>
              <div>
                <strong>规则初提，文本模型复核</strong>
                <small>AI 只建议案例边界和说话人，原文由程序锁定。</small>
              </div>
            </header>
            <div className="extraction-review-meta">
              <span>{extractionEngine}</span>
              <span>{matchedExtractionRules.length} 条提取规则可参与复核</span>
            </div>
            <button
              className="secondary-button full"
              type="button"
              disabled={aiExtractionLoading}
              onClick={() => void reviewExtractionWithAi()}
            >
              {aiExtractionLoading ? (
                <><Clock3 size={14} />正在核对原文段落…</>
              ) : aiConfiguration.configured ? (
                <><Sparkles size={14} />用文本模型复核结构</>
              ) : (
                <><KeyRound size={14} />连接文本模型后复核</>
              )}
            </button>
            {aiExtractionReview && (
              <div className="extraction-review-result" aria-live="polite">
                <div className="extraction-review-result-title">
                  <strong>{aiExtractionReview.changed ? "发现结构调整建议" : "规则与 AI 结果一致"}</strong>
                  <span>{aiExtractionReview.model}</span>
                </div>
                <p>{aiExtractionReview.summary}</p>
                <div className="extraction-review-counts">
                  <span>{aiExtractionReview.cases.length} 个案例</span>
                  <span>{aiExtractionReview.cases.reduce((sum, item) => sum + item.dialogueCount, 0)} 句对白</span>
                  <span>{aiExtractionReview.issues.length} 项待核对</span>
                </div>
                {aiExtractionReview.issues.length > 0 && (
                  <ul>
                    {aiExtractionReview.issues.slice(0, 4).map((issue) => (
                      <li key={`${issue.sourceId ?? "unknown"}-${issue.message}`}>
                        {issue.sourceId ? `第 ${issue.sourceId} 段：` : ""}{issue.reason ?? issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                {aiExtractionReview.changed && (
                  <p>采用后会重建分镜和画面词，已回填的参考图需要重新确认。</p>
                )}
                <div className="extraction-review-actions">
                  <button
                    className="primary-button compact"
                    type="button"
                    disabled={!aiExtractionReview.changed && !aiExtractionReview.issues.length}
                    onClick={applyAiExtractionReview}
                  >
                    <Check size={13} />
                    {aiExtractionReview.changed ? "采用复核结果" : "写入待核对项"}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setAiExtractionReview(null)}
                  >
                    保留规则结果
                  </button>
                </div>
              </div>
            )}
          </section>
          <div className="case-list">
            {caseDrafts.map((item) => (
              <button
                className={`case-item case-${caseDrafts.indexOf(item) + 1} ${
                  selectedCase.id === item.id ? "active" : ""
                }`}
                type="button"
                key={item.id}
                onClick={() => selectCase(item)}
              >
                <span>{item.id}</span>
                <strong>{item.title}</strong>
                <small>{item.dialogueCount} 句对白 · {item.storyboardCount} 个分镜</small>
              </button>
            ))}
          </div>
        </>
      );
    }

    if (currentStage === "scriptReview") {
      return (
        <>
          <div className={`review-result ${scriptReview.status.toLowerCase()}`}>
            <span>
              {scriptReview.status === "PASS" ? (
                <CheckCircle2 size={20} />
              ) : (
                <AlertTriangle size={20} />
              )}
            </span>
            <div>
              <strong>
                {scriptReview.status === "PASS"
                  ? "脚本审查通过"
                  : scriptReview.status === "REVISE"
                    ? "有项目需要人工核对"
                    : "脚本审查被阻断"}
              </strong>
              <p>{extractionEngine} · 不消耗图片或视频额度</p>
            </div>
          </div>
          <ul className="check-list">
            {scriptReview.checks.map((check) => (
              <li className={check.status.toLowerCase()} key={check.label}>
                {check.status === "PASS" ? <Check size={14} /> : <AlertTriangle size={14} />}
                <span><strong>{check.label}</strong><small>{check.detail}</small></span>
              </li>
            ))}
          </ul>
          <section className="batch-rule-composer">
            <header>
              <span><MessageSquareText size={15} /></span>
              <div>
                <strong>批量修改并沉淀</strong>
                <small>人物形象与全片画面规则在这里统一修改；单镜动作内容和顺序请到“分镜”。</small>
              </div>
            </header>
            <label htmlFor="batch-rule-draft">告诉工作台要统一修改什么</label>
            <textarea
              id="batch-rule-draft"
              rows={5}
              value={batchRuleDraft}
              placeholder="例如：把里面的小陈，小陈的形象全部都沿用审计员A的形象"
              onChange={(event) => {
                setBatchRuleDraft(event.target.value);
                setBatchRuleResult("");
              }}
            />
            <button
              className="primary-button full"
              type="button"
              disabled={batchRuleLoading || !batchRuleDraft.trim()}
              onClick={() => void applyBatchProductionRule()}
            >
              {batchRuleLoading ? <Clock3 size={14} /> : <Sparkles size={14} />}
              {batchRuleLoading ? "正在整理并应用…" : "应用到当前项目并沉淀"}
            </button>
            {batchRuleResult && <p className={`batch-rule-result ${batchRuleResult.includes("未改动") ? "warning" : ""}`} role="status">{batchRuleResult}</p>}
          </section>
          <div className="plain-note">
            <ClipboardCheck size={15} />
            <p>中间正文可直接修改；右侧类型标签用于切换“对白、动作、场景、标题、结构或排除”。案例范围请回到“提取”阶段点选。</p>
          </div>
          <button className="secondary-button full" type="button" onClick={confirmManualScriptReview}>
            <ClipboardCheck size={14} />应用人工修正并重新审查
          </button>
          {scriptReview.issues.length > 0 ? (
            <div className="plain-note warning review-flags">
              <AlertTriangle size={15} />
              <div>
                <strong>进入分镜前请核对</strong>
                <div className="review-issue-links">
                  {scriptReview.issues.map((issue) => (
                    <button
                      type="button"
                      key={issue.message}
                      onClick={() => focusReviewIssue(issue)}
                      disabled={!issue.sourceId}
                    >
                      <span>{issue.sourceId ? `定位第 ${issue.sourceId} 段` : "待人工定位"}</span>
                      <strong>{issue.reason ?? issue.message}</strong>
                      <small>核对：{issue.question ?? issue.message}</small>
                      {issue.action && <em>修改：{issue.action}</em>}
                      <ArrowRight size={13} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="plain-note">
              <CircleHelp size={15} />
              <p>脚本范围和人物对白可以进入分镜规划，不需要图片或视频返工。</p>
            </div>
          )}
        </>
      );
    }

    if (currentStage === "storyboard") return renderShotSettings();

    if (currentStage === "imagePrompt") {
      return (
        <>
          <div className={`compact-crop-status ${selectedImagePrompt.status}`}>
            <span>
              {selectedImagePrompt.status === "ready" ? (
                <CheckCircle2 size={15} />
              ) : (
                <AlertTriangle size={15} />
              )}
              <strong>
                {selectedImagePrompt.status === "ready" ? "已选图" : "待选图"}
              </strong>
              <small>
                {selectedImagePrompt.status === "ready"
                  ? uploadedNames[selectedImagePrompt.id] ?? "已选参考图"
                  : "上传或 Ctrl+V 粘贴原图"}
              </small>
            </span>
            <div className="compact-crop-actions">
              {selectedImagePrompt.status === "ready" && (
                <button className="text-button" type="button" onClick={withdrawSelectedImage}>
                  <RotateCcw size={13} />撤回已选图
                </button>
              )}
              <label className="text-button">
                <UploadCloud size={13} />
                {selectedImagePrompt.status === "ready" ? "替换图片" : "上传图片"}
                <input type="file" accept="image/*" onChange={handleReferenceUpload} />
              </label>
            </div>
          </div>
          <div className="inspector-lead">
            <ImageIcon size={18} />
            <div><strong>{selectedImageDisplayLabel}</strong><p>{selectedImagePrompt.title}</p></div>
          </div>
          {styleAsset && (
            <section className="character-asset-callout style">
              <Image
                src={styleAsset.image}
                alt={styleAsset.title}
                width={58}
                height={58}
                unoptimized
              />
              <div>
                <span>固定风格资产</span>
                <strong>剪映扁平线条风</strong>
                <small>每次站内生图会自动上传，只参考画法。</small>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => downloadReferenceAsset(styleAsset)}
              >
                <Download size={13} />下载
              </button>
            </section>
          )}
          {needsAuditorAsset && auditorAsset && (
            <section className="character-asset-callout">
              <Image
                src={auditorAsset.image}
                alt={auditorAsset.title}
                width={58}
                height={58}
                unoptimized
              />
              <div>
                <span>固定人物资产</span>
                <strong>{auditorAsset.roleName}</strong>
                <small>去豆包时，把人物图与画面提示词一起上传。</small>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => downloadReferenceAsset(auditorAsset)}
              >
                <Download size={13} />下载
              </button>
            </section>
          )}
          <div className="knowledge-inline-actions">
            <button
              className="secondary-button compact"
              type="button"
              disabled={selectedImagePrompt.status !== "ready"}
              onClick={() => void depositCurrentAsset()}
            >
              <LibraryBig size={14} />沉淀到素材库
            </button>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => setManagementPanel("knowledge")}
            >
              查看 {referenceAssets.length} 项素材
            </button>
          </div>
          <label className="editor-field grow">
            <span aria-live="polite">
              画面生成提示词 · {selectedImagePromptPolishing
                ? "AI 润色中…"
                : selectedImagePrompt.promptModel
                ? `${selectedImagePrompt.promptModel} 已润色`
                : "干净模板 / 人工编辑"}
            </span>
            <textarea
              rows={18}
              value={selectedImagePrompt.prompt}
              onChange={(event) => {
                updateImagePrompts((current) =>
                  current.map((item) =>
                    item.id === selectedImagePrompt.id
                      ? { ...item, prompt: event.target.value, promptModel: undefined }
                      : item,
                  ),
                );
              }}
            />
          </label>
          {matchedImageRules.length > 0 && (
            <section className="matched-rule-box">
              <header>
                <div><Sparkles size={15} /><strong>匹配到 <em>{matchedImageRules.length}</em> 条已启用规则</strong></div>
                <small>人工确认后记录采用或不适用</small>
              </header>
              {matchedImageRules.slice(0, 3).map((rule) => {
                const recorded = projectHistory.some(
                  (entry) =>
                    entry.kind === "feedback" &&
                    entry.issueType === "规则复用" &&
                    entry.targetId === selectedImagePrompt.id &&
                    entry.before === rule.id,
                );
                return (
                  <article key={rule.id}>
                    <div>
                      <strong>{rule.title}</strong>
                      <p>{rule.instruction}</p>
                      <small>
                        匹配原因：画面词阶段 · {matchingKeywords(rule, selectedRuleContext).length
                          ? `命中 ${matchingKeywords(rule, selectedRuleContext).join(" / ")}`
                          : "该阶段全部任务"}
                      </small>
                    </div>
                    <span>
                      <button type="button" disabled={recorded} onClick={() => void applyImageRule(rule)}>
                        {recorded ? "已留痕" : selectedImagePrompt.prompt.includes(rule.instruction) ? "确认采用" : "应用"}
                      </button>
                      <button type="button" disabled={recorded} onClick={() => void rejectImageRule(rule)}>不适用</button>
                    </span>
                  </article>
                );
              })}
            </section>
          )}
          {renderMediaGenerationPanel()}
          <div className="plain-note">
            <CircleHelp size={15} />
            <p>
              {isArchivedExtraction
                ? "提示词来自豆包首帧提示词生产单 V13.1。"
                : "当前是根据待审分镜建立的画面词草稿。"}
              Provider 在线时可在上方直接生成并查看候选；服务不可用时仍可复制到豆包，再上传文件或按 Ctrl+V 粘贴。最终采用始终由你决定。
            </p>
          </div>
        </>
      );
    }

    if (currentStage === "videoPrompt" && !selectedVideoPromptReady) {
      const changedLabels =
        selectedConfirmedChanges.length > 0
          ? selectedConfirmedChanges.join("、")
          : "部分内容";
      return (
        <div className="plain-note warning">
          <AlertTriangle size={15} />
          <p>
            {selectedStaleImage
              ? `参考图已过期：分镜、画面要求或衔接来源已变化（${changedLabels}），旧图不能再用于生成。请到「画面词」阶段重新生成或重新选图；若确认当前图仍适用，可在中央工作区点「仍要采用当前图」。`
              : selected.image && !selected.storyboardConfirmed
                ? `分镜内容修改后尚未重新确认（改动：${changedLabels}）——请到「分镜」阶段点「保存并确认当前镜头」（无需重新选图）；已满足条件的其他镜头可以独立查看、修改和生成视频。`
                : "当前镜头需先确认分镜并采用参考图；已满足条件的其他镜头可以独立查看、修改和生成视频。"}
          </p>
        </div>
      );
    }

    return (
      <>
        <div className="inspector-lead">
          <MessageSquareText size={18} />
          <div><strong>{selectedDisplayLabel} · 镜头时序视频词</strong><p>修改会保存在浏览器本地草稿。</p></div>
        </div>
        {selectedShotVideoPromptPolishing ? (
          <div className="plain-note">
            <Sparkles className="spin" size={15} />
            <p>
              视频词润色中…（后台自动执行，无需操作；完成后下方「完整提示词」会自动更新）。
              失败或超过 100 秒未返回会自动重试 2 次（间隔 10 / 30 秒），全程无需操作。
            </p>
          </div>
        ) : selected.videoPromptPolished ? (
          <div className="plain-note">
            <CheckCircle2 size={15} />
            <p>
              已由{selected.videoPromptPolished.model || "文本模型"}润色；台词以大括号原样嵌入镜头2，服务端逐字校验，未被改写。
              改动上方任何素材都会自动重新润色，不需要点任何按钮。
            </p>
          </div>
        ) : aiConfiguration.configured ? (
          <div className="plain-note">
            <Sparkles size={15} />
            <p>
              视频词会在后台自动润色…（台词由系统逐字校验后嵌入）；失败会自动重试 2 次，
              仍不成功才停下来等你手动重试。
            </p>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                videoPromptAutoPolishRef.current.delete(selected.id);
                polishStateRef.current.reset("video", selected.id);
                expectAutoPolish([selected.id]);
                queueVideoPromptPolish(selected);
              }}
            >
              <RefreshCw size={13} />立即重新润色
            </button>
          </div>
        ) : (
          <div className="plain-note warning">
            <AlertTriangle size={15} />
            <p>尚未连接文本模型，视频词将按镜头时序模板直接提交。</p>
          </div>
        )}
        {selectedMediaType === "video" && (
          <div className="plain-note">
            <Layers3 size={15} />
            <p>
              本镜将上传 {selectedVideoReferencePlan.images.length} 张参考图（上传顺序即提示词里的编号，第 1 张是本镜画面基准）：
              {selectedVideoReferencePlan.images.length
                ? selectedVideoReferencePlan.images
                    .map((image, index) => `${index + 1}. ${image.label}`)
                    .join("；")
                : "暂无——模型只按文字生成，画面与人物不受约束"}
              。参考图只作画面基准，不是必须静止复现的第一帧。
            </p>
          </div>
        )}
        {selectedMediaType === "video" && selectedVideoReferenceMissingNote ? (
          <div className="plain-note warning">
            <AlertTriangle size={15} />
            <p>{selectedVideoReferenceMissingNote}</p>
          </div>
        ) : null}
        {videoScriptWarnings(selected.videoPromptPolished?.script || "", selected.dialogue).map(
          (warning) => (
            <div className="plain-note warning" key={warning.code}>
              <AlertTriangle size={15} />
              <p>{warning.message}</p>
            </div>
          ),
        )}
        <label className="editor-field">
          <span>目标时长（作为提交参数，并写入提示词）</span>
          {(() => {
            const durationOptions = [
              { value: "auto", label: `自动 · 按对白语速估算（${videoDurationBucket(selected.estimatedSeconds)} 秒）` },
              { value: "5", label: "5 秒" },
              { value: "10", label: "10 秒" },
              { value: "15", label: "15 秒" },
            ];
            const selectedDuration = selected.videoSecondsOverride ?? "auto";
            const selectedDurationLabel = durationOptions.find((option) => option.value === selectedDuration)?.label ?? durationOptions[0].label;
            return (
              <details className="duration-picker">
                <summary>
                  <span>{selectedDurationLabel}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </summary>
                <div className="duration-picker-menu" role="listbox" aria-label="目标时长">
                  {durationOptions.map((option) => (
                    <button
                      className={option.value === selectedDuration ? "active" : ""}
                      type="button"
                      role="option"
                      aria-selected={option.value === selectedDuration}
                      key={option.value}
                      onClick={(event) => {
                        applyVideoDuration(option.value);
                        event.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      <span>{option.label}</span>
                      {option.value === selectedDuration && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </details>
            );
          })()}
        </label>
        <label className="editor-field">
          <span>完整原文对白</span>
          <textarea
            rows={6}
            value={selected.dialogue}
            onChange={(event) => updateDialogue(event.target.value)}
          />
        </label>
        <div className={selectedDialogueOverloaded ? "plain-note warning" : "plain-note"}>
          {selectedDialogueOverloaded ? <AlertTriangle size={15} /> : <CircleHelp size={15} />}
          <p>
            对白共 {selectedDialogueChars} 字；{selectedVideoSeconds} 秒档按舒适语速（约 4 字/秒）
            建议不超过 {selectedDialogueBudget} 字。
            {selectedDialogueOverloaded
              ? "当前偏长，模型会被迫加速念完，容易出现「前半段快、后半段慢」和咬字含糊；建议把这一镜拆成两个镜头，或精简台词。"
              : "当前长度合适。另外：多音字与生僻字容易被读错，官方建议在提示词里用发音一致的常用同音字替换（例如“处理笺”写作“处理签”）。"}
          </p>
        </div>
        {(
          [
            ["reference", "画面参考"],
            ["action", "整体动作链"],
            ["dialogue", "对白表演要求"],
            ["constraints", "画面与对白要求"],
          ] as const
        ).map(([key, label]) => (
          <label className="editor-field" key={key}>
            <span>{label}</span>
            <textarea
              rows={key === "dialogue" ? 5 : 4}
              value={selected.prompt[key]}
              onChange={(event) =>
                updateSelectedShot((shot) => ({
                  ...shot,
                  prompt: { ...shot.prompt, [key]: event.target.value },
                }))
              }
            />
          </label>
        ))}
        <label className="editor-field">
          <span aria-live="polite">
            <FileText size={12} />
            提交给豆包的完整视频提示词 ·{" "}
            {selectedShotVideoPromptPolishing
              ? "后台润色中…"
              : selected.videoPromptPolished
                ? `${selected.videoPromptPolished.model || "文本模型"} 已润色`
                : "镜头时序模板（尚未润色，可直接提交）"}
          </span>
          <textarea
            className="prompt-readonly"
            rows={18}
            readOnly
            value={promptText(selectedVideoPromptShot, selectedVideoReferenceNote)}
          />
        </label>
        <div className="plain-note">
          <CircleHelp size={15} />
          <p>
            以上是实际提交给豆包的完整文本（含完整对白与收尾停顿要求，由系统原样附加、不经模型改写）。
            要调整内容请改上方四段式、完整原文对白或目标时长，改完会自动重新润色。
          </p>
        </div>
        {renderMediaGenerationPanel()}
        <div className="plain-note warning">
          <AlertTriangle size={15} />
          <p>
            提示词可以查看和修改；Provider 在线时可按镜头提交视频任务，只有你点击“验收通过”才会写入正式项目。
          </p>
        </div>
      </>
    );
  };

  const renderInspectorActions = () => {
    if (currentStage === "script") {
      return (
        <button className="primary-button full" type="button" onClick={runCaseExtraction}>
          查看案例提取<ArrowRight size={14} />
        </button>
      );
    }
    if (currentStage === "cases") {
      return (
        <button className="primary-button full" type="button" onClick={() => advanceTo("scriptReview")}>
          进入脚本审查<ArrowRight size={14} />
        </button>
      );
    }
    if (currentStage === "scriptReview") {
      return (
        <button
          className="primary-button full"
          type="button"
          onClick={enterStoryboard}
          disabled={scriptReview.status === "BLOCKED"}
          title={scriptReview.status === "BLOCKED" ? "先解决上方阻断项" : undefined}
        >
          {scriptReview.status === "REVISE" ? "已核对，进入镜头制作" : "进入镜头制作"}
          <ArrowRight size={14} />
        </button>
      );
    }
    if (currentStage === "storyboard") {
      return (
        <>
          <button
            className="secondary-button"
            type="button"
            disabled={selected.storyboardConfirmed}
            onClick={confirmCurrentShot}
          >
            {selectedShotPromptPolishing ? <Sparkles className="spin" size={14} /> : <Check size={14} />}
            {selectedShotPromptPolishing
              ? "画面词润色中…"
              : selected.storyboardConfirmed
                ? "当前镜头已确认"
                : "保存并确认当前镜头"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={confirmStoryboard}
            disabled={unconfirmedShotCount > 0}
            title={unconfirmedShotCount > 0 ? `还需确认 ${unconfirmedShotCount} 个镜头` : undefined}
          >
            <ArrowRight size={14} />
            {unconfirmedShotCount > 0
              ? `还需确认 ${unconfirmedShotCount} 个镜头`
              : "进入画面词"}
          </button>
        </>
      );
    }
    if (currentStage === "imagePrompt") {
      return (
        <>
          <button
            className="secondary-button"
            type="button"
            onClick={() => copyText(selectedImagePrompt.prompt, `${selectedImageDisplayLabel} 画面提示词已复制`)}
          >
            <Copy size={14} />复制
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              selectProductionItem(selectedImagePrompt.id);
              setCurrentStage("videoPrompt");
              if (videoReadyShotCount === shotDrafts.length) {
                setWorkflowStage("videoPrompt");
              }
            }}
            disabled={!selectedImageVideoPromptReady}
            title={
              !selectedImageShot?.storyboardConfirmed
                ? "请先确认当前分镜"
                : selectedImageShot && referenceImageStaleFor(selectedImageShot)
                  ? `参考图已过期（上次确认后修改了：${
                      shotConfirmedChanges(selectedImageShot).join("、") || "部分内容"
                    }），请重新选图或确认保留`
                  : !selectedImageVideoPromptReady
                    ? "请先采用当前镜头的参考图"
                    : undefined
            }
          >
            <ArrowRight size={14} />
            {selectedImageVideoPromptReady
              ? "进入当前镜头视频词"
              : selectedImageShot && referenceImageStaleFor(selectedImageShot)
                ? "参考图已过期"
                : "当前镜头待选图"}
          </button>
        </>
      );
    }
    if (currentStage === "videoPrompt") {
      if (!selectedVideoPromptReady) {
        return (
          <button
            className="primary-button full"
            type="button"
            onClick={() => {
              if (!selected.storyboardConfirmed) {
                setCurrentStage("storyboard");
                return;
              }
              setSelectedImagePromptId(selected.referenceId ?? selected.id);
              setCurrentStage("imagePrompt");
            }}
          >
            <ArrowRight size={14} />
            {selected.storyboardConfirmed
              ? "去完成当前镜头参考图"
              : "先确认当前分镜"}
          </button>
        );
      }
      return (
        <>
          <button className="secondary-button" type="button" onClick={resetSelectedShot}>
            <RotateCcw size={14} />恢复
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => copyText(promptText(selectedVideoPromptShot, selectedVideoReferenceNote), `${selectedDisplayLabel} 视频提示词已复制`)}
          >
            <Copy size={14} />复制 Prompt
          </button>
        </>
      );
    }
    return (
      <button className="primary-button full" type="button" onClick={() => announce(`${stage.label}的当前修改已保存`)}>
        <Check size={14} />保存当前内容
      </button>
    );
  };

  if (authStatus !== "authenticated") {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="app-brand auth-brand">
            <span className="app-logo" aria-hidden="true"><Film size={18} /></span>
            <strong>AI 科普动画生产工作台</strong>
          </div>
          {authStatus === "loading" ? <p>正在检查登录状态…</p> : (
            <>
              <h1 id="auth-title">{authMode === "login" ? "登录工作台" : "创建工作台账号"}</h1>
              <p className="auth-hint">项目、规则、素材和生成任务会按邮箱隔离。</p>
              <form className="auth-form" onSubmit={submitAuth}>
                <label>邮箱<input type="email" autoComplete="email" value={authFormEmail} onChange={(event) => setAuthFormEmail(event.target.value)} required /></label>
                <label>密码<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} minLength={8} required /></label>
                {authMessage ? <p className="auth-error" role="alert">{authMessage}</p> : null}
                <button className="primary-button full" type="submit" disabled={authBusy}>
                  {authBusy ? "处理中…" : authMode === "login" ? "登录" : "注册并登录"}
                  <ArrowRight size={15} />
                </button>
              </form>
              <button className="text-button auth-switch" type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthMessage(""); }}>
                {authMode === "login" ? "第一次使用？创建账号" : "已有账号？返回登录"}
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  // 项目数据异步恢复前不要渲染内置验收项目，避免首屏先闪到一个项目再被替换。
  if (!draftsLoaded) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-live="polite">
          <div className="app-brand auth-brand">
            <span className="app-logo" aria-hidden="true"><Film size={18} /></span>
            <strong>AI 科普动画生产工作台</strong>
          </div>
          <p>正在打开项目列表…</p>
        </section>
      </main>
    );
  }

  return (
      <main className="app-shell" onPaste={handleReferencePaste}>
      <a className="skip-link" href="#workspace">跳到工作区</a>
      <div className="workspace-frame" id="workspace">
        <section className="project-heading" aria-label="项目流程">
          <div className="project-left">
            <div className="app-brand">
              <span className="app-logo" aria-hidden="true"><Film size={18} /></span>
              <strong>AI 科普动画生产工作台</strong>
            </div>
            <button
              className="project-current"
              type="button"
              aria-label={`打开项目列表，当前项目：${projectTitle}`}
              onClick={() => setManagementPanel("projects")}
            >
              <span>{projectTitle}</span>
              <ChevronDown size={14} />
            </button>
          </div>

          <nav
            className="stage-rail"
            aria-label="制作阶段"
            style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(62px, 1fr))` }}
          >
            {stages.map((item, index) => {
              const detail = item.key === "videoPrompt"
                ? `${videoReadyShotCount} / ${shotDrafts.length} 镜可生成视频`
                : index > workflowStageIndex
                  ? "等待上一阶段"
                  : item.key === "script"
                  ? `${scriptDrafts.length} 个非空段落`
                  : item.key === "cases"
                    ? `${caseDrafts.length} 个最小案例`
                    : item.key === "scriptReview"
                      ? `文字审查 · ${scriptReview.status}`
                    : item.key === "storyboard"
                      ? `${confirmedShotCount} / ${shotDrafts.length} 个已确认${imagePromptPolishingIds.length ? ` · ${imagePromptPolishingIds.length} 条润色中` : ""}`
                      : item.key === "imagePrompt"
                        ? `${imagePromptDrafts.length} 条画面词 · ${
                            imagePromptDrafts.filter(
                              (prompt) => prompt.status === "ready",
                            ).length
                          } 个已选图`
                        : item.detail;
              const indicatorState =
                index < workflowStageIndex
                  ? "done"
                  : index === workflowStageIndex
                    ? "current"
                    : "waiting";
              return (
              <button
                className={`stage-step ${indicatorState} ${
                  item.key === currentStage ? "viewing" : ""
                }`}
                type="button"
                key={item.key}
                title={`${item.label}：${detail}`}
                aria-current={item.key === currentStage ? "step" : undefined}
                onClick={() => setCurrentStage(item.key)}
              >
                <span className="stage-dot">
                  {indicatorState === "done" ? <Check size={11} /> : index + 1}
                </span>
                <strong>{item.short}</strong>
                <small>{detail}</small>
              </button>
            )})}
          </nav>

          <div className="project-actions">
            <span className="user-chip" title={authEmail}>
              <span className="user-chip-avatar" aria-hidden="true"><UserRound size={13} /></span>
              <span className="user-chip-name">{authEmail}</span>
            </span>
            <button className="text-button" type="button" onClick={() => void logout()}>退出</button>
            <button className="secondary-button" type="button" onClick={() => setManagementPanel("knowledge")}>
              <LibraryBig size={15} />素材与规则
            </button>
            <button
              className="icon-button header-settings"
              type="button"
              title="工作台设置"
              aria-label="打开工作台设置"
              onClick={() => setManagementPanel("settings")}
            >
              <Settings2 size={16} />
            </button>
            <button className="primary-button" type="button" onClick={openNewProject}>
              <Plus size={15} />新建项目
            </button>
          </div>
        </section>

        <section className="production-desk">
          <section className="stage-canvas" aria-live="polite">
            {renderMainContent()}
          </section>

          <aside className="stage-inspector" aria-label={`${stage.label}操作`}>
            {isScriptStage && (
              <>
                <div className="source-replace-wrap">
                  <label className="upload-block">
                    <UploadCloud size={20} />
                    <span>
                      <strong>{isParsingWord ? "正在读取 Word…" : "替换原始 Word"}</strong>
                      <small>{sourceFileName}</small>
                    </span>
                    <input
                      type="file"
                      accept=".docx"
                      disabled={isParsingWord}
                      onChange={handleScriptUpload}
                    />
                  </label>
                </div>
                {/* 导入那一步的自动内容审核：结果就显示在导入入口旁边，不用去别处找。 */}
                {renderScriptAuditPanel({ compact: true })}
                <nav className="production-tabs script-tabs" aria-label="脚本工作台内容">
                  {[
                    ["cases", "最小案例"],
                    ["scriptReview", "脚本审查"],
                  ].map(([key, label]) => (
                    <button
                      className={currentStage === key ? "active" : ""}
                      type="button"
                      key={key}
                      aria-current={currentStage === key ? "page" : undefined}
                      onClick={() => setCurrentStage(key as StageKey)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
              </>
            )}
            {isProductionStage && (
              <nav className="production-tabs" aria-label="镜头制作内容">
                {[
                  ["storyboard", "镜头内容"],
                  ["imagePrompt", "画面词"],
                  ["videoPrompt", "视频词"],
                ].map(([key, label]) => (
                  <button
                    className={currentStage === key ? "active" : ""}
                    type="button"
                    key={key}
                    aria-current={currentStage === key ? "page" : undefined}
                    onClick={() => setCurrentStage(key as StageKey)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            )}
            <div className="inspector-scroll">{renderInspectorContent()}</div>
            <footer className="inspector-actions">{renderInspectorActions()}</footer>
          </aside>
        </section>
      </div>

      <nav className="mobile-nav" aria-label="移动端导航">
        <button className="active" type="button"><Layers3 size={18} />生成</button>
        <button type="button" onClick={() => setManagementPanel("projects")}><FolderKanban size={18} />项目</button>
        <button type="button" onClick={() => setManagementPanel("content")}><PackageCheck size={18} />内容</button>
        <button type="button" onClick={() => setManagementPanel("knowledge")}><LibraryBig size={18} />资产</button>
        <button type="button" onClick={openNewProject}><Plus size={18} />新建</button>
      </nav>

      {shotStructureDialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShotStructureDialog(null);
          }}
        >
          <section
            className="project-dialog shot-structure-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shot-structure-title"
          >
            <header>
              <div>
                <span>镜头结构调整</span>
                <h2 id="shot-structure-title">
                  {shotStructureDialog === "split"
                    ? `拆分 ${selectedDisplayLabel}`
                    : `合并 ${selectedDisplayLabel} 与下一镜`}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setShotStructureDialog(null)}
              >
                <X size={18} />
              </button>
            </header>

            {shotStructureDialog === "split" ? (
              <>
                <p className="dialog-intro">
                  选择一个自然对白节点。拆分不会从一句话中间硬切，确认后只重新生成本案例受影响镜头的场景、动作链和提示词。
                </p>
                <div className="split-option-list" role="radiogroup" aria-label="拆分位置">
                  {splitOptions.map((option) => (
                    <label
                      className={selectedSplitKey === option.key ? "active" : ""}
                      key={option.key}
                    >
                      <input
                        type="radio"
                        name="split-position"
                        value={option.key}
                        checked={selectedSplitKey === option.key}
                        onChange={() => setSelectedSplitKey(option.key)}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>
                          拆分后约 {option.beforeSeconds} 秒 / {option.afterSeconds} 秒
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="dialog-intro">
                  合并后保留全部原文对白，并根据合并后的文本重新生成场景和整体动作链。
                </p>
                <div className={`merge-preview ${mergedShotSeconds > MAX_SHOT_SECONDS ? "over" : ""}`}>
                  <span>合并后预计时长</span>
                  <strong>合并后预计 {mergedShotSeconds} 秒</strong>
                  {mergedShotSeconds > MAX_SHOT_SECONDS && (
                    <small>超过 15 秒建议值，但你仍可以人工确认合并。</small>
                  )}
                </div>
                <div className="merge-dialogue-preview">
                  <p>{selected.dialogue}</p>
                  <span>接续</span>
                  <p>{nextCaseShot?.dialogue}</p>
                </div>
              </>
            )}

            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShotStructureDialog(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  shotStructureDialog === "split" && !selectedSplitOption
                }
                onClick={
                  shotStructureDialog === "split"
                    ? confirmShotSplit
                    : confirmShotMerge
                }
              >
                {shotStructureDialog === "split" ? (
                  <><Scissors size={14} />确认拆分</>
                ) : (
                  <><Combine size={14} />确认合并</>
                )}
              </button>
            </footer>
          </section>
        </div>
      )}

      {projectDialogOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setProjectDialogOpen(false);
          }}
        >
          <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
            <header>
              <div><span>创建生产任务</span><h2 id="new-project-title">新建宣传视频项目</h2></div>
              <button className="icon-button" type="button" aria-label="关闭" onClick={() => setProjectDialogOpen(false)}><X size={18} /></button>
            </header>
            <label className="field-label" htmlFor="project-name">项目名称</label>
            <input
              className="text-field"
              id="project-name"
              value={draftProjectName}
              onChange={(event) => setDraftProjectName(event.target.value)}
              placeholder="可留空；上传 Word 后自动使用文档标题"
            />
            <label className="field-label">原始 Word 脚本</label>
            <label
              className={`document-drop ${newProjectUploadStatus}`}
              aria-live="polite"
            >
              {newProjectUploadStatus === "uploading" ? (
                <Clock3 className="upload-status-icon" size={24} />
              ) : newProjectUploadStatus === "auditing" ? (
                <ClipboardCheck className="upload-status-icon" size={24} />
              ) : newProjectUploadStatus === "ready" ? (
                <CheckCircle2 className="upload-status-icon" size={24} />
              ) : newProjectUploadStatus === "error" ? (
                <AlertTriangle className="upload-status-icon" size={24} />
              ) : (
                <FileText className="upload-status-icon" size={24} />
              )}
              <span>
                <strong>
                  {newProjectUploadStatus === "uploading"
                    ? "正在读取并提取 Word…"
                    : newProjectUploadStatus === "auditing"
                      ? "已提取，正在让模型通读脚本做内容审核…"
                      : newProjectUploadStatus === "ready"
                        ? "Word 已读取，可以进入工作台"
                        : newProjectUploadStatus === "error"
                          ? "读取失败，点击重新选择"
                          : "选择 .docx 文件"}
                </strong>
                <small>
                  {newProjectUploadSummary
                    ? `${newProjectUploadSummary.fileName} · ${newProjectUploadSummary.paragraphCount} 段 · ${newProjectUploadSummary.caseCount} 个最小案例`
                    : "上传后会自动填写标题，并显示读取结果"}
                </small>
              </span>
              <input
                type="file"
                accept=".docx"
                disabled={
                  newProjectUploadStatus === "uploading" ||
                  newProjectUploadStatus === "auditing"
                }
                onChange={(event) => handleScriptUpload(event, "new")}
              />
            </label>
            {scriptAudit ? (
              renderScriptAuditPanel({ compact: true })
            ) : (
              <div className="preflight-card">
                <ShieldCheck size={18} />
                <div><strong>先确认原文，再进入案例提取</strong><p>每个阶段都会显示对应内容，不展示虚构的后台运行过程。</p></div>
              </div>
            )}
            <footer>
              <button className="secondary-button" type="button" onClick={() => setProjectDialogOpen(false)}>取消</button>
              <button
                className="primary-button"
                type="button"
                disabled={newProjectUploadStatus !== "ready"}
                onClick={() => void confirmNewProject()}
              >
                {newProjectUploadStatus === "ready"
                  ? "进入脚本工作台"
                  : newProjectUploadStatus === "auditing"
                    ? "正在审核脚本…"
                    : "请先上传 Word"}
                <ArrowRight size={15} />
              </button>
            </footer>
          </section>
        </div>
      )}

      {feedbackDialogOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setFeedbackDialogOpen(false);
          }}
        >
          <section className="project-dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
            <header>
              <div>
                <span>项目反馈留痕</span>
                <h2 id="feedback-title">记录一次采用、修改或拒绝</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭" onClick={() => setFeedbackDialogOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="feedback-grid">
              <label>
                <span>发生阶段</span>
                <select value={feedbackDraft.stage} onChange={(event) => setFeedbackDraft((current) => ({ ...current, stage: event.target.value as StageKey }))}>
                  {stages.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </label>
              <label>
                <span>对象 ID</span>
                <input value={feedbackDraft.targetId} onChange={(event) => setFeedbackDraft((current) => ({ ...current, targetId: event.target.value }))} />
              </label>
              <label className="feedback-wide">
                <span>问题类型</span>
                <select value={feedbackDraft.issueType} onChange={(event) => setFeedbackDraft((current) => ({ ...current, issueType: event.target.value }))}>
                  {FEEDBACK_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="feedback-wide">
                <span>为什么要改或拒绝</span>
                <textarea rows={3} value={feedbackDraft.reason} onChange={(event) => setFeedbackDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="例如：同一角色的发型前后不一致，下一镜无法直接复用。" />
              </label>
              <label className="feedback-wide">
                <span>修改前</span>
                <textarea rows={4} value={feedbackDraft.before} onChange={(event) => setFeedbackDraft((current) => ({ ...current, before: event.target.value }))} />
              </label>
              <label className="feedback-wide">
                <span>修改后</span>
                <textarea rows={4} value={feedbackDraft.after} onChange={(event) => setFeedbackDraft((current) => ({ ...current, after: event.target.value }))} placeholder="可在修改完成后补录。" />
              </label>
              <fieldset className="decision-group feedback-wide">
                <legend>处理结果</legend>
                {([
                  ["pending", "待处理"],
                  ["adopted", "已采用"],
                  ["rejected", "已拒绝"],
                ] as Array<[FeedbackDecision, string]>).map(([value, label]) => (
                  <label key={value}>
                    <input type="radio" name="feedback-decision" value={value} checked={feedbackDraft.decision === value} onChange={() => setFeedbackDraft((current) => ({ ...current, decision: value }))} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            </div>
            <footer>
              <button className="secondary-button" type="button" onClick={() => setFeedbackDialogOpen(false)}>取消</button>
              <button className="secondary-button" type="button" disabled={aiRuleLoading} onClick={() => void recordFeedback(false)}><Save size={15} />仅保存本次反馈</button>
              <button className="primary-button" type="button" disabled={aiRuleLoading} onClick={() => void recordFeedback(true)}>
                <Sparkles size={15} />
                {aiRuleLoading ? "模型整理中…" : aiConfiguration.configured ? "保存并生成项目规则候选" : "保存并尝试生成项目规则"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {managementPanel && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setManagementPanel(null);
          }}
        >
          <section className="project-dialog management-dialog" role="dialog" aria-modal="true">
            <header>
              <div>
                <span>{managementPanel === "projects" ? "工作台" : managementPanel === "knowledge" ? "跨项目复用" : managementPanel === "settings" ? "工作台设置" : "当前项目"}</span>
                <h2>{managementPanel === "projects" ? "项目" : managementPanel === "knowledge" ? "规则与素材" : managementPanel === "settings" ? "设置" : projectTitle}</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭" onClick={() => setManagementPanel(null)}>
                <X size={18} />
              </button>
            </header>

            {managementPanel === "projects" ? (
              <div className="management-list">
                <div className="management-toolbar">
                  <div>
                    <strong>{projectSummaries.length} 个本地项目</strong>
                    <small>统一保存在当前工作台的数据文件中</small>
                  </div>
                  <button className="secondary-button compact" type="button" onClick={() => void exportCurrentProject()}><Download size={14} />导出当前</button>
                  <button className="secondary-button compact" type="button" onClick={() => void exportWholeWorkspace()}><Download size={14} />导出整个工作台</button>
                  <label className="secondary-button compact import-button">
                    <UploadCloud size={14} />导入项目
                    <input type="file" accept=".json,application/json" onChange={importProjectFile} />
                  </label>
                  <label className="secondary-button compact import-button">
                    <UploadCloud size={14} />合并工作台备份
                    <input type="file" accept=".json,application/json" onChange={importWorkspaceFile} />
                  </label>
                </div>
                <div className="project-list-scroll">
                  {projectSummaries.map((project) => (
                    <button
                      className={`management-card ${project.id === activeProjectId ? "active" : ""}`}
                      type="button"
                      key={project.id}
                      onClick={() => void switchProject(project.id)}
                    >
                      <span className="management-card-icon"><FolderKanban size={18} /></span>
                      <span className="management-card-copy">
                        <strong>{project.title}</strong>
                        <small>{project.sourceFileName}</small>
                        <em>{stages.find((item) => item.key === project.workflowStage)?.label ?? project.workflowStage} · {formatProjectTime(project.updatedAt)}</em>
                      </span>
                      <span className="management-card-action">{project.id === activeProjectId ? "内容" : "打开"}<ArrowRight size={14} /></span>
                    </button>
                  ))}
                </div>
                <button className="primary-button full" type="button" onClick={() => { setManagementPanel(null); openNewProject(); }}><Plus size={15} />新建视频项目</button>
              </div>
            ) : managementPanel === "knowledge" ? (
              <div className="content-management knowledge-management">
                <div className="management-toolbar">
                  <div>
                    <strong>{reuseRules.length} 条规则 · {referenceAssets.length} 项素材</strong>
                    <small>
                      {aiConfiguration.configured ? `模型已连接 · ${aiConfiguration.model}` : "模型未连接 · 手动流程仍可用"}
                    </small>
                  </div>
                  <button className="secondary-button compact" type="button" onClick={openFeedback}>
                    <MessageSquareText size={14} />从反馈开始
                  </button>
                </div>

                <section className="knowledge-section">
                  <header>
                    <div><Sparkles size={17} /><span><strong>规则库</strong><small>候选需人工启用，规则可随时停用</small></span></div>
                  </header>
                  <div className="rule-scope-guide">
                    <span><strong>本镜修改</strong>只改当前提示词</span>
                    <span><strong>项目规则</strong>只在当前项目匹配</span>
                    <span><strong>全局规则</strong>仅在此处人工晋级</span>
                  </div>
                  <div className="rule-library-list">
                    {reuseRules.length ? reuseRules.map((rule) => (
                      <article className={`rule-library-card ${rule.status}`} key={rule.id}>
                        <div className="rule-library-copy">
                          <span>{rule.status === "candidate" ? "待审核" : rule.status === "active" ? "已启用" : "已停用"} · {rule.scope === "project" ? "当前项目" : rule.scope === "department" ? "部门" : "全局"}</span>
                          <label>
                            <small>规则标题</small>
                            <input aria-label={`${rule.title} 规则标题`} value={rule.title} onChange={(event) => editRuleLocally(rule.id, { title: event.target.value })} />
                          </label>
                          <label>
                            <small>复用指令</small>
                            <textarea aria-label={`${rule.title} 复用指令`} rows={3} value={rule.instruction} onChange={(event) => editRuleLocally(rule.id, { instruction: event.target.value })} />
                          </label>
                          <div className="rule-editor-row">
                            <label>
                              <small>阶段</small>
                              <select value={rule.stage} onChange={(event) => editRuleLocally(rule.id, { stage: event.target.value as StageKey })}>
                                {stages.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                              </select>
                            </label>
                            <label>
                              <small>范围</small>
                              <select value={rule.scope} onChange={(event) => editRuleLocally(rule.id, { scope: event.target.value as ReuseRule["scope"] })}>
                                <option value="project">当前项目</option>
                                {rule.scope === "department" && <option value="department">历史部门范围</option>}
                                <option value="global">全局</option>
                              </select>
                            </label>
                          </div>
                          <label>
                            <small>匹配词（用逗号分隔）</small>
                            <input
                              aria-label={`${rule.title} 匹配词`}
                              value={rule.keywords.join("，")}
                              onChange={(event) => editRuleLocally(rule.id, {
                                keywords: [...new Set(event.target.value.split(/[，,]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 12),
                              })}
                            />
                          </label>
                          <small>采用 {rule.adoptedCount} · 不适用 {rule.rejectedCount}</small>
                        </div>
                        <div className="rule-library-actions">
                          <button className="secondary-button compact" type="button" onClick={() => void saveRuleEdits(rule)}>保存修改</button>
                          <button className="secondary-button compact" type="button" disabled={!rule.previous} onClick={() => void undoRuleEdit(rule)}>撤销上次修改</button>
                          <button
                            className={rule.status === "active" ? "secondary-button compact" : "primary-button compact"}
                            type="button"
                            onClick={() => void updateRuleStatus(rule, rule.status === "active" ? "retired" : "active")}
                          >
                            {rule.status === "active" ? "停用" : "审核并启用"}
                          </button>
                        </div>
                      </article>
                    )) : <div className="empty-project-history">还没有规则。先记录一次真实修改，再由模型或人工整理成候选。</div>}
                  </div>
                </section>

                <section className="knowledge-section">
                  <header>
                    <div><LibraryBig size={17} /><span><strong>人物、风格与场景资产</strong><small>固定人物与整体风格控制生成，豆包选中的场景图可跨项目复用</small></span></div>
                  </header>
                  <div className="asset-library-grid">
                    {referenceAssets.length ? referenceAssets.map((asset) => (
                      <article className={`asset-library-card ${asset.kind}`} key={asset.id}>
                        <Image src={asset.image} alt={asset.title} width={320} height={180} unoptimized />
                        <div>
                          <span className={`asset-kind-badge ${asset.kind}`}>
                            {asset.kind === "character"
                              ? `人物 · ${asset.roleName}`
                              : asset.kind === "style"
                                ? "整体风格"
                                : "场景成图"}
                          </span>
                          <label>
                            <small>素材名称</small>
                            <input aria-label={`${asset.title} 素材名称`} value={asset.title} onChange={(event) => editAssetLocally(asset.id, { title: event.target.value })} />
                          </label>
                          <div className="rule-editor-row">
                            <label>
                              <small>素材类型</small>
                              <select
                                value={asset.kind}
                                onChange={(event) => editAssetLocally(asset.id, {
                                  kind: event.target.value as ReferenceAsset["kind"],
                                  roleName: event.target.value === "character" ? asset.roleName || asset.title : undefined,
                                })}
                              >
                                <option value="scene">场景成图</option>
                                <option value="character">固定人物</option>
                                <option value="style">整体风格</option>
                              </select>
                            </label>
                            {asset.kind === "character" && (
                              <label>
                                <small>角色名称</small>
                                <input
                                  aria-label={`${asset.title} 角色名称`}
                                  value={asset.roleName ?? ""}
                                  onChange={(event) => editAssetLocally(asset.id, { roleName: event.target.value })}
                                />
                              </label>
                            )}
                          </div>
                          <label>
                            <small>标签（用逗号分隔）</small>
                            <input
                              aria-label={`${asset.title} 素材标签`}
                              value={asset.tags.join("，")}
                              onChange={(event) => editAssetLocally(asset.id, {
                                tags: [...new Set(event.target.value.split(/[，,]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 12),
                              })}
                            />
                          </label>
                          <small>{asset.builtIn ? "工作台固定资产" : `来源 ${asset.sourcePromptId}`} · 已复用 {asset.usageCount} 次</small>
                          <div className="asset-library-actions">
                            <button className="secondary-button compact" type="button" onClick={() => void saveAssetEdits(asset)}>保存信息</button>
                            {asset.kind === "character" ? (
                              <>
                                <button className="secondary-button compact" type="button" onClick={() => void applyCharacterAsset(asset)}>
                                  加入当前画面词
                                </button>
                                <button className="secondary-button compact" type="button" onClick={() => downloadReferenceAsset(asset)}>
                                  <Download size={13} />下载人物图
                                </button>
                              </>
                            ) : asset.kind === "style" ? (
                              <>
                                <span className="asset-auto-status">
                                  <CheckCircle2 size={13} />生图时自动附带
                                </span>
                                <button className="secondary-button compact" type="button" onClick={() => downloadReferenceAsset(asset)}>
                                  <Download size={13} />下载风格图
                                </button>
                              </>
                            ) : (
                              <button className="secondary-button compact" type="button" onClick={() => void reuseReferenceAsset(asset)}>
                                用作 {selectedImageDisplayLabel} 参考图
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    )) : <div className="empty-project-history">还没有公共素材。回到画面词，上传豆包选图后点击“沉淀到素材库”。</div>}
                  </div>
                </section>
              </div>
            ) : managementPanel === "settings" ? (
              <div className="content-management workbench-settings">
                <section className="settings-section">
                  <header>
                    <div>
                      <strong>默认口播节奏</strong>
                      <small>用于估算时长与判断是否需要拆镜，单镜仍可单独调整。</small>
                    </div>
                    <span>{speechRate} 字/秒</span>
                  </header>
                  <div className="pace-preset-grid">
                    {SPEECH_RATE_PRESETS.map((preset) => (
                      <button
                        className={speechRate === preset.value ? "active" : ""}
                        type="button"
                        key={preset.value}
                        onClick={() => applyProjectSpeechRate(preset.value)}
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.note}</small>
                        <em>{preset.value} 字/秒</em>
                      </button>
                    ))}
                  </div>
                  <p className="settings-hint">改变节奏只会重算预计时长和超时提示，不会自动删除图片或重新拆镜。</p>
                </section>

                <section className="settings-section model-connection-section">
                  <header>
                    <div>
                      <strong>文本模型连接</strong>
                      <small>只用于 Word 结构复核和把人工反馈整理成待审核规则，不负责生成图片或视频。</small>
                    </div>
                    <span className={`status-badge ${aiConfiguration.configured ? "ready" : "missing"}`}>
                      {aiConfiguration.configured ? "已连接" : "可选"}
                    </span>
                  </header>

                  {aiConfiguration.configured && !aiConnectionEditing ? (
                    <div className="connection-summary">
                      <span className="ai-connection-icon"><KeyRound size={19} /></span>
                      <div>
                        <strong>{aiConfiguration.model}</strong>
                        <small>{AI_PROVIDER_PRESETS.find((item) => item.value === aiConfiguration.provider)?.label ?? "自定义服务"} · {aiConfiguration.endpoint}</small>
                      </div>
                      <button className="secondary-button compact" type="button" onClick={editAiConnection}>管理连接</button>
                    </div>
                  ) : (
                    <form className="model-connection-form" onSubmit={(event) => { event.preventDefault(); void saveAiSettings(); }}>
                      <label>
                        <span>服务商</span>
                        <select value={aiConnectionDraft.provider} onChange={(event) => changeAiProvider(event.target.value)}>
                          {AI_PROVIDER_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                      </label>
                      <label className="settings-field-wide">
                        <span>服务地址</span>
                        <input value={aiConnectionDraft.endpoint} onChange={(event) => setAiConnectionDraft((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://…/chat/completions" />
                      </label>
                      <label>
                        <span>模型名称</span>
                        <input value={aiConnectionDraft.model} onChange={(event) => setAiConnectionDraft((current) => ({ ...current, model: event.target.value }))} placeholder="例如 glm-4-flash" />
                      </label>
                      <label>
                        <span>API Key</span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={aiConnectionDraft.apiKey}
                          onChange={(event) => {
                            setAiConnectionDraft((current) => ({ ...current, apiKey: event.target.value }));
                            setAiSettingsState("idle");
                            setAiSettingsMessage("");
                          }}
                          placeholder={
                            !aiConfiguration.configured
                              ? "粘贴服务商提供的 Key"
                              : aiConnectionNeedsKey
                                ? "切换服务时需填写对应的新 Key"
                                : "留空则继续使用当前 Key"
                          }
                        />
                      </label>
                      <small className="settings-field-wide">当前支持 OpenAI Chat Completions 兼容接口。同一服务只改模型可复用旧 Key；切换服务商或地址必须填写新 Key。Key 只保存在这台电脑，不进入项目文件或工作台备份。</small>
                      {aiSettingsMessage && (
                        <p className={`ai-settings-message ${aiSettingsState} settings-field-wide`} role={aiSettingsState === "error" ? "alert" : "status"}>{aiSettingsMessage}</p>
                      )}
                      <div className="model-connection-actions settings-field-wide">
                        {aiConfiguration.configured && <button className="secondary-button" type="button" onClick={cancelAiConnectionEdit}>取消</button>}
                        {AI_PROVIDER_PRESETS.find((item) => item.value === aiConnectionDraft.provider)?.consoleUrl && (
                          <a className="secondary-button" href={AI_PROVIDER_PRESETS.find((item) => item.value === aiConnectionDraft.provider)?.consoleUrl} target="_blank" rel="noreferrer">获取 Key<ExternalLink size={14} /></a>
                        )}
                        <button className="primary-button" type="submit" disabled={aiSettingsState === "saving"}><KeyRound size={15} />{aiSettingsState === "saving" ? "正在验证…" : "验证并保存"}</button>
                      </div>
                    </form>
                  )}
                  {!aiConfiguration.configured && <p className="settings-hint">不连接模型也能继续使用规则提取、调整分镜、复制提示词和沉淀素材。</p>}
                </section>

                <section className="settings-section model-connection-section">
                  <header>
                    <div>
                      <strong>视觉模型连接</strong>
                      <small>只在填写“不采用”反馈时识别图片，随后交给文本模型重写当前提示词；不会自动采用或提交豆包。</small>
                    </div>
                    <span className={`status-badge ${visionConfiguration.configured ? "ready" : "missing"}`}>
                      {visionConfiguration.configured ? "已连接" : "可选"}
                    </span>
                  </header>

                  {visionConfiguration.configured && !visionConnectionEditing ? (
                    <div className="connection-summary">
                      <span className="ai-connection-icon"><Eye size={19} /></span>
                      <div>
                        <strong>{visionConfiguration.model}</strong>
                        <small>{AI_PROVIDER_PRESETS.find((item) => item.value === visionConfiguration.provider)?.label ?? "自定义服务"} · {visionConfiguration.endpoint}</small>
                      </div>
                      <button className="secondary-button compact" type="button" onClick={editVisionConnection}>管理连接</button>
                    </div>
                  ) : (
                    <form className="model-connection-form" onSubmit={(event) => { event.preventDefault(); void saveVisionSettings(); }}>
                      <label>
                        <span>服务商</span>
                        <select value={visionConnectionDraft.provider} onChange={(event) => changeVisionProvider(event.target.value)}>
                          {AI_PROVIDER_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                      </label>
                      <label className="settings-field-wide">
                        <span>服务地址</span>
                        <input value={visionConnectionDraft.endpoint} onChange={(event) => setVisionConnectionDraft((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://…/chat/completions" />
                      </label>
                      <label>
                        <span>视觉模型名称</span>
                        <input value={visionConnectionDraft.model} onChange={(event) => setVisionConnectionDraft((current) => ({ ...current, model: event.target.value }))} placeholder="例如 glm-4.6v-flash" />
                      </label>
                      <label>
                        <span>API Key</span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={visionConnectionDraft.apiKey}
                          onChange={(event) => {
                            setVisionConnectionDraft((current) => ({ ...current, apiKey: event.target.value }));
                            setVisionSettingsState("idle");
                            setVisionSettingsMessage("");
                          }}
                          placeholder={
                            !visionConfiguration.configured
                              ? "可复用文本模型 Key，或填写新的 Key"
                              : visionConnectionNeedsKey
                                ? "切换服务时需填写对应的新 Key"
                                : "留空则继续使用当前 Key"
                          }
                        />
                      </label>
                      <small className="settings-field-wide">未单独填写时会复用文本模型的服务地址与 Key；保存后 Key 仍只存放在本机 `.env.local`。</small>
                      {visionSettingsMessage && (
                        <p className={`ai-settings-message ${visionSettingsState} settings-field-wide`} role={visionSettingsState === "error" ? "alert" : "status"}>{visionSettingsMessage}</p>
                      )}
                      <div className="model-connection-actions settings-field-wide">
                        {visionConfiguration.configured && <button className="secondary-button" type="button" onClick={cancelVisionConnectionEdit}>取消</button>}
                        <button className="primary-button" type="submit" disabled={visionSettingsState === "saving"}><Eye size={15} />{visionSettingsState === "saving" ? "正在验证…" : "验证并保存"}</button>
                      </div>
                    </form>
                  )}
                </section>

                <section className="settings-section provider-settings-section">
                  <header>
                    <div>
                      <strong>豆包生成连接</strong>
                    <small>通过工作台自己的本机后台使用豆包网页版，并管理多个隔离登录账号。</small>
                    </div>
                    <span className={`status-badge ${providerOverview.online ? "ready" : "missing"}`}>
                      {providerOverview.online ? "服务在线" : "服务离线"}
                    </span>
                  </header>
                  <div className="provider-address-row">
                    <label>
                      <span>本机 Provider 地址</span>
                      <input
                        value={providerBaseUrl}
                        onChange={(event) => setProviderBaseUrl(event.target.value)}
                        placeholder="http://127.0.0.1:8012"
                      />
                    </label>
                    <div className="provider-address-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={providerOverview.online || !providerOverview.runtimeStartable || Boolean(providerAction)}
                        onClick={() => void startProvider()}
                      >
                        <Server size={15} />
                        {providerAction === "start-provider"
                          ? "启动中…"
                          : providerOverview.online
                            ? "Provider 已启动"
                            : "启动本机 Provider"}
                      </button>
                      <button className="primary-button" type="button" disabled={providerAction === "save-settings"} onClick={() => void saveProviderSettings()}>
                        <RefreshCw size={15} />{providerAction === "save-settings" ? "检查中…" : "保存并检查"}
                      </button>
                    </div>
                  </div>
                  <p className="settings-hint">
                    这里只接受 `localhost` 或 `127.0.0.1`。账号会话由工作台自己的本机后台隔离保存；日常生成隐藏运行，只有登录失效或需要人工验证时才显示豆包窗口。
                    {providerOverview.runtimeInstalled
                      ? " 本机运行时已安装。"
                      : " 本机运行时尚未安装，仍可连接你自行启动的兼容 Provider。"}
                  </p>

                  <div className="provider-account-list">
                    {providerAccounts.length ? providerAccounts.map((account) => (
                      <article className={account.id === selectedProviderAccountId ? "selected" : ""} key={account.id}>
                        <button
                          className="provider-account-main"
                          type="button"
                          onClick={() => {
                            setSelectedProviderAccountId(account.id);
                            window.localStorage.setItem(MEDIA_ACCOUNT_KEY, account.id);
                          }}
                        >
                          <span className={`provider-account-dot ${account.loginStatus}`} />
                          <span>
                            <strong>{account.alias}</strong>
                            <small>{accountStatusLabel(account.loginStatus)}{account.quotaText ? ` · ${account.quotaText}` : ""}</small>
                          </span>
                          {account.id === selectedProviderAccountId && <Check size={14} />}
                        </button>
                        <div>
                          <button type="button" disabled={Boolean(providerAction)} onClick={() => void runAccountAction(account, "check-account")}><RefreshCw size={13} />检查</button>
                          <button type="button" disabled={Boolean(providerAction)} onClick={() => void runAccountAction(account, "login-account")}><ExternalLink size={13} />{account.loginStatus === "logged_in" ? "重新登录" : "登录"}</button>
                        </div>
                      </article>
                    )) : (
                      <div className="provider-empty-state">
                        <UserRound size={20} />
                        <span><strong>{providerOverview.online ? "还没有豆包账号" : "Provider 启动后才能读取账号"}</strong><small>{providerOverview.online ? "在下方创建账号后，分别完成一次网页登录。" : "当前页面仍可使用复制 Prompt 和手工上传。"}</small></span>
                      </div>
                    )}
                  </div>

                  <div className="provider-account-create">
                    <label>
                      <span>新增豆包账号</span>
                      <input value={newProviderAccountName} onChange={(event) => setNewProviderAccountName(event.target.value)} placeholder="例如 豆包账号 2" />
                    </label>
                    <button className="secondary-button" type="button" disabled={!providerOverview.online || providerAction === "create-account"} onClick={() => void addProviderAccount()}>
                      <UserPlus size={15} />{providerAction === "create-account" ? "创建中…" : "创建隔离账号"}
                    </button>
                  </div>
                  {providerMessage && <p className="provider-settings-message" role="status">{providerMessage}</p>}
                </section>
              </div>
            ) : (
              <div className="content-management">
                <div className="management-toolbar">
                  <div>
                    <strong>{sourceFileName}</strong>
                    <small>自动保存于 {formatProjectTime(lastSavedAt)}</small>
                  </div>
                  <button className="secondary-button compact" type="button" onClick={() => void exportCurrentProject()}><Download size={14} />导出备份</button>
                  <label className="secondary-button compact import-button">
                    <UploadCloud size={14} />导入为新项目
                    <input type="file" accept=".json,application/json" onChange={importProjectFile} />
                  </label>
                </div>
                <div className="content-shortcuts">
                  {[
                    ["cases", `${caseDrafts.length} 个最小案例`, "查看案例"],
                    ["storyboard", `${shotDrafts.length} 个视频镜头`, "编辑分镜"],
                    ["imagePrompt", `${imagePromptDrafts.filter((item) => item.status === "ready").length} / ${imagePromptDrafts.length} 已选图`, "管理画面"],
                    ["videoPrompt", `${shotDrafts.length} 条视频提示词`, "查看视频词"],
                  ].map(([key, value, action]) => (
                    <button type="button" key={key} onClick={() => { setCurrentStage(key as StageKey); setManagementPanel(null); }}>
                      <strong>{value}</strong><span>{action}<ArrowRight size={13} /></span>
                    </button>
                  ))}
                </div>
                <section className="history-section">
                  <header>
                    <div><History size={17} /><span><strong>项目历史与反馈</strong><small>{projectHistory.length} 条记录</small></span></div>
                    <button className="secondary-button compact" type="button" onClick={openFeedback}><MessageSquareText size={14} />记录反馈</button>
                  </header>
                  <div className="history-list">
                    {projectHistory.length ? projectHistory.map((entry) => (
                      <article className="history-entry" key={entry.id}>
                        <div><strong>{entry.title}</strong><time>{formatProjectTime(entry.createdAt)}</time></div>
                        {/*
                          2026-10-08 二轮：历史条目的 `targetId` 是**审计键**（内部键），
                          按它与媒体任务一一对应；但界面上不能把内部键端给用户，所以显示时
                          过一遍 `shotDisplayLabel` 换成对外展示编号。
                          两点必须一起做：
                           - **解析不到就原样回退**（`shotDisplayLabel` 自带）：历史里混着
                             `all-image-prompts`、源文件名和已被删掉的旧编号，它们原样显示；
                           - **`title` 保留原始审计键**：展示编号表达的是"当前第几镜"，
                             而这条记录记的是"当时那一镜"，一次重排后两者会不同。悬停可查。
                        */}
                        {(entry.stage || entry.targetId || entry.decision) && <small>{entry.stage ? stages.find((item) => item.key === entry.stage)?.label : ""}{entry.targetId ? <span title={entry.targetId}>{` · ${shotDisplayLabel(shotDrafts, entry.targetId)}`}</span> : ""}{entry.decision ? ` · ${entry.decision === "adopted" ? "已采用" : entry.decision === "rejected" ? "已拒绝" : "待处理"}` : ""}</small>}
                        {entry.reason && <p>{entry.reason}</p>}
                        {entry.kind === "feedback" && entry.issueType !== "规则复用" && entry.reason && (
                          <button className="history-rule-action" type="button" onClick={() => void createManualRuleFromHistory(entry)}>
                            转为项目规则候选
                          </button>
                        )}
                      </article>
                    )) : <div className="empty-project-history">还没有反馈记录。当前修改会自动保存，判断原因可单独留痕。</div>}
                  </div>
                </section>
              </div>
            )}
          </section>
        </div>
      )}

      {toast && (
        <div
          className={toast.tone === "warn" ? "toast warn" : "toast"}
          role="status"
        >
          {toast.tone === "warn" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <div className="toast-body">
            <span className="toast-text">{toast.text}</span>
            {toast.detail?.length ? (
              <details className="toast-detail" onToggle={holdToast}>
                <summary>查看逐镜明细（{toast.detail.length}）</summary>
                <ul>
                  {toast.detail.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭通知"
            onClick={dismissToast}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </main>
  );
}
