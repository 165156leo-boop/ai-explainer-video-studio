import type {
  ExtractedCase,
  ExtractedCaseItem,
  ImagePromptPackage,
  ScriptParagraph,
  Shot,
} from "./workbench-data";
import { cleanImagePromptAction, dedupeVisualSegments } from "./image-prompt.ts";
import { shotDisplayLabel } from "./media-workflow.ts";

export const MAX_SHOT_SECONDS = 15;
export const TARGET_SHOT_SECONDS = 10;
export const MIN_SHOT_SECONDS = 4;
/**
 * 对白语速基线（字/秒）。2026-09-16 由 6 调到 5；2026-09-24 用户拍板全局对齐 5.5。
 *
 * 6 相当于 360 字/分钟，比新闻播报还快，导致时长估算偏乐观：77 字被算成约 13 秒，
 * 结果模型只能前段抢速念完、后段用 4—5 秒空白补足（用户实测反馈）。
 * 5 相当于 300 字/分钟（接近播报速度）；5.5 = 330 字/分钟——「第5期」项目在
 * 5 基线上按真实成片节奏校准后上调（2026-09-19），现推广为全局默认基线。
 * 参考区间：日常对话 200—240 字/分钟（3.3—4 字/秒）。
 */
export const SPEECH_UNITS_PER_SECOND = 5.5;
export const MIN_SPEECH_RATE = 3;
export const MAX_SPEECH_RATE = 9;
/**
 * 动作/画面节奏（2026-10-07，Layer 3）。
 *
 * 旧模型只有「对白朗读时长」一个量：纯画面镜恒为 0 秒（用户实测三个开场镜
 * 全是 0），而动作时间完全不进预估——用户反馈「你预估语速的时候，要把动作时间
 * 也算上」。这里补上第二个量：**动作表演时长**。
 *
 * 依据是「动作节拍」而不是字数——人做动作比说话慢，且一个动作短语（「把平板
 * 递过去」）不论几个字都占掉相近的时间。节拍按逗号/顿号/句号切分，每个节拍约 1.2 秒。
 *
 * 纯画面镜的取值区间是 4—4.5 秒，两头各有一条硬理由：
 * - 下限贴 `MIN_SHOT_SECONDS`（4 秒）。初稿写的是 2.5 秒，实测立刻被自己的下限
 *   检查标红（`S2-E1-01 2.5s ⚠低于下限`）——一个刻意设计的时长不该触发告警。
 * - 上限必须**严格小于 5**：`videoDurationBucket` 取的是「大于估算值的最小档」，
 *   到 5.0 就跳进 10 秒档，一个只有动作没有台词的镜头占掉 10 秒纯属浪费额度。
 */
export const SECONDS_PER_ACTION_BEAT = 1.2;
export const MIN_VISUAL_SECONDS = 4;
export const MAX_VISUAL_SECONDS = 4.5;

export type ShotSplitOption = {
  key: string;
  label: string;
  beforeSeconds: number;
  afterSeconds: number;
};

/**
 * `dialogueAction()` 合成的口播意向串（「小陈对王老师说明核查发现」）。
 *
 * 它不含任何可见画面信息，只说明「谁对谁表达了什么意图」——生图模型照着画，
 * 画出来的仍然是两个人站着说话。因此它**不能**进连续性动作（`本镜变化`），
 * 否则每一镜的增量描述都是一句废话。它只在没有真实动作可写时兜底。
 */
const SPOKEN_INTENT_ACTION_RE =
  /(?:进行说明|说明核查发现|提出询问|回应并说明原因|开口说话)$/u;

export function continuityVisualActions(shot: Shot, location: string) {
  // 2026-10-07：真实动作有三个来源，缺一不可——
  // ① 非对白来源行（原文的画面/动作描述）；
  // ② 对白条目上的 `performance_cue`（对白标签里被剥出的现场提示，
  //    如「王老师一愣」「小李走进来，把平板递过去」）。旧代码把对白条目整个
  //    filter 掉（`item.type !== "dialogue"`），于是这条唯一的真实动作永远读不到，
  //    S1-E1-02 只能凑出空数组、被 normalizeVideoPromptBriefs 硬拒收；
  // ③ 分镜动作里非合成、非意向串的部分。
  const sourceActions = (shot.sourceItems ?? [])
    .flatMap((item) => (
      item.type === "dialogue"
        ? [item.performance_cue ? cueAction(item) : ""]
        : [visualSourceAction(item)]
    ))
    .map((text) => cleanImagePromptAction(text))
    .filter(Boolean);
  const fallbackActions = shot.action
    .map(cleanImagePromptAction)
    .filter(Boolean)
    .filter((action) => !SPOKEN_INTENT_ACTION_RE.test(action));
  return dedupeVisualSegments(location, [...sourceActions, ...fallbackActions])
    .map((action) => action.replace(/[。．.]+$/u, ""));
}

