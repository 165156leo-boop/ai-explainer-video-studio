import { isRecord } from "./data-shape.ts";
import type {
  ExtractedCase,
  ImagePromptPackage,
  ScriptParagraph,
  Shot,
  StageKey,
} from "./workbench-data";
import { nonGenerationParagraphIds, postProductionEffectParagraphIds, backfillPerformanceCue } from "./extraction-review.ts";
import { SPEECH_UNITS_PER_SECOND, buildImagePrompts } from "./shot-planning.ts";
import {
  cleanImagePromptForProvider,
  normalizeReferenceAsset,
  normalizeReuseRule,
  type ReferenceAsset,
  type ReuseRule,
} from "./workspace-memory.ts";

export const PROJECT_SCHEMA_VERSION = 2;
export const WORKSPACE_SCHEMA_VERSION = 2;
export const ACTIVE_PROJECT_KEY =
  "publicity-video-ai-workbench:active-project-id";
export const STORYBOARD_RULE_VERSION_KEY =
  "publicity-video-ai-workbench:storyboard-rule-version";
/**
 * 分镜规则版本。提升它会让**存量项目在加载时重建一次分镜**（见
 * `needsStoryboardRebuild`），所以它同时是「内容身份 + 动作节拍 + 时长模型」
 * 三层规则的版本号，而不只是某一次改动的时间戳。
 *
 * - `v9`：动作 + 对白衔接判定、可执行动作校验（2026-10-07 之前）
 * - `v10`：`semantic-action-chain`（2026-10-08）——三层一次上线：
 *   ① 内容身份继承（`inheritShotAssets`）：改名/插入分镜不再错绑素材与确认状态；
 *   ② 动作节拍分类：动作与对白衔接的合成一镜，对白前的详细动作独立成镜；
 *   ③ 时长模型：纯画面镜不再是 0 秒，动作时间进语速预估。
 */
export const STORYBOARD_RULE_VERSION = "semantic-action-chain-v10";
/**
 * 暂缓自动重建的旧规则版本（用户 2026-10-08 裁定）。
 *
 * `approved-sample-speed-v5` 是「加班餐不能这样吃」这一期的规则版本：它按
 * 「每段画面说明都独立成镜」产出的 6 个分镜，在新规则下会拆到 11 个
 * （S2-E1 由 1 镜变 4 镜、S3-E1 由 4 镜变 6 镜）。拆分力度本身是对的，
 * 但那一期用户已经审过、不打算重做，所以先让**只有它**跳过这次迁移，
 * 先把还在真实生产的「公务接待费」迁到位，拆分力度的变更另行评估。
 *
 * 为什么按规则版本而不是按项目 id：项目 id 是数据，换个库就失效；规则版本是
 * 产物的属性，跟着数据一起走。当前数据里 `approved-sample-speed-v5` 恰好只被
 * 这一期使用，不会误伤别的项目。
 */
export const DEFERRED_STORYBOARD_RULE_VERSIONS: ReadonlySet<string> = new Set([
  "approved-sample-speed-v5",
]);

/** 归档项目用的是「已审查归档」引擎，产物冻结，任何自动迁移都要避开它。 */
export function isArchivedExtractionEngine(value: string) {
  return value.includes("已审查归档");
}

/**
 * 这个项目在加载时要不要按新规则重建分镜？
 *
 * 三条都满足才重建：规则版本落后、不是归档产物、不在暂缓名单里。
 * 判断放在这里而不是页面上，是因为它是**数据决策**，需要能被单测直接覆盖——
 * 一次误判会把用户已经确认的分镜和已采用的图片一起冲掉。
 *
 * 注意：编码时若 `storyboardRuleVersion` 缺失（很老的项目），会走重建，
 * 这是有意的——没有版本号就意味着它一定不是 v10 产出的。
 */
