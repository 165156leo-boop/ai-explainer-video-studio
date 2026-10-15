import { isRecord } from "./data-shape.ts";
import type { Shot } from "./workbench-data";

export type MediaType = "image" | "video";
export type MediaJobStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "cancelled";
export type MediaCandidateStatus = "pending" | "adopted" | "rejected" | "kept";
export type VisionReviewStatus = "PASS" | "REVISE" | "BLOCKED" | "ERROR";

export type VisionReview = {
  status: VisionReviewStatus;
  issueTags: string[];
  evidence: string;
  retrySuggestion: string;
  model: string;
  createdAt: string;
};

export type MediaCandidate = {
  id: string;
  fileName: string;
  mimeType: string;
  previewUrl: string;
  status: MediaCandidateStatus;
  error?: string;
  visionReview?: VisionReview;
  /**
   * 用户点「不采用」时填写的退回原因（2026-09-16 起视频候选也持久化）。
   * 图片候选的退回意见走「视觉诊断+重写」链路，视频候选暂无 AI 整理，
   * 先把原文留下来，供规则沉淀与后续视频词反馈闭环使用。
   */
  rejectionReason?: string;
  /**
   * 2026-09-16：成片实测时长（秒，mp4 mvhd）。视频候选创建时由工作台实测写入，
   * 与请求时长差 20% 以上会自动拒收（防豆包丢失参数后静默降档出 10 秒片）。
   */
  actualDurationSeconds?: number;
};

export type MediaJob = {
  id: string;
  projectId: string;
  projectTitle: string;
  targetId: string;
  /**
   * 该镜头**对外展示的编号**（`S1-E1_01`，下划线；内部键是 `S1-E1-04`），
   * 创建任务时由页面算好存进来（2026-10-08）。`targetId` 仍是唯一索引键；
   * 这一项只用于两处给人看的地方：
   * 采用素材时的导出文件名，以及候选图的 aria/alt。服务端拿不到项目分镜列表，
   * 自己算不出顺序号，所以只能随任务一起存。旧任务没有这个字段，回退 `targetId`。
   */
  targetLabel?: string;
  mediaType: MediaType;
  accountId: string;
  promptSnapshot: string;
  status: MediaJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  upstreamJobId?: string;
  providerMessage?: string;
  quotaText?: string;
  retryOfJobId?: string;
  candidates: MediaCandidate[];
};

export type ProviderAccount = {
  id: string;
  alias: string;
  enabled: boolean;
  loginStatus: "unknown" | "logged_in" | "logged_out" | "verification_required";
  loginReason?: string;
  quotaBalance?: number;
  quotaText?: string;
  /**
   * 2026-09-16：豆包免费账号的视频额度按「5 秒」为单位发放，每天约 50 秒，
   * 消耗按视频秒数计——所以一个账号「还剩多少秒」才决定它能不能接这一镜。
   */
  videoQuotaRemainingSeconds?: number;
  videoQuotaTotalSeconds?: number;
  videoQuotaCan15s?: number;
  videoQuotaCan5s?: number;
  videoQuotaExhausted?: boolean;
  videoQuotaText?: string;
  videoQuotaDay?: string;
  lastUsedAt?: string;
  updatedAt?: string;
};

export type SelectedMediaSource = {
  jobId: string;
  candidateId: string;
};

type SchedulableJob = Pick<MediaJob, "accountId" | "status" | "createdAt">;

type VideoPromptShot = {
  id: string;
  referenceId?: string;
  storyboardConfirmed?: boolean;
  image?: string;
  status?: "ready" | "missing";
};

type VideoPromptReference = {
  id: string;
  image?: string;
  status: "ready" | "missing";
};

export function canUseVideoPromptForShot(
  shot: VideoPromptShot,
  references: VideoPromptReference[],
) {
  const reference = references.find(
    (item) => item.id === (shot.referenceId ?? shot.id),
  );
  return Boolean(
    shot.storyboardConfirmed &&
      ((reference?.status === "ready" && reference.image) ||
        (shot.status === "ready" && shot.image)),
  );
}

/**
 * 尾帧转高清连续性图时使用的独立 Prompt。静态首帧不混入本镜动作。
 *
 * 2026-10-08 用户拍板：参数从内部键改为**对外展示的镜头编号**（`S2-E1_01`）——
 * 这段文案会进入发给豆包的提示词，用户要看到的是按案例顺序排的编号，不是可能
 * 带缺口、可能乱序的内部键。传入值只用于文本，不参与任何查找。
 */