export function buildImagePrompts(items: Shot[]): ImagePromptPackage[] {
  return items.map((shot) => {
    // 2026-09-18 修掉三个模板缺陷（用户实测反馈「提示词冗余、重点混乱」）：
    // ① location 也要过清洗——分镜里常有「场景设定：」这类字段标签，和「…分别标注：」
    //    这种以冒号收尾却没有内容的残缺句；旧代码只清洗 action，location 原样进提示词。
    // ② location 与 action[0] 在真实分镜里经常是同一句话（例如加班餐 S1-E1-01），
    //    旧模板会把同一句拼两遍；现在按去标点骨架去重。
    // ③ 每条片段先剥掉自己的句末标点再拼，避免出现「存疑。。」这种双句号。
    const location = cleanImagePromptAction(shot.location).replace(/[。．.]+$/u, "");
    const visualActions = dedupeVisualSegments(
      location,
      shot.action.map(cleanImagePromptAction).filter(Boolean),
    ).map((action) => action.replace(/[。．.]+$/u, ""));
    // 2026-09-17 生图逻辑改版（用户决策 + 开源准则调研）：
    // 有上一镜已选图时只传上一镜一张参考图——上一镜图已是「风格图+人物图」的成品实例，
    // 再传抽象风格图/人物图等于给模型两个风格来源（Seedream 官方指南：多参考必须分工、
    // 堆砌致冲突信号；实测三方参考导致「与上一镜环境差距大」）。
    // 提示词改为「延续什么 + 本镜变什么」的增量结构；长链画风漂移由逐镜人工验收兜底
    // （gen_video 的累积全帧用于全自动流水线，工作台每一镜都有审片闸门）。
    const continuityShot = findContinuityReferenceShot(items, shot.id);
    const visualBody = visualActions.length
      ? `${location}。画面呈现：${visualActions.join("；")}。`
      : `${location}。`;
    const continuityActions = continuityVisualActions(shot, location);
    const continuityBody = continuityActions.length
      ? `本镜变化：${continuityActions.join("；")}。`
      : "本镜变化：只表现相对上一镜的新增变化，不重复参考图中已经存在的场景、人物位置和动作。";
    // 2026-09-18 用户决策：尾部否定约束只留一条。
    // 旧句「不要字幕、姓名标签、提示框、无关人物或大段可读文字。」四类否定堆在一起，
    // 既是权重稀释，又和主体里的正向描述打架（主体写「红色框圈出关键内容」、
    // 尾部写「不要提示框」），生图模型只能猜哪个算数——这正是「重点混乱」的来源之一。
    const guard =
      "人物数量、身份和空间关系严格遵循当前分镜，首帧人物自然闭嘴、嘴部无遮挡；画面中不要出现额外的文字信息与提示框。";
    const auditorLock = /审计(?:人员|员)\s*A/u.test(shot.speaker) && !continuityShot
      ? "审计员A的眼镜、发型、脸型和服装严格参考上传的人物图；只参考人物外观，不复制参考图的背景、姿态和构图。"
      : "";
    return {
      id: shot.id,
      title: shot.title,
      status: "missing" as const,
      prompt: continuityShot
        ? `16:9 横屏。参考图为上一镜 ${shotDisplayLabel(items, continuityShot.id)} 的已选画面：画风、人物外观与服装、场景环境严格以它为准，不另立风格；构图与动作按本镜分镜执行。\n` +
          `${continuityBody}` +
          guard +
          `\n连续性保持：${shot.continuity}`
        : "16:9 横屏，采用已上传风格图的MG插画风格。参考图仅作画风与人物画法示范：只参考它的线条、配色、人物五官比例与上色方式；图中人物不得作为本镜角色出场，其服装、发型、站位与场景布局一律不作参考。桌面上不得出现姓名牌、桌牌或任何带文字的物品；墙面文件与海报只画色块示意，不画文字线条。\n" +
          visualBody +
          guard +
          `\n连续性保持：${shot.continuity}` +
          (auditorLock ? `\n${auditorLock}` : ""),
    };
  });
}

export function findContinuityReferenceShot(items: Shot[], shotId: string) {
  const index = items.findIndex((shot) => shot.id === shotId);
  if (index < 0) return undefined;
  const shot = items[index];
  const previous = items[index - 1];
  const sameCase = previous && previous.caseId === shot.caseId;

  if (/不(?:再)?沿用上一镜|无需(?:参考|沿用)上一镜|独立开场/u.test(shot.continuity)) {
    return undefined;
  }
  if (sameCase && /上一镜|上一分镜|接续/u.test(shot.continuity)) {
    return previous;
  }
  // 2026-10-08：`continuity` 里的显式编号是**存量文本**，不重写。它可能是内部键
  // （`S1-E1-04`，连字符），也可能是规划器写的字面量 `${案例号}-01`／`${案例号}_01`，
  // 而后者现在同时是「本案例第一镜」的对外展示编号。分隔符两种都要认（`[-_]`）：
  // 存量数据全是连字符，只认下划线会让这一段之外的显式编号全部失配。两种写法都要能
  // 落到同一镜：先按 `shot.id` 精确匹配（保住原有语义，含 9f26b266 里
  // `S2-E2-01 → S2-E2-02` 那种前向引用），再按展示编号匹配。两边都落不到时仍返回
  // undefined——这是改动前的行为，不能因为多了一次回退就把「解析不到」悄悄变成
  // 「就用上一镜」。
  const explicitId = shot.continuity.match(/S\d+-E\d+[-_]\d+/u)?.[0];
  if (explicitId && explicitId !== shot.id) {
    // 展示编号回退要认**两种分隔符**，理由和上面一样：展示编号现在是 `S8-E1_01`，
    // 而存量正文里写的是旧字面量 `S8-E1-01`。存量文本不重写，就不能让它断链——
    // 两种写法在这里指同一件事（本案例第一镜）。走到这一步时已经确认
    // `explicitId` 不是任何现存 `shot.id`（第一路落空），所以不存在歧义。
    const displayForms = new Set([explicitId, explicitId.replace(/[-_](\d+)$/u, "_$1")]);
    return (
      items.find((candidate) => candidate.id === explicitId) ??
      // 回退要排除本镜自己：只剩一镜的案例里，本镜的展示编号恰好也是
      // `S1-E1_01`，不排掉就会解析成「参考自己」。
      items.find(
        (candidate) =>
          candidate.id !== shot.id && displayForms.has(shotDisplayLabel(items, candidate.id)),
      )
    );
  }
  return sameCase && /延续|连续性参考|结尾截图/u.test(shot.continuity)
    ? previous
    : undefined;
}

/** 从台词中挑选信息密度最高的一句（有数字、具体道具、适中长度优先）。 */
function pickCoreDialogueLine(dialogue: string): string {
  const lines = dialogue
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^本镜无人物对白/u.test(line));
  if (lines.length === 0) return "";

  const scored = lines.map((line) => {
    const clean = splitDialogueVisualNote(
      line.replace(/^[^：:\n]{1,28}[：:]\s*/u, ""),
    ).spokenText.trim();
    let score = 0;
    if (/\d/u.test(clean)) score += 3;
    if (/处理笺|报销单|凭证|清单|发票|合同|账目|费用|金额/u.test(clean)) score += 2;
    if (clean.length > 15 && clean.length < 120) score += 1;
    return { clean, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.clean ?? "";
}

/**
 * 为分镜生成一句可读的核心摘要，用于画面词预览面板快速识别镜头内容。
 * 优先从台词里提取具体事实（数字、矛盾、对象）；台词空泛时回退到动作链。
 */
export function summarizeShot(shot: Shot): string {
  const coreLine = pickCoreDialogueLine(shot.dialogue);
  if (coreLine) {
    return coreLine.length > 110 ? `${coreLine.slice(0, 110)}…` : coreLine;
  }

  const location = shot.location
    .replace(/^[^，。；\n]{0,6}(?:场景设定|地点设定|场景|地点)[：:]\s*/u, "")
    .replace(/[。．.\s]+$/u, "");
  const action = shot.action.filter(Boolean).join("；");
  const summary = [location, action].filter(Boolean).join("，");
  return summary.length > 110 ? `${summary.slice(0, 110)}…` : summary;
}

export function splitDialogueVisualNote(text: string) {
  let spokenText = text.trim();
  if (
    (spokenText.startsWith("“") && spokenText.endsWith("”")) ||
    (spokenText.startsWith('"') && spokenText.endsWith('"'))
  ) {
    spokenText = spokenText.slice(1, -1).trim();
  }

  const notes: string[] = [];
  let match = /[（(]([^（）()]*)[）)]\s*$/u.exec(spokenText);
  while (match) {
    notes.unshift(match[1].trim());
    spokenText = spokenText.slice(0, match.index).trimEnd();
    match = /[（(]([^（）()]*)[）)]\s*$/u.exec(spokenText);
  }
  return { spokenText, visualText: notes.filter(Boolean).join("；") };
}

export function normalizeSpeechRate(value: number) {
  if (!Number.isFinite(value)) return SPEECH_UNITS_PER_SECOND;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, value));
}

