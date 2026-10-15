import type { ScriptReviewIssue, ScriptReviewReport } from "./project-store";
import { isRecord } from "./data-shape.ts";
import type { ExtractedCase, ScriptParagraph } from "./workbench-data";

/**
 * 脚本内容审核（导入后的自动一步）。
 *
 * ## 为什么要有这一步
 *
 * 2026-09-18 的真实事故：上传脚本里「镜头/特效：」下面写着
 * 「处理笺扫描件浮现在餐桌上方」，而同一节的场景设定是办公室。规则提取器当时
 * 只排除了「镜头/特效：」这个**标签**，把它下面的**正文**当成了现场画面动作，
 * 于是一路进了分镜动作 → 画面词 → 生图模型忠实画出一张餐桌。
 *
 * 这个缺陷的形状很关键：**规则能判「这段长什么样」，但判不了「这段在说什么」**。
 * 「处理笺扫描件浮现在餐桌上方」在词法上既像动作（有动词、有主体、有方位），
 * 也确实写在动作段落的位置上；只有读懂了它、并和本节场景设定对读，
 * 才能看出它是后期叠加、而且地点对不上。这正是大模型能补上、而规则补不上的那一格。
 *
 * 所以本步骤的定位是：**导入完成之后、进入后续步骤之前，让模型把脚本读一遍，
 * 专门检查"程序的分类有没有和原文语义说反"**。它只提出问题，不改写原文——
 * 改写属于人工修改原文或后续重新提取的职责。
 *
 * ## 字段判定（沿用本项目 2026-09-18 定下的唯一标准）
 *
 * > 只发「画面事实」：模型不看到就写不出来的东西。
 * > 凡属「管道机制」，一律不发。
 *
 * 三个固定字段的入选理由：
 * - `paragraphs`（id / kind / text）：审核对象本身就是**分类**，所以程序当前的
 *   `kind` 必须发——它是被审的判断，不是管道内部状态。
 * - `cases`（id / title / sourceIds）：模型要能指出"问题属于哪个案例"，
 *   也需要案例边界才能判断段落归属是否合理。只发这三个，不发 `dialogueCount`
 *   / `storyboardCount` / `estimatedSeconds` / `note` / `context` / `items`。
 * - `projectTitle`：一句话上下文。
 *
 * 刻意**不发**（见 `SCRIPT_AUDIT_WITHHELD_FIELDS`）：案例的统计数字与备注
 * （程序算出来的，模型看到只会去"解释"这些数字）、`items` 里逐条的
 * `estimatedSeconds` / `sceneHint`、提取引擎版本号、原始文件名、画风与规则配置。
 * 它们都不影响"这段话在说什么"，发给模型只会引出与审核无关的评论。
 */

/** 审核项类别。每一条都对应一个被真实事故验证过的缺陷形状，便于统计与分组展示。 */
export const SCRIPT_AUDIT_KINDS = [
  "effect-as-action",
  "scene-mismatch",
  "non-generation-mixed",
  "speaker-wrong",
  "missing-listener",
  "dialogue-split",
  "other",
] as const;

export type ScriptAuditKind = (typeof SCRIPT_AUDIT_KINDS)[number];

export const SCRIPT_AUDIT_KIND_LABELS: Record<ScriptAuditKind, string> = {
  "effect-as-action": "后期特效与现场动作混淆",
  "scene-mismatch": "与本节场景设定矛盾",
  "non-generation-mixed": "后期文字混入生成内容",
  "speaker-wrong": "说话人归属存疑",
  "missing-listener": "被对话的人不在画面里",
  "dialogue-split": "多说话人未拆开",
  other: "其他语义问题",
};

/** 报告展示顺序：把最贵的两类（会影响整段画面的）排在前面。 */
export const SCRIPT_AUDIT_KIND_ORDER: ScriptAuditKind[] = [
  "effect-as-action",
  "scene-mismatch",
  "non-generation-mixed",
  "missing-listener",
  "speaker-wrong",
  "dialogue-split",
  "other",
];

export type ScriptAuditItem = ScriptReviewIssue & { kind: ScriptAuditKind };