export function tailFrameEnhancementInstruction(sourceShotLabel: string) {
  const source = String(sourceShotLabel || "上一镜").trim().slice(0, 80) || "上一镜";
  return (
    `16:9 横屏。本次只使用第 1 张参考图（上一镜 ${source} 验收视频的尾帧）作为画面事实来源。` +
    "这是静态首帧连续性高清重绘，不是动作生成：保持人物身份、人数、服装、场景、构图、机位、姿态、视线、手势、道具位置和接触关系完全一致。" +
    "只修复视频压缩、运动模糊、锯齿和细节涂抹；不得添加、删除、复制或移动任何人物与物体。" +
    "禁止根据本镜剧情预演动作，禁止拿起、放下、展示、指向、敲门、进门或改变手中道具状态；本镜动作只在后续视频提示词中执行。" +
    "画面中不要出现额外文字、字幕或提示框。"
  );
}

/**
 * 2026-09-16 晚：分镜 → 参考图的级联失效。
 *
 * 背景（用户反馈）：分镜内容修改后，确认状态会被静默重置，但已采用的参考图
 * 原样保留、界面也不说改了哪里——「怎么能采用旧的」。修复分三层：
 * 1. `shotVisualSignature`：分镜中**决定画面内容**的字段签名（人物/场景/动作/衔接，
 *    与 buildImagePrompts 的取材一致）。采用图片时记录签名，之后一比即知图是否过期。
 * 2. `referenceImageStale`：参考图存在且有签名、但签名与当前分镜不符 → 过期。
 *    无签名的旧数据视为未过期（兼容存量项目，确认分镜时会补签）。
 *    口播节奏/对白/时长等不进签名——它们影响视频词与时长，但不改变画面本身。
 * 3. `shotConfirmedChanges` + `makeShotConfirmedSnapshot`：确认分镜时存快照，
 *    之后随时能列出「上次确认后改了哪些字段」，界面明确指出来。
 */

export type ShotVisualFields = {
  id?: string;
  referenceId?: string;
  speaker?: string;
  location?: string;
  action?: string[];
  continuity?: string;
};

export type ShotDiffFields = ShotVisualFields & {
  title?: string;
  dialogue?: string;
  estimatedSeconds?: number;
  videoSecondsOverride?: number;
  videoModel?: string;
  speechRateOverride?: number;
};

export function shotVisualSignature(shot: ShotDiffFields): string {
  return JSON.stringify([
    shot.speaker ?? "",
    shot.location ?? "",
    shot.action ?? [],
    shot.continuity ?? "",
  ]);
}

/**
 * 内容身份（2026-10-07，Layer 1）。
 *
 * ## 要解决的问题
 *
 * `shot-planning.ts` 里 `shot.id` 是 `${案例}-${两位序号}`，它同时背着三件事：
 * 展示编号、素材/确认状态的键、**内容身份**。于是插入一个空白动作分镜后，
 * 后面全部重新编号，用户此前确认过的图和确认状态就绑到了别的分镜上——
 * 用户原话：「确认的分镜生成内容不能光按照分镜名字对应，而是内容对应，改名还能找到。」
 *
 * ## 为什么是这个字段组合
 *
 * 身份必须**只由不随规划器改动而变的东西**决定，否则每次调整动作生成规则
 * （比如 Layer 2）都会让全部素材失配。真正稳定的只有两样：
 *
 * 1. **这一镜装了哪些原文行**（`sourceId` + `sourceSegment` + 对白/画面）——
 *    原文是脚本事实，不因分镜怎么切而变；
 * 2. **这一镜说了哪几句台词**（从 `dialogue` 里取引号内原文，逐字保留）。
 *
 * 刻意**不含** `action`/`location`/`speaker`：它们正是规划器的产物，一变就全错，
 * 而且 `shotVisualSignature` 已经负责「画面是否还配得上」那个问题——两个问题分开回答。
 * 纯画面镜没有台词，身份就等于它的原文行集合；画面行不会被再切分，所以仍然唯一。
 *
 * 这套判定对应 OpenTimelineIO 的结构分离：「这个镜头是什么内容」「持续多久」
 * 「用了哪张图」是三个独立字段，不能让一个字符串 ID 承担全部职责。
 */
export type ContentIdentityFields = {
  caseId?: string;
  dialogue?: string;
  sourceItems?: Array<{
    sourceId?: number;
    sourceSegment?: number;
    type?: string;
    text?: string;
    speaker?: string;
    sceneHint?: string;
    performance_cue?: string;
  }>;
};

function sourceRowKey(shot: ContentIdentityFields) {
  return (shot.sourceItems ?? [])
    .map((item) => {
      const segment = item.sourceSegment ? `:${item.sourceSegment}` : "";
      return `${item.sourceId ?? 0}${segment}${item.type === "dialogue" ? "D" : "V"}`;
    })
    .join(",");
}