export function needsStoryboardRebuild(
  project: Pick<ProjectSnapshot, "storyboardRuleVersion" | "extractionEngine">,
  currentVersion: string = STORYBOARD_RULE_VERSION,
) {
  if (!project.extractionEngine) return false;
  if (project.storyboardRuleVersion === currentVersion) return false;
  if (isArchivedExtractionEngine(project.extractionEngine)) return false;
  return !DEFERRED_STORYBOARD_RULE_VERSIONS.has(project.storyboardRuleVersion);
}

const LEGACY_CROP_FRAMING =
  "采用比正常画面稍远一档的宽松中景或中全景，镜头适当后退。所有人物、手势和关键道具完整集中在画面中央，人物周围保留充足、连续的环境背景。";

const DATABASE_NAME = "publicity-video-ai-workbench";
const DATABASE_VERSION = 1;
const PROJECT_STORE = "projects";

export type ReviewStatus = "PASS" | "REVISE" | "BLOCKED";

export type ScriptReviewIssue = {
  message: string;
  sourceId?: number;
  caseId?: string;
  sourceText?: string;
  reason?: string;
  question?: string;
  action?: string;
};

export type ScriptReviewReport = {
  status: ReviewStatus;
  checks: Array<{
    label: string;
    status: ReviewStatus;
    detail: string;
  }>;
  flags: string[];
  issues: ScriptReviewIssue[];
};

export type FeedbackDecision = "pending" | "adopted" | "rejected";

export type ProjectHistoryEntry = {
  id: string;
  kind: "created" | "imported" | "source-replaced" | "feedback";
  createdAt: string;
  title: string;
  stage?: StageKey;
  targetId?: string;
  issueType?: string;
  reason?: string;
  before?: string;
  after?: string;
  decision?: FeedbackDecision;
};

export type AcceptanceRun = {
  id: string;
  testerName: string;
  startedAt: string;
  completedAt?: string;
  notes: string;
  checks: Array<{
    id: string;
    label: string;
    completed: boolean;
  }>;
};

export type ProjectSnapshot = {
  schemaVersion: number;
  id: string;
  ownerEmail?: string;
  title: string;
  sourceFileName: string;
  createdAt: string;
  updatedAt: string;
  currentStage: StageKey;
  workflowStage: StageKey;
  selectedId: string;
  selectedCaseId: string;
  selectedImagePromptId: string;
  scriptDrafts: ScriptParagraph[];
  caseDrafts: ExtractedCase[];
  shotDrafts: Shot[];
  imagePromptDrafts: ImagePromptPackage[];
  scriptReview: ScriptReviewReport;
  extractionEngine: string;
  storyboardRuleVersion: string;
  speechRate: number;
  /** 2026-09-16：项目级默认视频模型（逐镜可用 shot.videoModel 覆盖）。 */
  videoModel?: string;
  uploadedNames: Record<string, string>;
  history: ProjectHistoryEntry[];
  acceptanceRuns: AcceptanceRun[];
};

export type ProjectSummary = Pick<
  ProjectSnapshot,
  | "id"
  | "title"
  | "sourceFileName"
  | "createdAt"
  | "updatedAt"
  | "workflowStage"
>;

export type WorkspaceSnapshot = {
  schemaVersion: 2;
  activeProjectId: string;
  projects: ProjectSnapshot[];
  rules: ReuseRule[];
  assets: ReferenceAsset[];
};

const STAGES = new Set<StageKey>([
  "script",
  "cases",
  "scriptReview",
  "storyboard",
  "imagePrompt",
  "reference",
  "videoPrompt",
]);

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`项目文件缺少 ${field}`);
  }
  return value;
}

function requiredArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`项目文件缺少 ${field}`);
  return value;
}

function requiredRecordArray(
  value: unknown,
  field: string,
  idType: "string" | "number",
) {
  const items = requiredArray(value, field);
  if (
    items.length === 0 ||
    items.some(
      (item) => !isRecord(item) || typeof item.id !== idType,
    )
  ) {
    throw new Error(`项目文件中的 ${field} 无效`);
  }
  return items;
}