/**
 * 每一类审核项**在当前分类下是否可能成立**。
 *
 * 2026-09-18 端到端验证连续发现三次同一类问题：模型报出的判断，在**当前分类**下
 * 根本不构成分歧——
 *   ① 段落已标 `effect`，它还说"这段其实是后期叠加"；
 *   ② 段落已标 `summary`（字幕/屏幕文字，本来就不参与生成），它还说"这段不该参与生成"；
 *   ③ 章节标题与场景设定（`heading`/`note`）被说成"屏幕文字"。
 *
 * 逐条打补丁不如把前提写成表，由程序统一收口。**审核的价值在"分歧"**：
 * 只有"程序这么判、模型说该换个判法"时，问题才真实存在。
 *
 * 返回 `null` 表示前提成立（可能是真分歧）；返回字符串表示**不成立**，字符串就是原因。
 */
const GENERATION_CONTENT_KINDS: ScriptParagraph["kind"][] = [
  "dialogue",
  "action",
  "effect",
];

export function scriptAuditDropReason(
  kind: ScriptAuditKind,
  paragraph: ScriptParagraph | undefined,
): string | null {
  const current = paragraph?.kind;
  if (kind === "effect-as-action") {
    return current === "action"
      ? null
      : "该段已标为 effect，程序分类与模型判断一致、无需处理";
  }
  if (kind === "non-generation-mixed") {
    return current && GENERATION_CONTENT_KINDS.includes(current)
      ? null
      : "该段已被排除在生成内容之外（字幕/屏幕文字/标题/场景说明），本来就不会进画面";
  }
  return null;
}

/** 被程序核实为站不住而没收的条目，按类别计数（会写进结论，不静默丢弃）。 */
export type ScriptAuditDropped = Record<ScriptAuditKind, number>;

export function scriptAuditDropped(): ScriptAuditDropped {
  return Object.fromEntries(
    SCRIPT_AUDIT_KINDS.map((kind) => [kind, 0]),
  ) as ScriptAuditDropped;
}

/**
 * 被挡掉的条目在结论里怎么说——**必须说清为什么**，不能只报一个数字。
 * 三种原因是不同性质的：「与分类一致」是模型多说话，「无法核实」是模型越权下结论。
 */
const SCRIPT_AUDIT_DROP_REASONS: Partial<Record<ScriptAuditKind, string>> = {
  "effect-as-action": "该段已标为 effect，与程序分类一致",
  "non-generation-mixed": "该段本就被排除在生成内容之外",
  "scene-mismatch": "段落里没有可核实的场所词",
};

export type ScriptAuditResult = {
  summary: string;
  items: ScriptAuditItem[];
  counts: Record<ScriptAuditKind, number>;
  dropped: ScriptAuditDropped;
  model: string;
};

/** 一次审核最多收多少条，防止模型刷屏。 */
export const SCRIPT_AUDIT_MAX_ITEMS = 24;

/** 写进 `scriptReview.checks` 的固定标签；还原与去重都靠它。 */
export const SCRIPT_AUDIT_CHECK_LABEL = "AI 内容审核";

/** 固定发出去的字段（供测试与文档引用，防止后续重构又凭感觉增删）。 */
export const SCRIPT_AUDIT_SENT_FIELDS = [
  "projectTitle",
  "paragraphs",
  "cases",
] as const;

/** 刻意不发的字段，连同原因（测试断言它们不会意外混进去）。 */
export const SCRIPT_AUDIT_WITHHELD_FIELDS = [
  "caseStats",
  "caseNote",
  "caseItems",
  "extractionEngine",
  "sourceFileName",
  "rules",
] as const;

export const SCRIPT_AUDIT_WITHHELD_REASONS: Record<
  (typeof SCRIPT_AUDIT_WITHHELD_FIELDS)[number],
  string
> = {
  caseStats:
    "dialogueCount/storyboardCount/estimatedSeconds 是程序算出来的管道状态，与“这段在说什么”无关，发过去只会让模型去解释这些数字",
  caseNote: "程序自己写的提取备注，不是原文，模型会把它当成脚本内容来审核",
  caseItems: "案例条目里的逐条估算秒数与 sceneHint 都是中间产物，模型应只看原文段落",
  extractionEngine: "提取引擎版本号属于程序自我描述，对语义审核零信息量",
  sourceFileName: "文件名不参与语义判断，且可能带项目外的信息",
  rules: "已命中的规则说明是管道配置，模型看到会去复述规则而不是读原文",
};