/** 引号内的台词原文（去掉空白），顺序敏感——它就是这一镜的「内容指纹」。 */
function dialogueLinesKey(shot: ContentIdentityFields) {
  return [...String(shot.dialogue ?? "").matchAll(/[“"]([^“”"]+)[”"]/gu)]
    .map((match) => match[1].replace(/\s+/gu, ""))
    .join("｜");
}

export function shotContentIdentity(shot: ContentIdentityFields): string {
  return JSON.stringify([shotSourceIdentity(shot), dialogueLinesKey(shot)]);
}

/** 原文身份包含内容与案例，不能只认段落号：同一段会改字，也可能移动到另一案例。 */
export function shotSourceIdentity(shot: ContentIdentityFields): string {
  return JSON.stringify([
    shot.caseId ?? "",
    sourceRowKey(shot),
    shot.sourceItems?.map((item) => [
      item.text ?? "", item.speaker ?? "", item.sceneHint ?? "", item.performance_cue ?? "",
    ]),
  ]);
}

/** 只要能定位到案例和分镜的最小结构，`Shot` 天然满足。 */
export type ShotIdentityFields = {
  id: string;
  caseId?: string;
  speaker?: string;
  action?: string[];
};

/**
 * 分镜所属的**案例号**（`S1-E1`）。
 *
 * 案例号来自 Python 抽取器：`S` 是「提示一/二/三」的序号，`E` 是提示内的案例序号，
 * 不是 Scene/Episode。存量分镜有的带 `caseId`、有的只能从 `id` 前缀切出来，
 * 这段表达式原本在 `page.tsx` 里重复了六处，统一到这里。
 */
export function shotCaseId(shot: Pick<ShotIdentityFields, "id" | "caseId">): string {
  return shot.caseId ?? shot.id.replace(/-\d{2}$/u, "");
}

/**
 * 本镜在该案例内的**顺序号**（1 起），按传入列表的文档顺序给。
 *
 * 顺序号必须和 `shot.id` 分开：`id` 是画面词与媒体任务的主键，插入一镜后编号会
 * 留下缺口、也可能不按顺序（真实数据里 `S1-E1` 案例就是 `S1-E1-04` 在前、
 * `S1-E1-03` 在后）。人看的镜号只能是顺序号。
 */
export function shotDisplayNumber(items: ShotIdentityFields[], shotId: string): number | undefined {
  const index = items.findIndex((shot) => shot.id === shotId);
  if (index < 0) return undefined;
  const caseId = shotCaseId(items[index]);
  let next = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    if (shotCaseId(items[cursor]) === caseId) next += 1;
  }
  return next;
}

/**
 * 对外展示的镜头编号：`案例号_两位顺序号`，例如 `S1-E1_02`（2026-10-08 用户拍板）。
 *
 * 用户原话：「统一用 SE 这种格式展示，不用 1.2.3 了，-01.-02 这种也不要内部编号了，
 * 就对外展示，还是要按顺序去做，不要反直觉」——所以对外只有这一种写法，
 * 它同时表达「哪个案例」和「第几镜」，界面上不再出现裸 `1`/`2`。
 *
 * ## 分隔符为什么是下划线（2026-10-08 二轮）
 *
 * 用户追问「内部编号和外部编号用同一种编码方式，但最后的数字含义不同，是否需要区分」。
 * 答案是必须区分，而且**形式上**区分：用户拍板展示编号用 `_`、内部键保持 `-`。
 * 于是 `S1-E1_01`（展示）与 `S1-E1-04`（内部键）**不可能同形**——一眼就能分辨，
 * 也不用再靠「这个数字到底是顺序号还是历史键」去推断。
 *
 * 同码的代价是实测过的：插入 / 删除 / 重排 / 拆分任意一镜都会让两套编号分叉，
 * 撞名之后 `findContinuityReferenceShot` 会把用户看着界面写下的编号解析到别的镜，
 * 服务端拒收文案里的内部键也会被用户当成界面编号去找（找不到）。
 *
 * **内部键一律不动**：`shot.id`、媒体任务 `targetId`、画面词 `promptId`、
 * `uploadedNames` 的键、历史条目的 `targetId`、润色队列键都继续用 `shot.id`。
 * 把可重排的顺序号塞进键位会静默地把已采用的图片、已验收的视频接到别的分镜上。
 *
 * 查不到该分镜时**回退原字符串**——历史条目里混着 `all-image-prompts`、源文件名和
 * 已被删掉的旧编号，它们必须原样显示，不能崩也不该被改写成别的东西。
 */
export function shotDisplayLabel(items: ShotIdentityFields[], shotId: string): string {
  const number = shotDisplayNumber(items, shotId);
  if (!number) return shotId;
  const index = items.findIndex((shot) => shot.id === shotId);
  return `${shotCaseId(items[index])}_${String(number).padStart(2, "0")}`;
}

/**
 * 胶片条第二行：本镜的**人物 + 动作简述**（2026-10-08 用户拍板）。
 *
 * 第二行原本显示 `shot.title`，而同一案例内每一镜的 title 完全相同，
 * 一列卡片看下来全是同一句话，没有区分度。`speaker`（`小陈 → 王老师`）和
 * `action[0]`（`王老师一愣`）才是这一镜独有的信息。两项各自可缺，缺哪项就只留另一项。
 */
export function shotBriefLabel(
  shot: Pick<ShotIdentityFields, "speaker" | "action">,
  maxLength = 60,
): string {
  const speaker = String(shot.speaker ?? "").trim();
  const action = String(shot.action?.[0] ?? "").trim();
  const parts = [speaker, action].filter(Boolean);
  const brief = parts.join(" · ");
  return brief.length > maxLength ? `${brief.slice(0, maxLength - 1)}…` : brief;
}

/**
 * 旧镜 → 重建镜 的配对（Layer 1）。
 *
 * 两档，**先精确后模糊**，一对一、不重复占用：
 *
 * 1. **同内容**（身份字符串完全一致）：原文行与台词都一致 → 连 `storyboardConfirmed`
 *    一起继承。这正是「只改标题/只重排顺序」的情形，用户已经确认过的东西必须留住。
 * 2. **同来源**（原文行是旧镜的子集，且重合度 `>= MIN_INHERIT_SCORE`，且同案例）：
 *    只继承 `image`/`status`，**不继承确认状态**。一旧镜拆成 A1/A2 时两边得分相同，
 *    按文档顺序取靠前的那个；另一个保持待确认。
 *
 * 不继承确认状态的这条界限很重要：确认状态是生成视频的闸门，把没确认过的新分镜
 * 标成「已确认」等于放行一镜没人看过的画面。
 *
 * **合并**（新镜的来源行里含有旧镜从未拍到的内容）不自动继承，见 `isSourceSubset`。
 */
const MIN_INHERIT_SCORE = 0.5;

function sourceRows(shot: ContentIdentityFields) {
  return (shot.sourceItems ?? [])
    .map((item) =>
      `${item.sourceId ?? 0}${item.sourceSegment ? `:${item.sourceSegment}` : ""}`,
    );
}

function overlapScore(next: ContentIdentityFields, previous: ContentIdentityFields) {
  const left = sourceRows(next);
  const right = sourceRows(previous);
  if (!left.length || !right.length) return 0;
  const remaining = [...right];
  let hits = 0;
  for (const row of left) {
    const at = remaining.indexOf(row);
    if (at >= 0) {
      remaining.splice(at, 1);
      hits += 1;
    }
  }
  return hits / Math.max(left.length, right.length);
}

/**
 * 新镜的来源行是不是**全都在**旧镜里出现过。
 *
 * 这条判定把「拆分」与「合并」分开，而重合度做不到这件事——两者都可能是 0.5：
 * 旧镜 `[14,15]` 拆成 `[14]` 与 `[15]`，两个新镜的重合度都是 0.5；反过来
 * 旧镜 `[14]` 与 `[15]` 合并成 `[14,15]`，重合度同样是 0.5。
 *
 * 区别在于**旧图还覆不覆盖这一镜**：
 * - 拆分时新镜是旧镜的一片，旧图描述的正是它 → 可以继承；
 * - 合并时新镜含有旧镜从来没拍到的内容，旧图不再覆盖它 → 不继承，交给用户重选。
 *
 * 这与 `TODO-2026-09-29-后续优化.md` 第 3 条一致：代码不猜「这一镜应该有怎样的画面」，
 * 猜不准就不替用户做决定。
 */
function isSourceSubset(
  next: ContentIdentityFields,
  previous: ContentIdentityFields,
) {
  const left = sourceRows(next);
  const right = sourceRows(previous);
  if (!left.length || !right.length) return false;
  const remaining = [...right];
  for (const row of left) {
    const at = remaining.indexOf(row);
    if (at < 0) return false;
    remaining.splice(at, 1);
  }
  return true;
}

export type InheritableShot = ContentIdentityFields & {
  id: string;
  image?: string;
  status?: "ready" | "missing";
  storyboardConfirmed?: boolean;
  confirmedSnapshot?: string;
  imageSourceSignature?: string;
} & Partial<Pick<Shot,
  "referenceId" | "speaker" | "location" | "action" | "continuity" | "prompt" |
  "estimatedSeconds" | "planningNote" | "videoLastFrame" | "videoLastFrameSignature" |
  "videoPromptPolished" | "videoSecondsOverride" | "videoModel" | "speechRateOverride"
>>;

/**
 * 一镜的继承结果。`previousIndex` 指回原数组的下标，`idKept` 表示它沿用了旧编号。
 *
 * 为什么编号也要沿用：`shot.id` 同时是**画面词的主键**和**媒体任务的 targetId**
 * （`page.tsx` 的 `adoptedVideoPreviewByShotId` 就是按 `job.targetId` 索引的）。
 * 只搬图不搬编号，已验收的视频仍会挂到错的分镜上——和图片错绑是同一个 bug。
 * 因此配对成功的分镜沿用旧编号，新分镜才领新号；界面上的镜号改看 `shotNumber`。
 */
export type InheritedShot<T> = {
  shot: T;
  previousIndex: number;
  /** 来源与内容精确匹配，可进一步核对画面后继承确认和视频成果。 */
  exact: boolean;
  idKept: boolean;
};

/** 在一个案例内分配没被占用的编号（`S1-E1-01` 式），供新增分镜使用。 */
function allocateCaseIds(caseId: string, count: number, taken: Set<string>) {
  const ids: string[] = [];
  for (let n = 1; ids.length < count && n <= count + taken.size + 8; n += 1) {
    const id = `${caseId}-${String(n).padStart(2, "0")}`;
    if (!taken.has(id)) ids.push(id);
  }
  return ids;
}

export function inheritShotAssets<T extends InheritableShot>(
  rebuilt: T[],
  previous: T[],
  options: { preserveEdits?: boolean } = {},
): InheritedShot<T>[] {
  const claimedByPrevious = new Set<number>();
  const patch = new Map<number, { source: T; index: number; exact: boolean }>();

  const exactIdentity = new Map<string, number>();
  previous.forEach((shot, index) => {
    const key = options.preserveEdits ? shotSourceIdentity(shot) : shotContentIdentity(shot);
    if (!exactIdentity.has(key)) exactIdentity.set(key, index);
  });
  rebuilt.forEach((shot, index) => {
    // 没有任何来源行的镜头（历史数据缺 sourceItems）不参与配对，
    // 否则它们身份全等，会互相抢同一个来源。
    if (!sourceRows(shot).length) return;
    const at = exactIdentity.get(options.preserveEdits ? shotSourceIdentity(shot) : shotContentIdentity(shot));
    if (at === undefined || claimedByPrevious.has(at)) return;
    claimedByPrevious.add(at);
    patch.set(index, { source: previous[at], index: at, exact: true });
  });

  const fuzzy: Array<{ next: number; prev: number; score: number }> = [];
  rebuilt.forEach((shot, index) => {
    if (patch.has(index) || !sourceRows(shot).length) return;
    previous.forEach((candidate, at) => {
      if (claimedByPrevious.has(at) || candidate.caseId !== shot.caseId) return;
      if (!isSourceSubset(shot, candidate)) return;
      const score = overlapScore(shot, candidate);
      if (score >= MIN_INHERIT_SCORE) fuzzy.push({ next: index, prev: at, score });
    });
  });
  // 得分高的先挑；并列时**文档顺序靠前的先挑**——拆分场景下前一半更接近原镜，
  // 后一半是新内容，理应回到待确认。
  fuzzy.sort((left, right) => right.score - left.score || left.next - right.next);
  for (const pair of fuzzy) {
    if (patch.has(pair.next) || claimedByPrevious.has(pair.prev)) continue;
    claimedByPrevious.add(pair.prev);
    patch.set(pair.next, {
      source: previous[pair.prev],
      index: pair.prev,
      exact: false,
    });
  }

  // 编号分配分三步，保证「插入一镜」不会把后面所有镜头整体重新编号：
  // ① 配对成功的分镜沿用旧编号（图片、画面词、媒体任务都挂在它上面）；
  // ② 其余分镜优先用 `buildCaseShots` 给的编号，只要它没被①占用；
  // ③ 还撞车才另领一个空闲号。
  // 界面上的镜号看 `shotNumber`，所以编号本身可以出现「01、02、04」这种缺口——
  // 编号是**键**，不是给人读的序号。
  const reservedIds = new Set<string>();
  const keptIds = new Map<number, string>();
  rebuilt.forEach((shot, index) => {
    const match = patch.get(index);
    if (!match || reservedIds.has(match.source.id)) return;
    reservedIds.add(match.source.id);
    keptIds.set(index, match.source.id);
  });
  const takenIds = new Set([...reservedIds, ...previous.map((shot) => shot.id)]);
  const freeByCase = new Map<string, string[]>();
  const allocate = (caseId: string) => {
    let pool = freeByCase.get(caseId);
    if (!pool?.length) {
      pool = allocateCaseIds(caseId, rebuilt.length, takenIds);
      freeByCase.set(caseId, pool);
    }
    const id = pool.shift();
    if (id) takenIds.add(id);
    return id;
  };

  return rebuilt.map((shot, index) => {
    const match = patch.get(index);
    const caseId = shot.caseId ?? shot.id.replace(/-\d{2}$/u, "");
    // 配对成功的必须**用回旧编号**（它的图、画面词、媒体任务都挂在上面）。
    //
    // 没配对的则**一律不许沿用旧编号**——哪怕这个号当前没被任何「配对成功」的镜占用。
    // 漏掉这一条会重新制造本层要修的 bug：旧镜 `S2-E1-01` 因为内容变了而没配对上、
    // 回到待确认，它留下的画面词与图片仍按 `S2-E1-01` 索引；此时新镜若顺手沿用
    // 这个号，`page.tsx` 的 `previousPrompts.get(prompt.id)` 就会把那张旧图装到
    // 一镜新内容上——而且因为新镜没配对，`storyboardConfirmed` 是待确认，
    // 界面上看不出任何异常。`takenIds` 里已包含全部旧编号，拿它判即可。
    const keptId = keptIds.get(index);
    let id = keptId ?? shot.id;
    if (!keptId && takenIds.has(id)) id = allocate(caseId) ?? id;
    reservedIds.add(id);
    takenIds.add(id);
    const withId = { ...shot, id, referenceId: id, storyboardConfirmed: false } as T;
    if (!match) {
      return { shot: withId, previousIndex: -1, exact: false, idKept: false };
    }
    const base = carryShotWork(withId, match.source, match.exact, Boolean(options.preserveEdits));
    if (!match.source.image || match.source.status !== "ready") {
      return {
        shot: base,
        previousIndex: match.index,
        exact: match.exact,
        idKept: true,
      };
    }
    return {
      // 保留图片及原始签名；旧数据缺签名时只按旧画面补签，不能按新画面伪造合格章。
      shot: {
        ...base,
        image: match.source.image,
        status: "ready" as const,
        imageSourceSignature: match.source.imageSourceSignature ?? shotVisualSignature(match.source),
      } as T,
      previousIndex: match.index,
      exact: match.exact,
      idKept: true,
    };
  });
}

function carryShotWork<T extends InheritableShot>(
  shot: T,
  source: T,
  allowed: boolean,
  preserveEdits: boolean,
): T {
  if (!allowed) return shot;
  const next: T = { ...shot };
  if (preserveEdits) {
    // 来源未变时保留人工编辑；来源/案例场景发生变化时调用方禁用此分支。
    for (const field of ["speaker", "location", "dialogue", "action", "continuity", "prompt", "estimatedSeconds", "planningNote"] as const) {
      if (source[field] !== undefined) Object.assign(next, { [field]: source[field] });
    }
  }
  for (const field of ["videoSecondsOverride", "videoModel", "speechRateOverride", "confirmedSnapshot"] as const) {
    if (source[field] !== undefined) Object.assign(next, { [field]: source[field] });
  }
  const unchanged = shotVisualSignature(next) === shotVisualSignature(source) && next.dialogue === source.dialogue;
  next.storyboardConfirmed = unchanged && source.storyboardConfirmed === true;
  if (unchanged) {
    for (const field of ["videoLastFrame", "videoLastFrameSignature", "videoPromptPolished"] as const) {
      if (source[field] !== undefined) Object.assign(next, { [field]: source[field] });
    }
  }
  return next;
}

export type StaleableReference = {
  image?: string;
  imageSourceSignature?: string;
  imageNeedsReview?: boolean;
};

export function referenceImageStale(
  shot: ShotDiffFields,
  reference?: StaleableReference,
) {
  return Boolean(
    reference?.image &&
      (reference.imageNeedsReview || (reference.imageSourceSignature &&
      reference.imageSourceSignature !== shotVisualSignature(shot))),
  );
}

export function makeShotConfirmedSnapshot(shot: ShotDiffFields): string {
  return JSON.stringify({
    title: shot.title ?? "",
    speaker: shot.speaker ?? "",
    location: shot.location ?? "",
    continuity: shot.continuity ?? "",
    action: shot.action ?? [],
    dialogue: shot.dialogue ?? "",
    estimatedSeconds: shot.estimatedSeconds ?? null,
    videoSecondsOverride: shot.videoSecondsOverride ?? null,
    videoModel: shot.videoModel ?? "",
    speechRateOverride: shot.speechRateOverride ?? null,
  });
}

const SHOT_FIELD_LABELS: Array<{ key: string; label: string }> = [
  { key: "title", label: "标题" },
  { key: "speaker", label: "人物" },
  { key: "location", label: "场景" },
  { key: "continuity", label: "衔接" },
  { key: "action", label: "动作" },
  { key: "dialogue", label: "对白" },
  { key: "estimatedSeconds", label: "预计时长" },
  { key: "videoSecondsOverride", label: "视频时长" },
  { key: "videoModel", label: "视频模型" },
  { key: "speechRateOverride", label: "口播节奏" },
];

/** 列出「上次确认之后被改过的字段」；从未确认过（无快照）返回空数组。 */
export function shotConfirmedChanges(shot: ShotDiffFields & { confirmedSnapshot?: string }): string[] {
  if (!shot.confirmedSnapshot) return [];
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(shot.confirmedSnapshot) as Record<string, unknown>;
  } catch {
    return [];
  }
  const current: Record<string, unknown> = {
    title: shot.title ?? "",
    speaker: shot.speaker ?? "",
    location: shot.location ?? "",
    continuity: shot.continuity ?? "",
    action: shot.action ?? [],
    dialogue: shot.dialogue ?? "",
    estimatedSeconds: shot.estimatedSeconds ?? null,
    videoSecondsOverride: shot.videoSecondsOverride ?? null,
    videoModel: shot.videoModel ?? "",
    speechRateOverride: shot.speechRateOverride ?? null,
  };
  return SHOT_FIELD_LABELS
    .filter(({ key }) => JSON.stringify(snapshot[key]) !== JSON.stringify(current[key]))
    .map(({ label }) => label);
}