export function estimateSpeechSeconds(
  text: string,
  speechRate = SPEECH_UNITS_PER_SECOND,
) {
  const { spokenText } = splitDialogueVisualNote(text);
  const spokenUnits = countSpeechUnits(spokenText);
  return Math.round(
    Math.max(2, spokenUnits / normalizeSpeechRate(speechRate)) * 10,
  ) / 10;
}

function countSpeechUnits(text: string) {
  return (text.match(/[\u4e00-\u9fffA-Za-z0-9]/gu) ?? []).length;
}

function estimatePlanningSeconds(text: string) {
  return Math.round(
    (countSpeechUnits(splitDialogueVisualNote(text).spokenText) /
      SPEECH_UNITS_PER_SECOND) * 10,
  ) / 10;
}

export function speechRateLabel(speechRate: number) {
  if (speechRate <= 5) return "舒缓";
  if (speechRate >= 7) return "紧凑";
  return "标准";
}

function dialogueBlockText(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/^[^：:\n]{1,28}[：:]\s*/u, "")
        .replace(/^[“"]|[”"]$/gu, "")
        .trim(),
    )
    .filter((line) => line && !/^本镜无人物对白/u.test(line))
    .join("");
}

export function recalculateShotTiming(shot: Shot, projectSpeechRate: number) {
  const speechRate = normalizeSpeechRate(
    shot.speechRateOverride ?? projectSpeechRate,
  );
  const spokenText = dialogueBlockText(shot.dialogue);
  // 2026-10-07（Layer 3）：无对白不再等于 0 秒。
  // 三个开场镜（S1-E1-01 / S2-E1-01 / S3-E1-01）此前全是 0 秒，而它们恰恰是
  // 交代「处理笺怎么被调出来」「小李怎么走进来」的镜头——0 秒在豆包侧会掉进
  // 最小档、在界面里也看不出这一镜需要多少时间。现在按可见动作节拍估 4—4.5 秒。
  const estimatedSeconds = spokenText
    ? estimateSpeechSeconds(spokenText, speechRate)
    : visualOnlySecondsForShot(shot);
  return {
    ...shot,
    estimatedSeconds,
    planningNote: spokenText
      ? estimatedSeconds > MAX_SHOT_SECONDS
        ? `按${speechRateLabel(speechRate)}节奏估算约 ${estimatedSeconds} 秒，超过单镜 15 秒目标，请检查拆分点。`
        : `按${speechRateLabel(speechRate)}节奏估算约 ${estimatedSeconds} 秒。`
      : `本镜无人物对白，按画面动作节奏估算约 ${estimatedSeconds} 秒。`,
  };
}

export function recalculateShotTimings(
  shots: Shot[],
  projectSpeechRate: number,
) {
  return shots.map((shot) => recalculateShotTiming(shot, projectSpeechRate));
}

export function reorderActions(
  actions: string[],
  fromIndex: number,
  toIndex: number,
) {
  const next = [...actions];
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= next.length ||
    toIndex >= next.length
  ) {
    return next;
  }
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function trimText(text: string, length = 44) {
  const clean = text
    .replace(/^(?:画面|镜头|场景|配图)[：:]\s*/u, "")
    .replace(/^[-—>\s]+/u, "")
    .trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

function dialogueSeconds(
  item: ExtractedCaseItem,
  speechRate = SPEECH_UNITS_PER_SECOND,
) {
  const baseline = item.estimatedSeconds || estimateSpeechSeconds(item.text);
  return Math.round(
    baseline * (SPEECH_UNITS_PER_SECOND / normalizeSpeechRate(speechRate)) * 10,
  ) / 10;
}

/**
 * 动作节拍数（Layer 3）：按逗号/顿号/分号/句号切出的动作片段个数。
 *
 * 用节拍而不是字数，是因为动作与字数不成正比——「把平板递过去」六个字占的时间
 * 和「站在门口笑着打招呼」十个字差不多，都约等于一个节拍。这样同一句话无论
 * 怎么改标点，估算都不会跳变。
 */
function actionBeats(text: string) {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/[，,、；;。]/u).map((part) => part.trim()).filter(Boolean).length || 1;
}

/**
 * 本镜**可见动作**的表演时长。
 *
 * 只取三类来源，避免把「谁对谁说明发现」这类口播意向串算成动作时间：
 * ① 对白条目上的 `performance_cue`（旧提取器丢掉的现场提示，Layer 0 找回来的）；
 * ② 非对白且非元数据的来源行，经 `visualSourceAction` 归一（场景行只取动作子句）；
 * ③ 没有 `sourceItems` 的历史数据，退回分镜自己的动作链。
 */
function performanceSecondsOf(items: ExtractedCaseItem[]) {
  const texts = items.flatMap((item) =>
    item.type === "dialogue"
      ? item.performance_cue
        ? [item.performance_cue]
        : []
      : [visualSourceAction(item)],
  );
  const beats = texts.reduce((sum, text) => sum + actionBeats(text), 0);
  return Math.round(beats * SECONDS_PER_ACTION_BEAT * 10) / 10;
}

/**
 * 纯画面镜的时长（Layer 3）：无对白时不再恒为 0。
 *
 * 用户实测反馈：`S1-E1-01`、`S2-E1-01`、`S3-E1-01` 三个开场镜时长都是 0 秒，
 * 而它们恰恰是最需要交代「接待结算怎么被查出来」「小李怎么走进来」的镜头。
 * 现在按动作节拍在 `MIN_VISUAL_SECONDS`—`MAX_VISUAL_SECONDS` 之间取值，
 * 稳定落在豆包 5 秒档。
 */
function visualOnlySeconds(items: ExtractedCaseItem[]) {
  const raw = performanceSecondsOf(items);
  return Math.min(
    MAX_VISUAL_SECONDS,
    Math.max(MIN_VISUAL_SECONDS, Math.round(raw * 10) / 10),
  );
}

/**
 * 一镜的实际时长（Layer 3）：对白朗读与动作表演**同时发生**，取较长者。
 *
 * 用户原话「你预估语速的时候，要把动作时间也算上」。不取两者之和，是因为
 * 一个镜头里人一边说话一边做手势是常态——相加会把 14 秒的对白镜推到 17 秒，
 * 触发不必要的拆镜。取 max 既能把纯画面镜从 0 秒救回来，又不会无故放大对白镜。
 */