export const SCRIPT_AUDIT_SYSTEM = `你是高校审计科普视频工作台的脚本内容审核员。程序已经按规则把上传的 Word 脚本逐段分了类，你要做的是——**读懂每一段在说什么，再判断程序的分类有没有说反**。你只提出问题，不改写原文、不重排段落、不新增内容、不评价文笔。

输入给你三样东西：
- paragraphs：脚本逐段列表，每段有 id、kind（程序当前的分类）、text（原文）。
- kind 的取值：meta=文档抬头信息；section=章节标题；heading=案例小标题；dialogue=人物对白；action=现场画面动作或旁白；effect=后期特效；note=场景与动作等上下文说明；summary=已判定不参与生成的字幕、屏幕文字、提示框、音效等。
- cases：程序划分的最小案例，每个有 id、title、sourceIds（属于它的段落编号）。

请按下面的顺序做，**不要只看整体印象，要逐段过**：

第一步｜建立基准。对每个案例，从它的 sourceIds 里找出写「场景设定：…」的那一段，记下它写的地点、在场人物和已经提到的道具。这是该案例画面的基准。

第二步｜查分类分歧（最重要）。**只针对 kind 是 action 的段落**，逐条单独回答：「这句话写的是**现场真人在做事**，还是**画面上的叠加效果**？」不要跳段、不要合并判断。
下面这些写法都属于**后期叠加**，不是现场发生的动作（真实脚本里都出现过）：
- 某文件、某界面、某截图、某表格「浮现 / 弹出 / 出现 / 飞入」在某处；
- 某处「被红框圈出 / 被高亮 / 被标注」；
- 「数字闪烁」「虚线连接」「箭头相反」「打出问号」这类对比或强调效果；
- 屏幕、弹窗、字幕条、提示框里的内容。
一个 kind 是 action 的段落读到这类写法，就按 effect-as-action 报告。

**注意两种都不要报**：
- 这一段**已经被标成 effect** —— 程序的分类和你的判断一致，没有分歧可报；
- 「他翻看凭证」「她敲门走进来」「两人对着材料核对」这种**真人在做事** —— 这是正确的 action。

第三步｜对场景。先在这段文字里找出表示**场所**的词——房间、地点、建筑、区域（例如办公室、门口、大厅）。只有**场所**对不上基准才算矛盾；道具、屏幕、界面、文件上的内容都不算场所，不要把「平板屏幕上」这种说法当成地点。把每条 action / effect 的场所词和第一步记下的基准对一遍，基准里没有、而且明显属于**另一个场所**的，按 scene-mismatch 报告，并说清是段落该改还是场景设定该改。注意：基准里**已经提到过**的道具不算矛盾——例如场景写了「手里拿着平板」，后面提到平板是正常的。

重要：**一段文字可以同时命中多个类别，那就分别各报一条。** 例如某一段既写的是后期叠加、它提到的地点又和本节场景对不上，就要同时报一条 effect-as-action 和一条 scene-mismatch，不要只报其中一条。

第四步｜再看另外两类：
- non-generation-mixed：**只针对 kind 是 dialogue / action / effect 的段落**——内容其实是字幕、屏幕文字、提示框文案、音效或全屏标题卡，本不该参与画面生成。**已经是 summary 的段落不要报**（程序已经把它排除在生成内容之外了）；heading（章节标题）与 note（场景与动作说明）也不是屏幕文字，同样不要报。
- speaker-wrong：对白归属的说话人与原文不符，或说话人写成了无法对应的代号、字母、单一称呼。
- missing-listener：某句对白在称呼一个人（句首或句中带称呼语），但该案例的场景设定与动作里始终没有这个人在场。这类问题会让成片出现「对着空座位说话」。
- dialogue-split：一段里出现多个带引号的说话人，但程序把它当成了一段（没有拆成多句对白）。

写在报告里的要求：
- 只返回一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 围栏。
- 结构：{"summary":"一句话总体结论","items":[{"kind":"…","message":"…","sourceId":段落id,"caseId":"案例id","reason":"…","question":"…","action":"…"}]}
- **kind 只能取下面这几个英文标识之一，必须原样照抄，不要翻译、不要改写成中文：**
  effect-as-action / scene-mismatch / non-generation-mixed / speaker-wrong / missing-listener / dialogue-split / other
  只有确实归不进前六类时才用 other。
- message 写**陈述句**，一句话说清问题（例如「这一段写的是后期叠加，不是现场动作」）；疑问句放到 question 里，两者不要写成同一句。
- items 为空数组是完全正常的结果，**不要为了凑数硬报**；但第二步和第三步里读起来**明确**的问题必须报出来。
- 为什么这两类要偏向"报"：漏掉一个「后期特效被当成现场动作」，成片里就会多出一样根本不该出现的东西，代价远高于多问人一句。其余类别拿不准就不要报。
- sourceId 必须是输入 paragraphs 里真实存在的 id，不要编造编号；一条问题对应一个 sourceId。
- 你**不能**改写原文；action 里要写出**具体怎么改**（例如把地点换成该场景里已有的位置、把叠加效果改写成真人的动作），不要只写「建议修改」四个字。
- 如果同一类问题在整份脚本里出现很多次，逐条报出每一处（各自带自己的 sourceId），不要合并成一条。`;