/**
 * 判断账号的剩余视频额度是否装得下本次时长。
 *
 * 2026-09-16：额度是「秒」而不是「次数」，豆包免费账号每天约 50 秒（10 个 5 秒单位）。
 * 所以剩 5 秒的账号做不了 15 秒镜头，但做得了 5 秒镜头——跳过时要按这次时长判断，
 * 不能因为账号「没剩多少了」就整个不用它。
 * 额度未知（老数据/未上报）时一律放行，别把可用账号误判成不可用。
 */
export function providerAccountQuotaAllows(account: ProviderAccount, requiredSeconds = 0) {
  if (account.quotaBalance === 0) return false;
  const need = Math.max(0, Math.round(requiredSeconds));
  if (!need) return true;
  const remaining = account.videoQuotaRemainingSeconds;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return true;
  return remaining >= need;
}

export function chooseProviderAccount(
  accounts: ProviderAccount[],
  jobs: SchedulableJob[],
  requiredSeconds = 0,
) {
  const eligible = accounts.filter(
    (account) =>
      account.enabled &&
      account.loginStatus === "logged_in" &&
      providerAccountQuotaAllows(account, requiredSeconds),
  );
  const pendingStatuses = new Set<MediaJobStatus>(["queued", "running"]);

  return eligible
    .map((account, index) => {
      const assigned = jobs.filter((job) => job.accountId === account.id);
      const pending = assigned.filter((job) => pendingStatuses.has(job.status)).length;
      const lastAssignedAt = assigned.reduce(
        (latest, job) => Math.max(latest, Date.parse(job.createdAt) || 0),
        0,
      );
      return { account, index, pending, lastAssignedAt };
    })
    .sort(
      (left, right) =>
        left.pending - right.pending ||
        left.lastAssignedAt - right.lastAssignedAt ||
        left.index - right.index,
    )[0]?.account;
}