function shotSeconds(
  items: ExtractedCaseItem[],
  speechRate = SPEECH_UNITS_PER_SECOND,
) {
  const voice = itemsSeconds(items, speechRate);
  if (!voice) return visualOnlySeconds(items);
  return Math.round(Math.max(voice, performanceSecondsOf(items)) * 10) / 10;
}

/**
 * 没有 `sourceItems` 的历史分镜（老数据）退化路径：只能拿分镜自己的动作链估节拍。
 * 对白镜不走这里——它们由 `recalculateShotTiming` 用台词时长覆盖。
 */
function visualOnlySecondsForShot(shot: Shot) {
  const items = shot.sourceItems ?? [];
  if (items.length) return visualOnlySeconds(items);
  const beats = (shot.action ?? []).reduce(
    (sum, action) => sum + actionBeats(action),
    0,
  );
  return Math.min(
    MAX_VISUAL_SECONDS,
    Math.max(MIN_VISUAL_SECONDS, Math.round(beats * SECONDS_PER_ACTION_BEAT * 10) / 10),
  );
}

function splitNaturalParts(text: string) {
  return (
    text.match(/[^。！？!?；;，,]+[。！？!?；;，,]?/gu)?.map((part) => part.trim()) ??
    [text]
  ).filter(Boolean);
}

function splitDialogueForPlanning(item: ExtractedCaseItem) {
  if (dialogueSeconds(item) <= TARGET_SHOT_SECONDS) return [item];
  const parts = splitNaturalParts(item.text);
  if (parts.length < 2) return [item];
  return parts.map((text, index) => ({
    ...item,
    text,
    sceneHint: index === 0 ? item.sceneHint : undefined,
    estimatedSeconds: estimatePlanningSeconds(text),
  }));
}

type PlanningUnit = {
  items: ExtractedCaseItem[];
  seconds: number;
};

function planningUnits(items: ExtractedCaseItem[]) {
  const units: PlanningUnit[] = [];
  let pending: ExtractedCaseItem[] = [];
  for (const item of items) {
    if (item.type !== "dialogue") {
      pending.push(item);
      continue;
    }
    units.push({
      items: [...pending, item],
      seconds: dialogueSeconds(item),
    });
    pending = [];
  }
  if (pending.length) {
    if (units.length) units[units.length - 1].items.push(...pending);
    else units.push({ items: pending, seconds: 0 });
  }
  return units;
}

function dialogueAtEdge(unit: PlanningUnit | undefined, fromEnd: boolean) {
  if (!unit) return undefined;
  const rows = fromEnd ? [...unit.items].reverse() : unit.items;
  return rows.find((item) => item.type === "dialogue");
}

function boundaryPenalty(left: PlanningUnit, right: PlanningUnit | undefined) {
  const leftDialogue = dialogueAtEdge(left, true);
  const rightDialogue = dialogueAtEdge(right, false);
  if (!leftDialogue || !rightDialogue) return 0;
  if (
    leftDialogue.sourceId !== rightDialogue.sourceId ||
    leftDialogue.sourceSegment !== rightDialogue.sourceSegment ||
    leftDialogue.speaker !== rightDialogue.speaker
  ) {
    return 0;
  }
  return /[，,]$/u.test(leftDialogue.text) ? 18 : 4;
}

function shotDurationPenalty(seconds: number) {
  if (seconds > MAX_SHOT_SECONDS) return 10_000 + seconds * 100;
  if (seconds < MIN_SHOT_SECONDS) {
    return 120 + (MIN_SHOT_SECONDS - seconds) * 30;
  }
  return seconds > TARGET_SHOT_SECONDS
    ? (seconds - TARGET_SHOT_SECONDS) * 0.5
    : (TARGET_SHOT_SECONDS - seconds) * 0.15;
}