/**
 * 场所词表。**只用于核实模型报出的「场景矛盾」，既不参与生成、也不进提示词。**
 *
 * 为什么需要程序来核实：实测同一个 flash 模型连续三次调用，对「后期特效被当成现场动作」
 * 的判定稳定命中 4/4，但「场景矛盾」会飘——一次漏报，一次把「平板屏幕上」当成场所。
 * 靠继续调提示词收敛不了（试了两轮，precision 反而变差），而这件事本来就可以确定性判断：
 * 段落里**有没有一个场所词**、且这个场所词**不在本节场景设定里**。
 *
 * 与提取器里的 `ROOM_OR_FURNITURE_WORDS` 是同一套思路：模型负责"读懂这段在说什么"，
 * 程序负责"这个结论能不能被数据证实"。
 */
const PLACE_WORDS = [
  "办公室",
  "会议室",
  "教室",
  "大厅",
  "门口",
  "走廊",
  "楼梯",
  "阳台",
  "厨房",
  "卧室",
  "客厅",
  "餐厅",
  "餐桌",
  "饭桌",
  "沙发",
  "浴室",
  "车里",
  "车内",
  "户外",
] as const;

/** 在一段文字里找出可识别的场所词。 */
export function placeWordsIn(text: string): string[] {
  return [...new Set(PLACE_WORDS.filter((word) => text.includes(word)))];
}

/**
 * 判断一条「场景矛盾」能不能被程序证实。
 * 返回 true 表示**无法证实**（段落里没有场所词，或找到的场所词本来就在场景设定里）——
 * 这类结论不该占用人工确认的时间。
 */
export function sceneMismatchUnverifiable(
  sourceText: string,
  sceneText: string,
): boolean {
  const places = placeWordsIn(sourceText);
  if (!places.length) return true;
  return places.every((word) => sceneText.includes(word));
}

function cleanText(value: unknown, maxLength = 400) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function scriptAuditKindOf(value: unknown): ScriptAuditKind {
  const raw = cleanText(value, 40);
  return (SCRIPT_AUDIT_KINDS as readonly string[]).includes(raw)
    ? (raw as ScriptAuditKind)
    : "other";
}

/**
 * 组装发给模型的请求体。字段清单见文件头的判定说明——
 * 这里**只**放原文与分类，不放任何程序算出来的统计或配置。
 */
export function scriptAuditPayload(input: {
  projectTitle?: unknown;
  paragraphs: ScriptParagraph[];
  cases: ExtractedCase[];
}) {
  return {
    projectTitle: cleanText(input.projectTitle, 160),
    paragraphs: input.paragraphs.map(({ id, kind, text }) => ({
      id,
      kind,
      text: text.slice(0, 1600),
    })),
    cases: input.cases.map(({ id, title, sourceIds }) => ({
      id,
      title,
      sourceIds: Array.isArray(sourceIds) ? [...sourceIds] : [],
    })),
  };
}