export function candidateMatchesSelectedImage(
  job: Pick<MediaJob, "id">,
  candidate: Pick<MediaCandidate, "id" | "fileName">,
  mediaSource?: SelectedMediaSource,
  legacySourceName?: string,
) {
  if (mediaSource) {
    return mediaSource.jobId === job.id && mediaSource.candidateId === candidate.id;
  }
  return legacySourceName === `豆包候选 · ${candidate.fileName || candidate.id}`;
}

export function imageRetrySourcePrompt(prompt: string) {
  return prompt
    .replace(/\n针对上一轮候选的重试修正，必须优先遵守：[\s\S]*$/u, "")
    .replace(/\n本次已上传上一镜[^\n]+$/u, "")
    .trim();
}

export function normalizeImageRetryPrompt(value: unknown) {
  if (!isRecord(value)) throw new Error("文本模型没有返回重写后的画面词");
  const prompt = imageRetrySourcePrompt(text(value.prompt)).slice(0, 4_000);
  if (/(?:用户反馈|退回意见|失败图片|视觉模型|识别结果|上一轮候选)/u.test(prompt)) {
    throw new Error("重写画面词混入了内部分析说明");
  }
  if (prompt.length < 40) throw new Error("文本模型返回的重写画面词过短");
  return prompt;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function upstreamProviderFailure(
  value: unknown,
  fallbackMessage = "豆包媒体生成失败",
) {
  const failure = isRecord(value) ? value : {};
  const status = Number(failure.http_status);
  return {
    message: text(failure.error_message) || fallbackMessage,
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    code: text(failure.error_code) || "MEDIA_PROVIDER_FAILED",
  };
}

export function normalizeProviderBaseUrl(value: string) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Provider 地址必须是无账号密码的 HTTP(S) 地址");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("本地版本只允许连接本机 Provider（127.0.0.1 或 localhost）");
  }
  return url.toString().replace(/\/$/u, "");
}