function stageValue(value: unknown, field: string): StageKey {
  if (typeof value !== "string" || !STAGES.has(value as StageKey)) {
    throw new Error(`项目文件中的 ${field} 无效`);
  }
  return value as StageKey;
}

/**
 * Validate a portable JSON snapshot at the boundary. Nested workbench records
 * remain forward-compatible; the page and TypeScript own their exact shape.
 */
export function normalizeProjectSnapshot(value: unknown): ProjectSnapshot {
  if (!isRecord(value)) throw new Error("这不是有效的项目文件");
  if (
    typeof value.schemaVersion === "number" &&
    value.schemaVersion > PROJECT_SCHEMA_VERSION
  ) {
    throw new Error("该项目文件来自更新版本，请先升级工作台");
  }

  const review = value.scriptReview;
  if (
    !isRecord(review) ||
    !["PASS", "REVISE", "BLOCKED"].includes(String(review.status)) ||
    !Array.isArray(review.checks) ||
    !Array.isArray(review.flags)
  ) {
    throw new Error("项目文件中的脚本审查记录无效");
  }

  const uploadedNames = isRecord(value.uploadedNames)
    ? Object.fromEntries(
        Object.entries(value.uploadedNames).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

  const history = Array.isArray(value.history)
    ? value.history.filter(isRecord).map((entry) => ({
        id: requiredString(entry.id, "历史记录 ID"),
        kind: requiredString(entry.kind, "历史记录类型") as ProjectHistoryEntry["kind"],
        createdAt: requiredString(entry.createdAt, "历史记录时间"),
        title: requiredString(entry.title, "历史记录标题"),
        stage:
          typeof entry.stage === "string" && STAGES.has(entry.stage as StageKey)
            ? (entry.stage as StageKey)
            : undefined,
        targetId: typeof entry.targetId === "string" ? entry.targetId : undefined,
        issueType: typeof entry.issueType === "string" ? entry.issueType : undefined,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
        before: typeof entry.before === "string" ? entry.before : undefined,
        after: typeof entry.after === "string" ? entry.after : undefined,
        decision: ["pending", "adopted", "rejected"].includes(
          String(entry.decision),
        )
          ? (entry.decision as FeedbackDecision)
          : undefined,
      }))
    : [];
  const acceptanceRuns = Array.isArray(value.acceptanceRuns)
    ? value.acceptanceRuns.filter(isRecord).map((run) => ({
        id: requiredString(run.id, "验收记录 ID"),
        testerName: typeof run.testerName === "string" ? run.testerName : "",
        startedAt: requiredString(run.startedAt, "验收开始时间"),
        completedAt:
          typeof run.completedAt === "string" ? run.completedAt : undefined,
        notes: typeof run.notes === "string" ? run.notes : "",
        checks: Array.isArray(run.checks)
          ? run.checks.filter(isRecord).map((check) => ({
              id: requiredString(check.id, "验收项 ID"),
              label: requiredString(check.label, "验收项"),
              completed: Boolean(check.completed),
            }))
          : [],
      }))
    : [];
  const imagePromptDrafts = requiredRecordArray(
    value.imagePromptDrafts,
    "画面提示词草稿",
    "string",
  ) as ImagePromptPackage[];
  const originalScriptDrafts = requiredRecordArray(
    value.scriptDrafts,
    "脚本草稿",
    "number",
  ) as ScriptParagraph[];
  const originalCaseDrafts = requiredRecordArray(
    value.caseDrafts,
    "案例草稿",
    "string",
  ) as ExtractedCase[];
  const originalExtractionEngine =
    typeof value.extractionEngine === "string" ? value.extractionEngine : "";
  const extractionVersion = /规则版本\s+(\d+(?:\.\d+)?)/u.exec(
    originalExtractionEngine,
  );
  const migrateGenerationBoundary = extractionVersion
    ? Number(extractionVersion[1]) < 1.5
    : false;
  /**
   * 规则版本 < 1.6：把「镜头/特效：」下面的正文从画面动作里摘出来。
   *
   * 2026-09-18 修真实缺陷——「处理笺扫描件浮现在餐桌上方」原本被当成 action_or_narration，
   * 于是进入分镜动作、再进入画面词，被生图模型忠实画成「餐桌」。凡是被判定为后期特效的
   * 段落，这里统一改成 `effect`，并从案例条目与分镜动作里移除（视觉上就是它不再参与生成，
   * 但仍留在脚本里可查、可改回）。
   */
  const migratePostProductionEffect = extractionVersion
    ? Number(extractionVersion[1]) < 1.6
    : false;
  /**
   * 规则版本 < 1.7：给对白条目回填 `performance_cue`（对白标签里的现场提示）。
   *
   * 2026-10-07 修真实缺陷——旧提取器把「王老师一愣」「小李走进来，把平板递过去」
   * 「刘主任有些为难」整段剥掉，对白镜只剩台词、没有任何可执行动作，下游只能合成
   * 口播意向串，再被 continuityVisualActions 全部删掉，最后
   * normalizeVideoPromptBriefs 以「缺少场景或动作」硬拒收。
   *
   * 迁移只补这一个字段：不删除、不重排、不覆盖任何已有内容。
   */
  const migratePerformanceCue = extractionVersion
    ? Number(extractionVersion[1]) < 1.7
    : false;
  const excludedIds = migrateGenerationBoundary
    ? nonGenerationParagraphIds(originalScriptDrafts)
    : new Set<number>();
  const boundaryScriptDrafts = excludedIds.size
    ? originalScriptDrafts.map((paragraph) =>
        excludedIds.has(paragraph.id)
          ? { ...paragraph, kind: "summary" as const }
          : paragraph,
      )
    : originalScriptDrafts;
  const effectIds = migratePostProductionEffect
    ? postProductionEffectParagraphIds(boundaryScriptDrafts)
    : new Set<number>();
  const effectTexts = new Set(
    boundaryScriptDrafts
      .filter((paragraph) => effectIds.has(paragraph.id))
      .map((paragraph) => paragraph.text.trim())
      .filter(Boolean),
  );
  const scriptDrafts = effectIds.size
    ? boundaryScriptDrafts.map((paragraph) =>
        effectIds.has(paragraph.id)
          ? { ...paragraph, kind: "effect" as const }
          : paragraph,
      )
    : boundaryScriptDrafts;
  const migratedCaseDrafts = excludedIds.size || effectIds.size
    ? originalCaseDrafts.map((caseItem) => {
        const items = (caseItem.items ?? []).filter(
          (item) => !excludedIds.has(item.sourceId) && !effectIds.has(item.sourceId),
        );
        return {
          ...caseItem,
          sourceIds: caseItem.sourceIds.filter(
            (id) => !excludedIds.has(id) && !effectIds.has(id),
          ),
          items,
          dialogueCount: items.filter((item) => item.type === "dialogue").length,
        };
      })
    : originalCaseDrafts;
  const caseDrafts = migratePerformanceCue
    ? backfillPerformanceCue(scriptDrafts, migratedCaseDrafts)
    : migratedCaseDrafts;
  /**
   * 迁移后的引擎标签写**已迁到的最新规则版本**。三条迁移是递进的
   * （<1.5 ⊂ <1.6 ⊂ <1.7），旧版项目一次加载就补齐到 1.7 语义，
   * 因此目标版本取最高的那条，而不是各自写自己的版本号——
   * 否则 1.5 的项目迁完仍标 1.6，下次加载会再跑一遍 1.7 回填。
   */
  const migratedRuleVersion = migratePerformanceCue
    ? "1.7"
    : migratePostProductionEffect || migrateGenerationBoundary
      ? "1.6"
      : "";
  const extractionEngine = migratedRuleVersion
    ? originalExtractionEngine.replace(
        /规则版本\s+\d+(?:\.\d+)?/u,
        `规则版本 ${migratedRuleVersion}`,
      )
    : originalExtractionEngine;
  const recognizedNonGenerationIds = nonGenerationParagraphIds(scriptDrafts);
  const reviewExcludedIds = new Set(
    [...recognizedNonGenerationIds].filter((id) =>
      migrateGenerationBoundary ||
      scriptDrafts.find((paragraph) => paragraph.id === id)?.kind === "summary",
    ),
  );
  const reviewChecks = (review.checks as ScriptReviewReport["checks"]).map(
    (check) => check.label === "非生成内容排除"
      ? {
          ...check,
          detail: `字幕、屏幕文字、提示框与音效已排除；后期特效单独标记，不作为画面动作与场景`,
        }
      : check,
  );
  const reviewFlags = (review.flags as string[]).filter((flag) =>
    ![...reviewExcludedIds].some((id) => flag.includes(`第${id}段`)),
  );
  const reviewIssues = Array.isArray(review.issues)
    ? (review.issues as ScriptReviewIssue[]).filter(
        (issue) => !issue.sourceId || !reviewExcludedIds.has(issue.sourceId),
      )
    : [];
  const reviewStatus: ReviewStatus = review.status === "BLOCKED" ||
      reviewChecks.some((check) => check.status === "BLOCKED")
    ? "BLOCKED"
    : reviewFlags.length || reviewIssues.length ||
        reviewChecks.some((check) => check.status === "REVISE")
      ? "REVISE"
      : "PASS";
  const workflowStage = stageValue(value.workflowStage, "生产进度");
  const shotDrafts = requiredRecordArray(
    value.shotDrafts,
    "分镜草稿",
    "string",
  ) as Shot[];
  /**
   * 规则版本 < 1.6：把已经落进分镜动作的后期特效句摘掉。
   * 只按整句精确匹配（这些动作本来就是从脚本条目机器生成的），
   * 且删空时保持原样，避免把一镜变成没有动作的坏数据。
   */
  const cleanedShotIds = new Set<string>();
  const migratedShots: Shot[] = shotDrafts.map((shot) => {
    const originalActions = shot.action ?? [];
    const actions = effectTexts.size
      ? originalActions.filter((action) => !effectTexts.has(action.trim()))
      : originalActions;
    const actionChanged = actions.length !== originalActions.length;
    if (actionChanged) cleanedShotIds.add(shot.id);
    const effectCleaned = actionChanged ? { ...shot, action: actions } : shot;
    return {
      ...effectCleaned,
      storyboardConfirmed: !actionChanged && effectCleaned.storyboardConfirmed === true,
    };
  });
  /**
   * 画面词是分镜的**派生物**。分镜动作被清理过，就意味着这条画面词是"修改前"生成的，
   * 里面可能混着已经不该存在的后期特效内容——而润色过的句子是模型重写过的，
   * 无法用整句精确匹配摘除（实测真实数据：原文「处理笺扫描件浮现在餐桌上方…」
   * 在画面词里已变成「餐桌上方，处理笺」，两边对不上）。
   *
   * 所以这里不猜内容，只认一条不变量：**源变了，派生物就不能继续被信任。**
   * 受影响镜头的画面词用清理后的分镜重建为模板，并清掉 `promptModel`（模板不是模型写的）；
   * 已采用的图片与其签名原样保留，不因为这次迁移丢掉人工成果。
   */
  const rebuiltPromptById = cleanedShotIds.size
    ? new Map(
        buildImagePrompts(
          // 迁移路径面对的是**历史数据**：这些字段在老分镜里可能缺失（本机 fixture 就缺
          // location）。直接喂给模板函数会在 cleanImagePromptAction 上抛
          // 「Cannot read properties of undefined」，所以先补齐成模板函数能接受的最小形状。
          migratedShots.map((shot) => ({
            ...shot,
            caseId: typeof shot.caseId === "string" ? shot.caseId : "",
            title: typeof shot.title === "string" ? shot.title : "",
            location: typeof shot.location === "string" ? shot.location : "",
            speaker: typeof shot.speaker === "string" ? shot.speaker : "",
            continuity: typeof shot.continuity === "string" ? shot.continuity : "",
            action: Array.isArray(shot.action)
              ? shot.action.filter((item): item is string => typeof item === "string")
              : [],
          })),
        )
          // 只重建**被清理过**的那些镜头：其余镜头的画面词是人工/模型产出，
          // 迁移不能顺手把它们全量打回模板（测试里那条对照断言就是防这个）。
          .filter((item) => cleanedShotIds.has(item.id))
          .map((item) => [item.id, item.prompt]),
      )
    : new Map<string, string>();

  return {    schemaVersion:
      typeof value.schemaVersion === "number"
        ? value.schemaVersion
        : PROJECT_SCHEMA_VERSION,
    id: requiredString(value.id, "项目 ID"),
    ownerEmail: typeof value.ownerEmail === "string" ? value.ownerEmail.trim().toLowerCase() : undefined,
    title: requiredString(value.title, "项目名称"),
    sourceFileName: requiredString(value.sourceFileName, "原始文件名"),
    createdAt: requiredString(value.createdAt, "创建时间"),
    updatedAt: requiredString(value.updatedAt, "更新时间"),
    currentStage: stageValue(value.currentStage, "当前查看阶段"),
    workflowStage,
    selectedId: requiredString(value.selectedId, "当前镜头"),
    selectedCaseId: requiredString(value.selectedCaseId, "当前案例"),
    selectedImagePromptId: requiredString(
      value.selectedImagePromptId,
      "当前画面",
    ),
    scriptDrafts,
    caseDrafts,
    shotDrafts: migratedShots,
    imagePromptDrafts: imagePromptDrafts.map((item) => {
      // 分镜被清理过的镜头：画面词改用清理后的分镜重建（见上方 rebuiltPromptById 的说明）。
      const rebuilt = rebuiltPromptById.get(item.id);
      const source = rebuilt ?? item.prompt;
      return {
        ...item,
        ...(rebuilt ? { promptModel: undefined } : {}),
        prompt:
          typeof source === "string"
            ? cleanImagePromptForProvider(source)
                .replace(`构图要求：${LEGACY_CROP_FRAMING}\n`, "")
                .replace(`${LEGACY_CROP_FRAMING}\n`, "")
                .replace(`构图要求：${LEGACY_CROP_FRAMING}`, "")
                .replace(LEGACY_CROP_FRAMING, "")
            : source,
      };
    }),
    scriptReview: {
      status: reviewStatus,
      checks: reviewChecks,
      flags: reviewFlags,
      issues: reviewIssues,
    },
    extractionEngine,
    storyboardRuleVersion:
      typeof value.storyboardRuleVersion === "string"
        ? value.storyboardRuleVersion
        : "",
    speechRate:
      typeof value.speechRate === "number" &&
      Number.isFinite(value.speechRate) &&
      value.speechRate >= 3 &&
      value.speechRate <= 9
        ? value.speechRate
        : // 2026-09-18：回退值必须是**语速基线本身**（shot-planning 的
          // SPEECH_UNITS_PER_SECOND = 5），不能另写一个数——否则「没存过语速的
          // 老项目」会用 6 估算时长，而画面词/视频词模板默认按 5，同一份数据在
          // 两条路径上算出两个时长。用户 09-18 已拍板把项目基线改到 5。
          SPEECH_UNITS_PER_SECOND,
    videoModel: typeof value.videoModel === "string" && value.videoModel ? value.videoModel : undefined,
    uploadedNames,
    history,
    acceptanceRuns,
  };
}

export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value)) throw new Error("这不是有效的工作台备份");
  if (
    typeof value.schemaVersion === "number" &&
    value.schemaVersion > WORKSPACE_SCHEMA_VERSION
  ) {
    throw new Error("该工作台备份来自更新版本，请先升级产品");
  }
  const projects = Array.isArray(value.projects)
    ? value.projects.map(normalizeProjectSnapshot)
    : [];
  if (!projects.length) throw new Error("工作台备份中没有项目");
  const requestedId =
    typeof value.activeProjectId === "string" ? value.activeProjectId : "";
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeProjectId: projects.some((project) => project.id === requestedId)
      ? requestedId
      : projects[0].id,
    projects,
    rules: Array.isArray(value.rules) ? value.rules.map(normalizeReuseRule) : [],
    assets: Array.isArray(value.assets)
      ? value.assets.map(normalizeReferenceAsset)
      : [],
  };
}