/**
 * 校验并归一化模型返回。**所有编号都必须落在输入里**，对不上的就丢掉编号
 * 但保留问题文字——宁可少一个定位，也不要让界面指向一个不存在的段落。
 */
export function normalizeScriptAudit(
  value: unknown,
  paragraphs: ScriptParagraph[],
  cases: ExtractedCase[],
): ScriptAuditResult {
  if (!isRecord(value)) throw new Error("模型没有返回有效的脚本审核结果");

  const paragraphById = new Map(paragraphs.map((item) => [item.id, item]));
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const validCaseIds = new Set(cases.map((item) => item.id));
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const seen = new Set<string>();
  const items: ScriptAuditItem[] = [];
  const dropped = scriptAuditDropped();

  const sceneTextOf = (caseId: string | undefined, sourceId: number | undefined) => {
    const owner =
      (caseId ? caseById.get(caseId) : undefined) ??
      cases.find((item) => sourceId !== undefined && item.sourceIds.includes(sourceId));
    if (!owner) return "";
    return owner.sourceIds
      .map((id) => paragraphById.get(id)?.text ?? "")
      .filter((text) => /场景设定|场景[：:]|画面[：:]/u.test(text))
      .join("；");
  };

  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) continue;
    const kind = scriptAuditKindOf(rawItem.kind);
    const message =
      cleanText(rawItem.message, 240) || cleanText(rawItem.reason, 240);
    if (!message) continue;

    const rawSourceId = rawItem.sourceId;
    const sourceId =
      Number.isInteger(rawSourceId) && paragraphById.has(rawSourceId as number)
        ? (rawSourceId as number)
        : undefined;
    const rawCaseId = cleanText(rawItem.caseId, 24);
    const caseId = validCaseIds.has(rawCaseId) ? rawCaseId : undefined;
    const sourceText = sourceId ? paragraphById.get(sourceId)?.text : undefined;
    const sourceParagraph = sourceId ? paragraphById.get(sourceId) : undefined;

    // 统一收口：先问「这一类别在当前分类下是否可能成立」。
    // 不成立的直接挡掉并计数——这是「模型提议、程序核实」里"核实"那一步。
    const dropReason = scriptAuditDropReason(kind, sourceParagraph);
    if (dropReason) {
      dropped[kind] += 1;
      continue;
    }
    // 「场景矛盾」还要多一层数据核实：段落里得真有一个不在本节场景里的场所词。
    // 没给段落编号、没有场所词、或场所词本来就在场景里的，一律不收。
    if (kind === "scene-mismatch") {
      const verified =
        sourceText !== undefined &&
        !sceneMismatchUnverifiable(sourceText, sceneTextOf(caseId, sourceId));
      if (!verified) {
        dropped[kind] += 1;
        continue;
      }
    }

    const key = `${kind}:${sourceId ?? "-"}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      kind,
      message,
      sourceId,
      caseId,
      sourceText,
      reason: cleanText(rawItem.reason, 360) || message,
      question:
        cleanText(rawItem.question, 360) || "请确认这里的分段或角色归属是否正确。",
      action:
        cleanText(rawItem.action, 360) ||
        "确认后修改原文中对应的表述，再重新执行脚本审查。",
    });
    if (items.length >= SCRIPT_AUDIT_MAX_ITEMS) break;
  }

  const baseSummary =
    cleanText(value.summary, 500) ||
    (items.length
      ? `脚本内容审核发现 ${items.length} 项需要人工确认。`
      : "脚本内容审核未发现需要人工确认的语义问题。");

  // 挡掉的内容要如实说明「挡了几条、为什么」，不做静默丢弃。
  const notes = SCRIPT_AUDIT_KIND_ORDER.filter((kind) => dropped[kind] > 0).map(
    (kind) =>
      `${SCRIPT_AUDIT_KIND_LABELS[kind]} ${dropped[kind]} 条「${
        SCRIPT_AUDIT_DROP_REASONS[kind] ?? "不构成分歧"
      }」`,
  );

  return {
    summary: notes.length ? `${baseSummary}（另已忽略：${notes.join("；")}）` : baseSummary,
    items,
    counts: scriptAuditCounts(items),
    dropped,
    model: "",
  };
}

export function scriptAuditCounts(
  items: ScriptAuditItem[],
): Record<ScriptAuditKind, number> {
  const counts = Object.fromEntries(
    SCRIPT_AUDIT_KINDS.map((kind) => [kind, 0]),
  ) as Record<ScriptAuditKind, number>;
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

/** 统计转成一句人能读的说明，例如「后期特效与现场动作混淆 1 · 与本节场景设定矛盾 1」。 */
export function scriptAuditCountsLabel(
  counts: Record<ScriptAuditKind, number>,
): string {
  return SCRIPT_AUDIT_KIND_ORDER.filter((kind) => counts[kind] > 0)
    .map((kind) => `${SCRIPT_AUDIT_KIND_LABELS[kind]} ${counts[kind]}`)
    .join(" · ");
}

export function isScriptAuditKind(value: unknown): value is ScriptAuditKind {
  return (
    typeof value === "string" &&
    (SCRIPT_AUDIT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * 从已保存的脚本审查记录里还原审核结果。
 *
 * 为什么需要它：审核结果在「进入脚本工作台」时被并进 `scriptReview` 并持久化，
 * 而 `scriptAudit` 只是界面上的即时状态。重新打开项目时，如果只靠内存状态，
 * 面板就会消失、用户以为审核没跑过——所以按 check 行 + 带 `kind` 标记的 issues 还原。
 * 标记方式是在 issue 上多带一个 `kind` 字段（`ScriptReviewReport` 原样存 JSON，
 * 不需要改 schema）。
 */
export function scriptAuditFromReview(
  review: ScriptReviewReport,
): ScriptAuditResult | null {
  const check = review.checks.find((item) => item.label === SCRIPT_AUDIT_CHECK_LABEL);
  if (!check) return null;
  const items = (review.issues ?? []).filter((issue): issue is ScriptAuditItem =>
    isScriptAuditKind((issue as ScriptAuditItem).kind),
  );
  return {
    summary: check.detail,
    items,
    counts: scriptAuditCounts(items),
    dropped: scriptAuditDropped(),
    model: "",
  };
}

/**
 * 把审核结果并进脚本审查记录。
 *
 * 三条刻意约束：
 * 1. **不覆盖原有结论**——审核只是新增一行 check 与若干 issues，既有 BLOCKED 保持不动；
 * 2. **审核永远不会把状态升级成 BLOCKED**——它是自动运行的顾问，不是闸门。
 *    用模型可能出错的一次判断去硬拦流程，代价远大于收益；
 * 3. 同一段落同一问题不重复堆叠，便于用户逐条处理。
 */
export function scriptAuditReview(
  review: ScriptReviewReport,
  audit: ScriptAuditResult,
): ScriptReviewReport {
  const checkLabel = SCRIPT_AUDIT_CHECK_LABEL;
  const existingFlags = review.flags.filter((flag) => flag !== checkLabel);
  const flags = [...existingFlags];
  for (const item of audit.items) {
    if (!flags.includes(item.message)) flags.push(item.message);
  }

  const issues = [...(review.issues ?? [])];
  for (const item of audit.items) {
    if (
      !issues.some(
        (issue) => issue.message === item.message && issue.sourceId === item.sourceId,
      )
    ) {
      issues.push(item);
    }
  }

  const detail = audit.items.length
    ? `${audit.items.length} 项需确认：${scriptAuditCountsLabel(audit.counts)}${audit.model ? ` · ${audit.model}` : ""}`
    : `未发现需要人工确认的语义问题${audit.model ? ` · ${audit.model}` : ""}`;

  const checks = [
    ...review.checks.filter((check) => check.label !== checkLabel),
    {
      label: checkLabel,
      status: (audit.items.length ? "REVISE" : "PASS") as ScriptReviewReport["status"],
      detail,
    },
  ];

  const status: ScriptReviewReport["status"] =
    review.status === "BLOCKED" || checks.some((check) => check.status === "BLOCKED")
      ? "BLOCKED"
      : checks.some((check) => check.status === "REVISE")
        ? "REVISE"
        : "PASS";

  return { status, checks, flags, issues };
}