export function safeProjectSegment(value: string) {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/[. ]+$/u, "")
    .slice(0, 120);
  if (!safe || safe === ".") throw new Error("项目名称不能用于创建素材目录");
  return safe;
}

export function normalizeVisionReview(value: unknown): VisionReview {
  if (!isRecord(value)) throw new Error("视觉审核结果无效");
  const status = text(value.status).toUpperCase();
  if (!["PASS", "REVISE", "BLOCKED", "ERROR"].includes(status)) {
    throw new Error("视觉审核状态无效");
  }
  return {
    status: status as VisionReviewStatus,
    issueTags: Array.isArray(value.issueTags)
      ? value.issueTags
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    evidence: text(value.evidence).trim().slice(0, 1600),
    retrySuggestion: text(value.retrySuggestion).trim().slice(0, 1600),
    model: text(value.model).trim().slice(0, 160),
    createdAt: text(value.createdAt) || new Date().toISOString(),
  };
}

/**
 * 这些失败码意味着“豆包侧可能已经生成并消耗额度”，重新提交前必须先核对豆包历史。
 * 页面据此把按钮从“重新生成”改成“核对后再生成”，并在提交前二次确认。
 */
export const PROVIDER_HISTORY_CHECK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ARTIFACT_NOT_AVAILABLE",
  "GENERATION_TIMEOUT",
  "SUBMISSION_UNCERTAIN",
  // 参数确认消息可能已被豆包接收，但页面没有进入生成；不能直接盲目重提交。
  "VIDEO_CONFIRM_NOT_TAKEN",
  "PROVIDER_STATUS_UNREACHABLE",
  "PROVIDER_RESTARTED_DURING_JOB",
  "LOCAL_PROVIDER_RESTARTED",
]);