export function createProjectId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function mergeProjectSnapshots(
  current: ProjectSnapshot[],
  incoming: ProjectSnapshot[],
) {
  const merged = new Map(current.map((project) => [project.id, project]));
  incoming.forEach((project) => {
    const existing = merged.get(project.id);
    if (!existing || project.updatedAt > existing.updatedAt) {
      merged.set(project.id, project);
    }
  });
  return [...merged.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECT_STORE)) {
        request.result.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开项目存储"));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("项目存储操作失败"));
  });
}

async function listLegacyProjects(): Promise<ProjectSnapshot[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE, "readonly");
    const values = await requestResult(
      transaction.objectStore(PROJECT_STORE).getAll(),
    );
    return values.map(normalizeProjectSnapshot);
  } finally {
    database.close();
  }
}

async function workspaceResponse(response: Response) {
  const data = (await response.json()) as WorkspaceSnapshot & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "项目存储操作失败");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION as 2,
    activeProjectId: data.activeProjectId ?? "",
    projects: Array.isArray(data.projects)
      ? data.projects.map(normalizeProjectSnapshot)
      : [],
    rules: Array.isArray(data.rules)
      ? data.rules.map(normalizeReuseRule)
      : [],
    assets: Array.isArray(data.assets)
      ? data.assets.map(normalizeReferenceAsset)
      : [],
  };
}