function mergeAdjacentDialogueParts(items: ExtractedCaseItem[]) {
  const merged: ExtractedCaseItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (
      previous?.type === "dialogue" &&
      item.type === "dialogue" &&
      previous.sourceId === item.sourceId &&
      previous.sourceSegment === item.sourceSegment &&
      previous.speaker === item.speaker
    ) {
      previous.text += item.text;
      previous.estimatedSeconds = Math.round(
        (previous.estimatedSeconds + item.estimatedSeconds) * 10,
      ) / 10;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function optimizePlanningBlock(items: ExtractedCaseItem[]) {
  const units = planningUnits(items);
  if (!units.length) return [];
  const plans: Array<{ cost: number; chunks: ExtractedCaseItem[][] } | undefined> =
    new Array(units.length + 1);
  plans[units.length] = { cost: 0, chunks: [] };

  for (let start = units.length - 1; start >= 0; start -= 1) {
    let seconds = 0;
    for (let end = start; end < units.length; end += 1) {
      seconds = Math.round((seconds + units[end].seconds) * 10) / 10;
      const indivisibleOverrun = start === end && seconds > MAX_SHOT_SECONDS;
      if (seconds > MAX_SHOT_SECONDS && !indivisibleOverrun) break;
      const remainder = plans[end + 1];
      if (!remainder) continue;
      const cost =
        1_000 +
        shotDurationPenalty(seconds) +
        boundaryPenalty(units[end], units[end + 1]) +
        remainder.cost;
      if (!plans[start] || cost < plans[start]!.cost) {
        plans[start] = {
          cost,
          chunks: [
            mergeAdjacentDialogueParts(
              units.slice(start, end + 1).flatMap((unit) => unit.items),
            ),
            ...remainder.chunks,
          ],
        };
      }
      if (indivisibleOverrun) break;
    }
  }
  return plans[0]?.chunks ?? [items];
}

function fallbackItems(
  item: ExtractedCase,
  paragraphs: ScriptParagraph[],
): ExtractedCaseItem[] {
  return paragraphs
    .filter(
      (paragraph) =>
        item.sourceIds.includes(paragraph.id) &&
        (paragraph.kind === "dialogue" ||
          ((paragraph.kind === "note" || paragraph.kind === "action") &&
            // 场景/画面描述要参与分镜规划；音效、字幕、旁白和审计提醒仍属于后期或上下文。
            !/^(?:音效|字幕|旁白|审计提醒|固定结尾)[：:]/u.test(paragraph.text.trim()))),
    )
    .map((paragraph) => {
      if (paragraph.kind !== "dialogue") {
        return {
          sourceId: paragraph.id,
          type: "visual_direction",
          text: paragraph.text,
          estimatedSeconds: 0,
        };
      }
      const [speaker = "待确认人物", ...content] = paragraph.text.split(/[:：]/u);
      const text = content.join("：").trim() || paragraph.text;
      return {
        sourceId: paragraph.id,
        type: "dialogue",
        speaker: speaker.trim(),
        text,
        estimatedSeconds: estimateSpeechSeconds(text),
      };
    });
}

function hasDialogue(items: ExtractedCaseItem[]) {
  return items.some((item) => item.type === "dialogue");
}

/**
 * 判定落点（Layer 2 替换掉旧的 `isStandaloneVisualDescription`）。
 *
 * 只有 `visual_beat` 独立成镜；`scene_context`（纯场景行）与 `noise`（空标签行）
 * 既不独立成镜，也不贡献动作——它们的信息已经在 `location` 里。
 */
function isVisualBeat(item: ExtractedCaseItem) {
  return item.type !== "dialogue" && classifyVisualSource(item) === "visual_beat";
}

/**
 * 对白镜里被剥出的现场提示（`performance_cue`）**不独立成镜**——这正是用户
 * 「案例一的动作与对白是衔接的，在一个分镜里可以表达」那一条。它由
 * `shotActions` 写进同一镜的动作链，由 `continuityVisualActions` 提供给画面词。
 *
 * 提示本身只有动作（「一愣」「走进来，把平板递过去」），没有主语，而它取自
 * 说话人的标签（「王老师一愣」），所以这里把说话人补回去，让动作链能被人读、
 * 也能被生图模型理解。
 */
export function cueAction(item: ExtractedCaseItem) {
  const cue = (item.performance_cue ?? "").trim();
  if (!cue) return "";
  const speaker = (item.speaker ?? "").trim();
  if (!speaker || speaker === "待确认人物") return cue;
  return cue.startsWith(speaker) ? cue : `${speaker}${cue}`;
}

/**
 * 对白朗读时长（Layer 3 的 `voiceSeconds`）。
 *
 * 2026-10-07 起它不再等于「这一镜的时长」——镜时长改由 `shotSeconds` 合成，
 * 它只负责对白那一半。保留原名是为了不动 `splitOptionsForShot` 的语义：
 * 拆分点选项上显示的「前 / 后」本来就是纯对白时长。
 */
function itemsSeconds(
  items: ExtractedCaseItem[],
  speechRate = SPEECH_UNITS_PER_SECOND,
) {
  return Math.round(
    items
      .filter((item) => item.type === "dialogue")
      .reduce((sum, item) => sum + dialogueSeconds(item, speechRate), 0) * 10,
  ) / 10;
}

export function planCaseChunks(
  item: ExtractedCase,
  paragraphs: ScriptParagraph[] = [],
) {
  const sourceItems = item.items?.length
    ? item.items
    : fallbackItems(item, paragraphs);
  const expanded = sourceItems.flatMap((row) => {
    // 2026-09-19（用户拍板）：特效在规划层兜底排除——即使旧数据把它带进了
    // 案例素材（schema 1.5 时代会标成 action_or_narration 混入），也不许进分镜。
    // 真实事故：「处理笺扫描件浮现在餐桌上方」顺流进画面词，餐桌进了画面。
    if (row.type === "visual_effect") return [];
    if (row.type !== "dialogue") return [row];
    const { spokenText, visualText } = splitDialogueVisualNote(row.text);
    const dialogue = {
      ...row,
      text: spokenText || row.text,
      estimatedSeconds: visualText
        ? estimateSpeechSeconds(spokenText || row.text)
        : row.estimatedSeconds || estimateSpeechSeconds(row.text),
    };
    return [
      ...(visualText
        ? [{
            sourceId: row.sourceId,
            type: "visual_direction",
            text: `画面：${visualText}`,
            estimatedSeconds: 0,
          }]
        : []),
      ...splitDialogueForPlanning(dialogue),
    ];
  });
  const blocks: ExtractedCaseItem[][] = [];
  let current: ExtractedCaseItem[] = [];
  let pendingVisuals: ExtractedCaseItem[] = [];

  const pushCurrent = () => {
    if (!current.length) return;
    blocks.push(current);
    current = [];
  };

  for (const row of expanded) {
    if (row.type !== "dialogue") {
      if (isVisualBeat(row) && hasDialogue(current)) {
        pushCurrent();
      }
      pendingVisuals.push(row);
      continue;
    }

    const sceneChanged = Boolean(
      row.sceneHint &&
        /场景切换|切换为|另一个场景|人员变更为|后来|第二天/u.test(
          row.sceneHint,
        ),
    );
    if (hasDialogue(current) && sceneChanged) {
      pushCurrent();
    }
    if (pendingVisuals.length) {
      if (pendingVisuals.some(isVisualBeat)) {
        blocks.push([...pendingVisuals]);
      } else {
        current.push(...pendingVisuals);
      }
      pendingVisuals = [];
    }
    current.push(row);
  }

  if (pendingVisuals.length) {
    if (pendingVisuals.some(isVisualBeat)) {
      pushCurrent();
      blocks.push([...pendingVisuals]);
    } else if (current.length) {
      current.push(...pendingVisuals);
    } else {
      current = pendingVisuals;
    }
  }
  pushCurrent();

  const chunks = blocks.flatMap(optimizePlanningBlock);

  return chunks.length
    ? chunks
    : [[{
        sourceId: item.sourceIds[0] ?? 0,
        type: "action_or_narration",
        text: "当前案例只有画面信息，需在分镜审查中补充可执行动作。",
        estimatedSeconds: 0,
      }]];
}

/**
 * 2026-09-26：兜底动作链补上「对话对象」（用户实测反馈「画面词粗略、根本没有
 * 对话的内容」——程序模板把对白压成「小陈说明核查发现」这种意图短语，生图模型
 * 既看不出两人在对话，也不知道对话对象必须在画面里出现）。
 *
 * 对象按两条**确定性**规则推断，宁缺毋滥：
 * 1. 台词称呼语：台词以「X老师，…」「X主任，…」式称呼开头——人物对白天然
 *    以称呼开场，这是数据里最可靠的信号。必须满足保守条件防误判：
 *    - 称呼后缀只白名单职务/称谓（老师|主任|经理|…|姐|哥），且整体 ≤6 字；
 *    - 后缀后必须紧跟停顿符或第二人称代词（您|你|他|她|我）——「总之」「院长
 *      批示」「你看情况」这类因此进不来；
 *    - 片段含代词/谓词迹象（我你您他她…的有是在就…）或等于说话人自己时拒收。
 * 2. 双人镜回退：本 chunk 说话人去重后恰好两人时，对象就是另一个说话人
 *    （双人对白场景，如「我们接待时没做好记录…」这种无称呼的回应句）。
 * 都推不出就不加对象，维持旧格式。
 */
const VOCATIVE_TITLE_PATTERN =
  /^([^，,。；：:！？\s]{1,6}(?:老师|主任|经理|处长|校长|书记|院长|部长|局长|科长|先生|女士|同志|同学|姐|哥))(?:[，,。；：:！？]|您|你|他|她|我)/u;

function dialogueAddressee(
  item: ExtractedCaseItem,
  chunkSpeakers: string[],
): string {
  const speaker = (item.speaker || "").trim();
  const match = VOCATIVE_TITLE_PATTERN.exec(item.text.trim());
  if (match) {
    const name = match[1];
    if (
      name &&
      name !== speaker &&
      !/[我你您他她它们这那的有是在就都把被让向往]/u.test(name)
    ) {
      return name;
    }
  }
  const others = chunkSpeakers.filter(
    (name) => name && name !== speaker && name !== "待确认人物",
  );
  return others.length === 1 ? others[0] : "";
}

function dialogueAction(
  item: ExtractedCaseItem,
  continues: boolean,
  addressee: string,
) {
  const speaker = item.speaker || "待确认人物";
  const text = item.text.trim();
  let intent = "进行说明";

  if (/抱歉|好的|没问题|感谢|我们这就|赶紧|一定注意|加强审核|没做好|没及时|记不清|填错/u.test(text)) {
    intent = /因为|导致|没做好|没及时|记不清|填错/u.test(text)
      ? "回应并说明原因"
      : "回应并确认处理";
  } else if (/请.{0,8}核实|确认些?细节/u.test(text)) {
    intent = /发现|显示|不一致|跨度|对不上/u.test(text)
      ? "说明核查发现并请求核实"
      : "提出核实请求";
  } else if (/建议|应该|不得|不能|麻烦|自行承担/u.test(text)) {
    intent = "指出问题并说明处理要求";
  } else if (
    /您看|出示|展示/u.test(text) &&
    /处理笺|清单|凭证|记录|费用|新闻/u.test(text)
  ) {
    intent = "展示单据并说明数据";
  } else if (/发现|显示|核实|不一致|超过|对不上|填错|没有来/u.test(text)) {
    intent = "说明核查发现";
  } else if (/[？?]|能不能|是否/u.test(text)) {
    intent = "提出询问";
  }

  const target =
    addressee && addressee !== (item.speaker || "").trim()
      ? `对${addressee}`
      : "";
  return `${speaker}${continues ? "继续" : ""}${target}${intent}`;
}

/**
 * 非对白来源行的三类判定（2026-10-07）。
 *
 * 用户实测反馈两条：① 案例一的动作与对白是衔接的，本可以在同一镜里表达；
 * ② 案例三在对白之前有详细动作描述，必须单独开镜。原来的布尔判定
 * （`isStandaloneVisualDescription`）只有一个阈值——「除场景设定开头外一律独立成镜」，
 * 两头都做不对：纯场景行被排除掉，而空字段标签行（真实 Word 里的「画面：」）
 * 反倒被当成画面描述独立成一个 0 秒镜头；而衔接动作与前置动作被同等对待。
 *
 * 三类按**结构性证据**判定，不猜画面内容（`TODO-2026-09-29-后续优化.md` 第 3 条
 * 「不能放宽服务端校验，也不能由代码或模型猜测该镜应有的场景和动作」）：
 * - `visual_beat`：出现关键道具／进门递交等状态变化／描述足够长 → **独立成镜**；
 * - `scene_context`：只交代时空与人物站位，无道具、无状态变化 → 只进 `location`；
 * - `noise`：只剩一个字段标签（「画面：」「镜头：」），或与画面无关的
 *   标题卡/旁白/后期特效/音效字幕。
 *
 * 为什么**不给**「场景行里的动作」单开一类：场景设定行描述的就是这一镜正在发生的
 * 事——「小李敲门进来，手里拿着平板」和紧随其后的「小李询问并指出问题」是同一时刻
 * 的同一件事，拆成两镜只会得到「一个有动作没台词、一个有台词没动作」的两半。
 * 用户举的案例三不是这种情况：那里的前置动作是**独立的 `action_or_narration` 原文行**
 * （「小赵看到一笔几年前的接待费用…」「又打开内部信息平台的历史新闻…」），
 * 本来就该独立成镜，不需要额外的类别。
 */
export type VisualSourceKind = "scene_context" | "visual_beat" | "noise";

/** 关键道具：出现它就说明这一镜有可见的实物信息，值得单独给一个镜位。 */
const VISUAL_PROP_RE =
  /(?:文件|单据|清单|凭证|票据|发票|报销单|发放单|结算单|明细|台账|平板|手机|电脑|屏幕|投影|新闻|合同|处理笺|材料|档案|笔记|记录本|文件夹|印章)/u;
/** 状态变化：打开、递交、进门这类动作会改变画面，静态站位不会。 */
const VISUAL_STATE_CHANGE_RE =
  /(?:打开|翻开|翻看|翻找|展示|出示|递交|递给|拿起|放下|收起|扫描|拍摄|拍照|排列|摊开|展开|合上|圈出|标注|点击|调出|走进|进来|进门|敲门|推门|进入|离开|起身|坐下|站起|转身)/u;
/** 只交代时空与人物站位的场景行标签（「场景设定：」）。 */
const SCENE_LABEL_RE = /^(?:场景设定|场景|环境|地点)[：:]/u;
/** 描述足够长时，无论有没有道具都值得单独给一个镜位。 */
const LONG_VISUAL_DESCRIPTION = 40;

/** 去掉行首符号与字段标签后的正文；只剩标签时返回空串。 */
function visualSourceBody(text: string) {
  return text
    .replace(/^[-—>\s]+/u, "")
    .replace(/^(?:场景设定|场景|画面|镜头|动作|环境|地点)[：:]\s*/u, "")
    .trim();
}

/**
 * 与画面无关的结构性行：标题卡、旁白、后期特效、音效字幕。
 *
 * 它们必须先被排除出分类——否则「5s-25s | 提示一：接待事项要真实」这种时间轴
 * 标题行会落进最后一档兜底、被判成 `visual_beat` 并独立成一个镜头。
 */
function isVisualMetadataRow(item: ExtractedCaseItem) {
  if (item.type === "dialogue") return false;
  const clean = item.text.replace(/^[-—>\s]+/u, "").trim();
  return item.type === "title_context" ||
    item.type === "narration_context" ||
    // 后期特效（红框、浮层、弹窗、数字闪烁）不是现场发生的动作。
    // 真实事故：「处理笺扫描件浮现在餐桌上方」被当成动作，餐桌因此进了画面词。
    item.type === "visual_effect" ||
    /^(?:音效|字幕)[：:]/u.test(clean);
}

export function classifyVisualSource(item: ExtractedCaseItem): VisualSourceKind {
  if (isVisualMetadataRow(item)) return "noise";
  const body = visualSourceBody(item.text);
  if (!body) return "noise";
  if (
    VISUAL_PROP_RE.test(body) ||
    VISUAL_STATE_CHANGE_RE.test(body) ||
    body.length >= LONG_VISUAL_DESCRIPTION
  ) {
    return "visual_beat";
  }
  return SCENE_LABEL_RE.test(item.text.replace(/^[-—>\s]+/u, ""))
    ? "scene_context"
    : "visual_beat";
}

/**
 * 非对白来源行贡献的动作片段（**不截断**，由调用方决定长度）。
 *
 * 场景设定行要**只取其中的可执行动作**（「小李敲门进来，手里拿着平板」），
 * 不能把场景标签与本镜地点再写一遍——真实分镜里出现过「场景设定：部门办公室门口…」
 * 整句进动作链的形态，再经 cleanImagePromptAction 才被剥掉标签。
 * 纯场景行（`scene_context`）与空标签行（`noise`）不贡献动作。
 */
function visualSourceAction(item: ExtractedCaseItem) {
  if (actionMetadata(item)) return "";
  const text = item.text.replace(/^[-—>\s]+/u, "").trim();
  return SCENE_LABEL_RE.test(text) ? sceneOpeningAction(text) : text;
}

/**
 * 这一行是不是「只交代时空」而不是「现场发生的动作」。
 *
 * 2026-10-07 起直接由三分类决定：只有 `visual_beat` 进动作链，
 * `scene_context`（纯场景行）与 `noise`（空标签行、标题卡、旁白、特效）都不进。
 */
function actionMetadata(item: ExtractedCaseItem) {
  if (item.type === "dialogue") return false;
  return classifyVisualSource(item) !== "visual_beat";
}

/** 从场景行里只取可执行的动作子句，丢掉「部门办公室门口」这类纯地点短语。 */
function sceneOpeningAction(text: string) {
  const clean = text
    .replace(/^[-—>\s]+/u, "")
    .replace(/^场景设定[：:]\s*/u, "")
    .trim();
  return clean
    .split(/[，,。]/u)
    .map((clause) => clause.trim())
    .filter((clause) =>
      /敲门|进来|走进|进入|拿着|手持|递交|翻看|打开|查看|拿起|放下|起身|坐下/u.test(clause),
    )
    .join("，");
}

/**
 * 一镜的动作链。
 *
 * 2026-10-07（Layer 0 的用户可见部分）：对白行带 `performance_cue` 时，
 * 动作链写**原文里的现场动作**（「王老师一愣」），而不是旧代码合成的口播意向串
 * （「王老师对小陈回应并说明原因」）。理由有两层：
 * ① 意向串不含任何可见信息，进生图提示词只会让模型画出两个人站着说话——
 *    它此前唯一的作用就是被 `continuityVisualActions` 的正则删掉，属于绕圈；
 * ② 原文里的提示才是这一镜真正要演的东西，也正是用户说的「动作与对白是衔接的」。
 *
 * 只在**这一镜有真实动作可写**时替换：整镜一句提示都没有时（老项目尚未迁移、
 * 或原文本身就没写动作），仍然回退到意向串——分镜的动作链不能是空的
 * （`normalizeVideoPromptBriefs` 会以「缺少场景或动作」硬拒收）。
 */
function shotActions(items: ExtractedCaseItem[]) {
  const hasDialogueRows = items.some((item) => item.type === "dialogue");
  const hasRealAction = hasDialogueRows && items.some((item) =>
    item.type === "dialogue"
      ? Boolean(item.performance_cue?.trim())
      : Boolean(visualSourceAction(item)),
  );
  // 2026-09-26：整 chunk 的说话人集合（去重、去占位名），供 dialogueAddressee 的
  // 双人镜回退使用；在循环外算一次，避免每条对白重复构造。
  const chunkSpeakers = [
    ...new Set(
      items
        .filter((item) => item.type === "dialogue")
        .map((item) => (item.speaker || "").trim()),
    ),
  ];
  const actions = items.flatMap((item, index) => {
    if (item.type === "dialogue") {
      const cue = hasRealAction ? cueAction(item) : "";
      if (cue) return [trimText(cue, 56)];
      const previous = items[index - 1];
      return [dialogueAction(
        item,
        previous?.type === "dialogue" && previous.speaker === item.speaker,
        dialogueAddressee(item, chunkSpeakers),
      )];
    }
    const action = trimText(visualSourceAction(item), 56);
    return action ? [action] : [];
  });
  return actions.slice(0, 7);
}

function shotLocation(
  item: ExtractedCase,
  items: ExtractedCaseItem[],
  speakers: string[],
) {
  if (item.context?.scene) return trimText(item.context.scene, 80);
  const sceneHints = items
    .map((item) => item.sceneHint)
    .filter((hint): hint is string => Boolean(hint));
  if (sceneHints.length) return sceneHints.map((hint) => trimText(hint, 38)).join("；");
  const visual = items.find((item) => item.type === "visual_direction");
  if (visual) return trimText(visual.text, 46);
  const uniqueSpeakers = [...new Set(speakers)];
  return uniqueSpeakers.length
    ? `${uniqueSpeakers.join("与")}的连续对话场景`
    : "根据原文画面说明建立场景";
}

export function buildCaseShots(
  item: ExtractedCase,
  chunks: ExtractedCaseItem[][],
): Shot[] {
  return chunks.map((chunk, shotIndex) => {
    const id = `${item.id}-${String(shotIndex + 1).padStart(2, "0")}`;
    const dialogueRows = chunk.filter((row) => row.type === "dialogue");
    const speakerSequence = dialogueRows.map(
      (row) => row.speaker || "待确认人物",
    );
    const dialogue = dialogueRows
      .map((row) => `${row.speaker || "待确认人物"}：“${row.text}”`)
      .join("\n");
    const actions = shotActions(chunk);
    // Layer 3：有对白时取「朗读时长 vs 动作表演时长」的较大者，无对白时按画面节奏
    // 估 4—4.5 秒。旧代码在这里直接调 `itemsSeconds`（只算对白），于是三个纯画面
    // 开场镜全是 0 秒。
    const estimatedSeconds = shotSeconds(chunk);
    return {
      id,
      caseId: item.id,
      referenceId: id,
      shotNumber: shotIndex + 1,
      title: item.title,
      chapter: `${item.group} · ${item.title}`,
      status: "missing" as const,
      storyboardConfirmed: false,
      speaker: speakerSequence.join(" → ") || "无人物对白",
      location: shotLocation(item, chunk, speakerSequence),
      dialogue:
        dialogue || "本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。",
      action: actions.length
        ? actions
        : ["根据原文案例事实和画面说明建立可视化动作"],
      continuity:
        shotIndex === 0
          ? "同一案例内保持人物身份、服装、场景与关键凭证连续；记录本镜结束时的人物站位、视线、手势和道具位置，供后续镜头接续。"
          : // 2026-10-08 二轮：这里的编号是**给用户看的**（`continuity` 在界面上可编辑），
            // 所以用对外展示的下划线写法 `${案例号}_01`。它在自己的句式里恒指
            // 「本案例第一镜」，`buildCaseShots` 不用拿到完整列表就能算出来。
            // 旧数据里是 `-01`，解析侧两个正则都用 `[-_]` 认下两种（不重写存量文本）。
            `延续 ${item.id}_01 的人物、服装、场景和关键道具；严格接续上一镜结束时的站位、视线、手势和道具位置，不重置动作。`,
      estimatedSeconds,
      sourceItems: chunk,
      planningNote:
        estimatedSeconds > MAX_SHOT_SECONDS
          ? "单段对白超过 15 秒且没有安全句点，请人工选择拆分位置。"
          : dialogueRows.length
            ? `按已验收样片语速估算约 ${estimatedSeconds} 秒。`
            : "纯画面镜头，无人物对白，按画面节奏执行。",
      prompt: {
        reference: "使用人工选定的参考图作为画面基础。",
        action: actions.join(" → "),
        dialogue: dialogueRows.length
          ? "由对应人物按顺序自然、清楚地完整说出原文对白。"
          : "本镜无人物对白，不生成旁白音频。",
        constraints:
          "不得省略、截断、改写对白；一个镜头只采用一种与动作一致的运镜，不切镜、不转场。",
      },
    };
  });
}

export function buildShotsFromCases(
  cases: ExtractedCase[],
  paragraphs: ScriptParagraph[],
) {
  return cases.flatMap((item) =>
    buildCaseShots(item, planCaseChunks(item, paragraphs)),
  );
}

export function hydrateLegacyShotSources(
  shots: Shot[],
  cases: ExtractedCase[],
  paragraphs: ScriptParagraph[],
) {
  return shots.map((shot) => {
    if (shot.sourceItems?.length) return shot;
    const caseId = shot.caseId ?? shot.id.replace(/-\d{2}$/u, "");
    const caseItem = cases.find((item) => item.id === caseId);
    if (!caseItem) return shot;

    const rows = [...shot.dialogue.matchAll(
      /(?:^|\n)([^：:\n]+)[：:]\s*[“"](.+?)[”"](?=\n|$)/gu,
    )].map((match, index) => {
      const text = match[2].trim();
      const sourceId = paragraphs.find(
        (paragraph) =>
          caseItem.sourceIds.includes(paragraph.id) &&
          paragraph.text.includes(text.slice(0, Math.min(12, text.length))),
      )?.id ?? caseItem.sourceIds[Math.min(index, caseItem.sourceIds.length - 1)] ?? 0;
      return {
        sourceId,
        type: "dialogue",
        speaker: match[1].trim(),
        text,
        estimatedSeconds: estimateSpeechSeconds(text),
        sceneHint: shot.location,
      } satisfies ExtractedCaseItem;
    });
    if (!rows.length) return shot;

    return {
      ...shot,
      caseId,
      sourceItems: rows,
      estimatedSeconds: itemsSeconds(rows),
      planningNote:
        shot.planningNote ??
        `按已验收样片语速估算约 ${itemsSeconds(rows)} 秒。`,
    };
  });
}

function splitItemsByKey(items: ExtractedCaseItem[], key: string) {
  const [kind, rawIndex, rawOffset] = key.split(":");
  const index = Number(rawIndex);
  if (kind === "after") {
    return [items.slice(0, index + 1), items.slice(index + 1)];
  }
  const offset = Number(rawOffset);
  const item = items[index];
  if (!item || item.type !== "dialogue") return [[], []];
  const beforeItem = {
    ...item,
    text: item.text.slice(0, offset).trim(),
  };
  beforeItem.estimatedSeconds = estimateSpeechSeconds(beforeItem.text);
  const afterItem = {
    ...item,
    text: item.text.slice(offset).trim(),
  };
  afterItem.estimatedSeconds = estimateSpeechSeconds(afterItem.text);
  return [
    [...items.slice(0, index), beforeItem],
    [afterItem, ...items.slice(index + 1)],
  ];
}

export function splitOptionsForShot(
  shot: Shot,
  projectSpeechRate = SPEECH_UNITS_PER_SECOND,
): ShotSplitOption[] {
  const items = shot.sourceItems ?? [];
  const speechRate = shot.speechRateOverride ?? projectSpeechRate;
  const options: ShotSplitOption[] = [];
  items.forEach((item, index) => {
    if (item.type !== "dialogue") return;
    const laterDialogue = items.slice(index + 1).some((row) => row.type === "dialogue");
    if (laterDialogue) {
      const key = `after:${index}`;
      const [before, after] = splitItemsByKey(items, key);
      options.push({
        key,
        label: `在${item.speaker || "当前人物"}说完“${trimText(item.text, 18)}”后拆分`,
        beforeSeconds: itemsSeconds(before, speechRate),
        afterSeconds: itemsSeconds(after, speechRate),
      });
    }
    const punctuation = /[。！？!?；;，,]/gu;
    for (const match of item.text.matchAll(punctuation)) {
      const offset = (match.index ?? 0) + match[0].length;
      if (offset >= item.text.length) continue;
      const key = `text:${index}:${offset}`;
      const [before, after] = splitItemsByKey(items, key);
      if (!hasDialogue(before) || !hasDialogue(after)) continue;
      options.push({
        key,
        label: `在${item.speaker || "当前人物"}说完“${trimText(item.text.slice(0, offset), 18)}”后拆分`,
        beforeSeconds: itemsSeconds(before, speechRate),
        afterSeconds: itemsSeconds(after, speechRate),
      });
    }
  });
  return options.filter(
    (option, index) =>
      options.findIndex((item) => item.key === option.key) === index,
  );
}

export function splitShotItems(shot: Shot, key: string) {
  return splitItemsByKey(shot.sourceItems ?? [], key);
}

/**
 * 2026-09-17 分镜反馈渠道：AI 按用户反馈重写分镜画面字段时的台词保护。
 * 台词是脚本事实——AI 只能动 speaker / location / action / continuity 和引号外的说明文字，
 * 引号内的对白必须逐字保留（允许空白差异，改一个字都拒收），否则下游生图/生视频
 * 会拿被改写的台词去生成，破坏「对白逐字呈现」的验收底线。
 */

/** 提取文本中所有引号（中文“…”或英文"…"）内的台词，按出现顺序返回。 */
export function extractQuotedDialogue(text: string): string[] {
  return [...text.matchAll(/[“"]([^“”"]+)[”"]/gu)].map((match) => match[1]);
}

/**
 * 校验 AI 修订后的分镜对白是否逐字保留了原文台词：
 * 引号组数量、顺序、内容（去空白后）完全一致才放行。
 * 原文无引号台词（无对白镜）时，修订稿也不得凭空新增引号台词。
 */
export function shotRevisionDialoguePreserved(
  original: string,
  revised: string,
): boolean {
  const compact = (value: string) => value.replace(/\s+/gu, "");
  const originalLines = extractQuotedDialogue(original).map(compact);
  const revisedLines = extractQuotedDialogue(revised).map(compact);
  return (
    originalLines.length === revisedLines.length &&
    originalLines.every((line, index) => line === revisedLines[index])
  );
}