export function needsProviderHistoryCheck(errorCode?: string) {
  return Boolean(errorCode && PROVIDER_HISTORY_CHECK_ERROR_CODES.has(errorCode));
}

const ARTIFACT_NOT_AVAILABLE_PATTERN =
  /豆包任务已提交，但没有取得可验证的媒体文件/u;
/** 本地 Provider 链路中断（超时、连接被拒、socket 断开），不代表豆包侧没有提交。 */
const TRANSPORT_FAILURE_PATTERN =
  /(?:aborted|aborterror|fetch failed|econnrefused|econnreset|socket hang up|epipe|und_err|terminated|network)/iu;
const UNREACHABLE_MESSAGE =
  "本地 Provider 在任务进行中失去响应，任务是否已在豆包生成尚不确定；请先到豆包历史记录核对，再决定是否重新生成";

function normalizeJobFailure(storedErrorCode: string, rawMessage: string) {
  // 已被 Provider 明确标注的失败码原样保留，不做二次推断。
  if (storedErrorCode && storedErrorCode !== "MEDIA_JOB_FAILED") {
    return { errorCode: storedErrorCode, errorMessage: rawMessage };
  }
  if (ARTIFACT_NOT_AVAILABLE_PATTERN.test(rawMessage)) {
    return { errorCode: "ARTIFACT_NOT_AVAILABLE", errorMessage: rawMessage };
  }
  if (TRANSPORT_FAILURE_PATTERN.test(rawMessage)) {
    return { errorCode: "PROVIDER_STATUS_UNREACHABLE", errorMessage: UNREACHABLE_MESSAGE };
  }
  return { errorCode: storedErrorCode, errorMessage: rawMessage };
}