export async function loadWorkspace() {
  return workspaceResponse(await fetch("/api/projects", { cache: "no-store" }));
}

export async function migrateLegacyProjects(activeProjectId = "") {
  const workspace = await loadWorkspace();
  // 旧浏览器数据仅用于首次迁移，不能在登录时重新带回已从工作台删除的项目。
  if (workspace.projects.length) return workspace;
  try {
    const projects = await listLegacyProjects();
    if (!projects.length) return workspace;
    return workspaceResponse(
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProjectId, projects }),
      }),
    );
  } catch {
    return workspace;
  }
}

export async function saveProject(snapshot: ProjectSnapshot) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: snapshot, activeProjectId: snapshot.id }),
    }),
  );
}

export async function getProject(id: string) {
  const workspace = await loadWorkspace();
  return workspace.projects.find((project) => project.id === id) ?? null;
}

export async function setActiveProject(id: string) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProjectId: id }),
    }),
  );
}

export async function saveReuseRule(rule: ReuseRule) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "upsert-rule", rule }),
    }),
  );
}

export async function saveReferenceAsset(asset: ReferenceAsset) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "upsert-asset", asset }),
    }),
  );
}

export async function recordRuleDecision(
  ruleId: string,
  decision: "adopted" | "rejected",
) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "record-rule-decision", ruleId, decision }),
    }),
  );
}

export async function undoReuseRule(ruleId: string) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "undo-rule", ruleId }),
    }),
  );
}

export async function mergeWorkspaceBackup(snapshot: WorkspaceSnapshot) {
  return workspaceResponse(
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    }),
  );
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const workspace = await loadWorkspace();
  return summarizeProjects(workspace.projects);
}

export function summarizeProjects(projects: ProjectSnapshot[]): ProjectSummary[] {
  return projects.map(
    ({ id, title, sourceFileName, createdAt, updatedAt, workflowStage }) => ({
      id,
      title,
      sourceFileName,
      createdAt,
      updatedAt,
      workflowStage,
    }),
  );
}