export function normalizeMediaJob(value: unknown): MediaJob {
  if (!isRecord(value)) throw new Error("媒体任务无效");
  const mediaType = text(value.mediaType);
  const status = text(value.status);
  const { errorCode, errorMessage } = normalizeJobFailure(
    text(value.errorCode),
    text(value.errorMessage),
  );
  if (!["image", "video"].includes(mediaType)) throw new Error("媒体任务类型无效");
  if (!["queued", "running", "waiting_user", "succeeded", "failed", "cancelled"].includes(status)) {
    throw new Error("媒体任务状态无效");
  }
  return {
    id: text(value.id),
    projectId: text(value.projectId),
    projectTitle: text(value.projectTitle),
    targetId: text(value.targetId),
    targetLabel: text(value.targetLabel) || undefined,
    mediaType: mediaType as MediaType,
    accountId: text(value.accountId),
    promptSnapshot: text(value.promptSnapshot),
    status: status as MediaJobStatus,
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    startedAt: text(value.startedAt) || undefined,
    finishedAt: text(value.finishedAt) || undefined,
    errorCode: errorCode || undefined,
    errorMessage: errorMessage || undefined,
    upstreamJobId: text(value.upstreamJobId) || undefined,
    providerMessage: text(value.providerMessage) || undefined,
    quotaText: text(value.quotaText) || undefined,
    retryOfJobId: text(value.retryOfJobId) || undefined,
    candidates: Array.isArray(value.candidates)
      ? value.candidates.filter(isRecord).map((candidate) => ({
          id: text(candidate.id),
          fileName: text(candidate.fileName),
          mimeType: text(candidate.mimeType) || "application/octet-stream",
          previewUrl: text(candidate.previewUrl),
          status: ["pending", "adopted", "rejected", "kept"].includes(text(candidate.status))
            ? (candidate.status as MediaCandidateStatus)
            : "pending",
          error: text(candidate.error) || undefined,
          rejectionReason: text(candidate.rejectionReason) || undefined,
          actualDurationSeconds:
            typeof candidate.actualDurationSeconds === "number" && Number.isFinite(candidate.actualDurationSeconds)
              ? candidate.actualDurationSeconds
              : undefined,
          visionReview: candidate.visionReview
            ? normalizeVisionReview(candidate.visionReview)
            : undefined,
        }))
      : [],
  };
}
