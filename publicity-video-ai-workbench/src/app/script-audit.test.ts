import assert from "node:assert/strict";
import {
  SCRIPT_AUDIT_CHECK_LABEL,
  SCRIPT_AUDIT_KIND_LABELS,
  SCRIPT_AUDIT_MAX_ITEMS,
  SCRIPT_AUDIT_SENT_FIELDS,
  SCRIPT_AUDIT_SYSTEM,
  SCRIPT_AUDIT_WITHHELD_FIELDS,
  normalizeScriptAudit,
  placeWordsIn,
  sceneMismatchUnverifiable,
  scriptAuditDropped,
  scriptAuditDropReason,
  scriptAuditCounts,
  scriptAuditCountsLabel,
  scriptAuditFromReview,
  scriptAuditPayload,
  scriptAuditReview,
} from "./script-audit.ts";
import type { ScriptReviewReport } from "./project-store.ts";
import type { ExtractedCase, ScriptParagraph } from "./workbench-data.tsx";

// ---------------------------------------------------------------------------
// 样本照抄真实文档第 5 期「提示一」：场景设定是办公室，而「镜头/特效：」下面的
// 正文写着「处理笺扫描件浮现在餐桌上方」——本次新增这一步就是为了让模型指出
// 「这段其实是后期特效、而且地点和本节场景对不上」。
// ---------------------------------------------------------------------------
const paragraphs: ScriptParagraph[] = [
    { id: 11, kind: "action", text: "场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。" },
    { id: 12, kind: "heading", text: "5s-25s | 提示一：接待事项要真实" },
    { id: 13, kind: "dialogue", text: "小陈：“王老师，学院在三年前报销了几笔公务接待费用。”" },
  { id: 17, kind: "effect", text: "镜头/特效：" },
  { id: 18, kind: "action", text: "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”" },
  { id: 19, kind: "note", text: "弹出绿色提示框：✅ 公务接待处理笺信息必须真实准确" },
];

const cases: ExtractedCase[] = [{
  id: "S1-E1",
  group: "公务接待",
  title: "接待事项要真实",
  sourceIds: [11, 13, 17, 18],
  dialogueCount: 1,
  storyboardCount: 1,
  note: "程序写的提取备注",
  items: [],
  estimatedSeconds: 4,
  context: { title: "提示一", scene: "场景设定：办公室里…" },
}];

// ---------------------------------------------------------------------------
// 1. 请求体字段判定：只发原文与分类，不发程序算出来的统计与配置
// ---------------------------------------------------------------------------
const payload = scriptAuditPayload({
  projectTitle: "公务接待，这些关口要把牢",
  paragraphs,
  cases,
});

assert.deepEqual(Object.keys(payload), ["projectTitle", "paragraphs", "cases"]);
assert.deepEqual(Object.keys(payload).sort(), [...SCRIPT_AUDIT_SENT_FIELDS].sort());
assert.deepEqual(
  Object.keys(payload.paragraphs[0]),
  ["id", "kind", "text"],
  "段落只发 id/kind/text：kind 是本次要审的对象，必须发；段落的其它字段没有",
);
assert.deepEqual(Object.keys(payload.cases[0]), ["id", "title", "sourceIds"]);

for (const withheld of SCRIPT_AUDIT_WITHHELD_FIELDS) {
  assert.ok(
    !JSON.stringify(payload).includes(withheld),
    `不该发的字段 ${withheld} 出现在了请求体里`,
  );
}
assert.ok(
  !JSON.stringify(payload).includes("程序写的提取备注"),
  "案例备注是程序自己写的，模型会把当它成脚本内容来审核",
);
assert.ok(
  !JSON.stringify(payload).includes("dialogueCount"),
  "案例统计数字是管道状态，与“这段在说什么”无关",
);
assert.ok(
  !JSON.stringify(payload).includes("estimatedSeconds"),
  "时长估算是程序算出来的中间产物，不该进审核请求",
);

// ---------------------------------------------------------------------------
// 2. 归一化：编号必须落在输入里，对不上只丢编号、保留问题
// ---------------------------------------------------------------------------
const normalized = normalizeScriptAudit({
  summary: "发现一处后期特效被当成现场动作。",
  items: [
    {
      kind: "effect-as-action",
      message: "这一段是后期叠加，不是现场动作",
      sourceId: 18,
      caseId: "S1-E1",
      reason: "“扫描件浮现”是屏幕上的叠加层。",
      question: "这一段是否应标为后期特效？",
      action: "改标记为后期特效。",
    },
    {
      kind: "scene-mismatch",
      message: "特效地点与本场景不符",
      sourceId: 18,
      caseId: "S1-E1",
    },
    // 编号不存在：丢掉编号，但问题本身要留下——总比指向一个不存在的段落好
    { kind: "other", message: "编号对不上的问题", sourceId: 999, caseId: "S9-E9" },
    // 没有 message 的条目直接丢弃
    { kind: "other", sourceId: 18 },
    // 未知类别退化成 other
    { kind: "不存在的类别", message: "类别不认识的问题", sourceId: 11 },
    // 与第一条完全重复，去重
    { kind: "effect-as-action", message: "这一段是后期叠加，不是现场动作", sourceId: 18 },
  ],
}, paragraphs, cases);

assert.equal(normalized.items.length, 4);
assert.equal(normalized.items[0].kind, "effect-as-action");
assert.equal(normalized.items[0].sourceId, 18);
assert.equal(
  normalized.items[0].sourceText,
  "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”",
  "归一化要顺手补上原文，便于界面直接展示待确认的句子",
);
assert.equal(normalized.items[2].sourceId, undefined, "不存在的段落编号必须丢掉");
assert.equal(normalized.items[2].caseId, undefined, "不存在的案例编号必须丢掉");
assert.equal(normalized.items[2].message, "编号对不上的问题", "问题文字要保留");
assert.equal(normalized.items[3].kind, "other", "未知类别退化为 other");
assert.equal(normalized.items[3].message, "类别不认识的问题");
assert.equal(normalized.counts["effect-as-action"], 1);
assert.equal(normalized.counts["scene-mismatch"], 1);
assert.equal(
  normalized.counts.other,
  2,
  "显式 other 与被退化的未知类别都计入 other",
);
assert.equal(
  scriptAuditCountsLabel(normalized.counts),
  "后期特效与现场动作混淆 1 · 与本节场景设定矛盾 1 · 其他语义问题 2",
  "统计说明要按固定顺序排，且只列出现过的类别",
);
assert.equal(
  normalized.items.every((item) => item.question && item.action),
  true,
  "缺 question/action 时要补上默认值，否则界面会空一块",
);

const capped = normalizeScriptAudit({
  items: Array.from({ length: 60 }, (_, index) => ({
    kind: "other",
    message: `第 ${index} 条问题`,
    sourceId: 11,
  })),
}, paragraphs, cases);
assert.equal(capped.items.length, SCRIPT_AUDIT_MAX_ITEMS, "条数要有上限，防止模型刷屏");

const emptyAudit = normalizeScriptAudit({ items: [] }, paragraphs, cases);
assert.equal(emptyAudit.items.length, 0);
assert.match(emptyAudit.summary, /未发现/u, "空结果也要给一句人能读的结论");
assert.deepEqual(emptyAudit.counts, scriptAuditCounts([]));
assert.throws(() => normalizeScriptAudit("不是对象", paragraphs, cases), /有效的脚本审核结果/u);

// ---------------------------------------------------------------------------
// 3. 「场景矛盾」必须过一道确定性核实
//
// 起因：实测同一个 flash 模型连调三次，后期特效判定稳定 4/4，但「场景矛盾」会飘——
// 一次漏报，一次把「平板屏幕上」当成场所报出来。继续调提示词两轮反而更差，
// 所以改用程序判断：段落里得真有一个**不在本节场景设定里**的场所词。
// ---------------------------------------------------------------------------
assert.deepEqual(placeWordsIn("处理笺扫描件浮现在餐桌上方"), ["餐桌"]);
assert.deepEqual(placeWordsIn("平板屏幕上，两份数据用虚线连接"), [], "屏幕不是场所");
assert.deepEqual(placeWordsIn("凭证上的结算时间与发生时间之间弹出提示"), []);

assert.equal(
  sceneMismatchUnverifiable(
    "处理笺扫描件浮现在餐桌上方",
    "场景设定：办公室里，审计小陈站在办公桌前",
  ),
  false,
  "段落有场所词（餐桌）且场景设定里没有 → 可以证实，保留",
);
assert.equal(
  sceneMismatchUnverifiable(
    "平板屏幕上，处理笺的“6人”与结算单的“10人”用虚线连接",
    "场景设定：部门办公室门口，财务人员小李拿着平板",
  ),
  true,
  "段落里没有可识别的场所词 → 无法证实，忽略（真实误报样本）",
);
assert.equal(
  sceneMismatchUnverifiable(
    "小李走进办公室，把材料放在桌上",
    "场景设定：办公室里，两人核对材料",
  ),
  true,
  "场所词本来就在场景设定里 → 不构成矛盾",
);

// 端到端：模型把「平板屏幕」报成场景矛盾时，归一化要把它挡掉，并如实告知挡了几条
const sceneFiltered = normalizeScriptAudit({
  summary: "报告若干问题。",
  items: [
    {
      kind: "scene-mismatch",
      message: "这一段提到的地点与基准不符",
      sourceId: 18,
      caseId: "S1-E1",
    },
    {
      kind: "scene-mismatch",
      message: "这一段提到的地点与基准不符",
      sourceId: 19,
      caseId: "S1-E1",
    },
  ],
}, paragraphs, cases);
assert.equal(
  sceneFiltered.items.length,
  1,
  "只有带真实场所词的场景矛盾才保留",
);
assert.equal(sceneFiltered.items[0].sourceId, 18);
assert.equal(sceneFiltered.dropped["scene-mismatch"], 1);
assert.match(
  sceneFiltered.summary,
  /另已忽略：与本节场景设定矛盾 1 条「段落里没有可核实的场所词」/u,
  "挡掉的内容要如实说明，不做静默丢弃",
);
assert.equal(sceneFiltered.counts["scene-mismatch"], 1);

// 没有 sourceId 的场景矛盾根本无从核实，同样不收
const sceneWithoutId = normalizeScriptAudit({
  items: [{ kind: "scene-mismatch", message: "场景对不上" }],
}, paragraphs, cases);
assert.equal(sceneWithoutId.items.length, 0);
assert.equal(
  sceneWithoutId.dropped["scene-mismatch"],
  1,
  "没有段落编号的场景判断无从核实，按被挡掉计数",
);

// ---------------------------------------------------------------------------
// 3.5 「后期特效 vs 现场动作」只在分类有分歧时才算问题
//
// 这是**端到端实测才暴露出来的**问题：提取器修好之后（特效正文已正确标成 effect），
// 模型仍在报「这一段写的是后期叠加，不是现场动作」——它在复述一个已经正确的结论，
// 用户会去改本来没坏的地方。单元测试当时喂的是旧数据（19 还是 action）所以没发现。
// ---------------------------------------------------------------------------
const effectDivergence = normalizeScriptAudit({
  summary: "报告若干问题。",
  items: [
    // 第 18 段当前是 action，模型说它其实是叠加 → 真分歧，保留
    { kind: "effect-as-action", message: "这一段写的是后期叠加，不是现场动作", sourceId: 18, caseId: "S1-E1" },
    // 第 17 段当前已经是 effect，模型说它是叠加 → 与分类一致，没有分歧，挡掉
    { kind: "effect-as-action", message: "这一段写的是后期叠加，不是现场动作", sourceId: 17, caseId: "S1-E1" },
  ],
}, paragraphs, cases);
assert.equal(effectDivergence.items.length, 1, "只有与当前分类相矛盾的才算问题");
assert.equal(effectDivergence.items[0].sourceId, 18);
assert.equal(effectDivergence.counts["effect-as-action"], 1);
assert.equal(effectDivergence.dropped["effect-as-action"], 1);
assert.match(
  effectDivergence.summary,
  /另已忽略：后期特效与现场动作混淆 1 条「该段已标为 effect，与程序分类一致」/u,
  "挡掉的内容要如实说明是「与分类一致」，而不是「无法核实」",
);
// 干净文档上的正确行为：审核应当闭嘴
const alreadyFixed = normalizeScriptAudit({
  summary: "报告若干问题。",
  items: [
    { kind: "effect-as-action", message: "这一段写的是后期叠加", sourceId: 17 },
  ],
}, paragraphs, cases);
assert.equal(
  alreadyFixed.items.length,
  0,
  "整份脚本都已正确分类时，审核不得报出任何待处理项",
);

// ---------------------------------------------------------------------------
// 3.6 同一类问题的**第三个实例**：已排除的内容被报成「不该参与生成」
//
// 端到端实测里模型报了 9 条「这一段内容属于屏幕文字，不应参与画面生成」，
// 但它们**本来就是 summary**（字幕/屏幕文字，程序早已排除），
// 另两条更离谱：章节标题（heading）和场景设定（note）被说成屏幕文字。
// 所以「不该参与生成」这一类的前提是：该段**当前确实在生成内容里**。
// ---------------------------------------------------------------------------
const preconditions = normalizeScriptAudit({
  summary: "报告若干问题。",
  items: [
    // 编号对不上 → 无从核实
    { kind: "non-generation-mixed", message: "这一段内容属于屏幕文字", sourceId: 20 },
    // 章节标题不是屏幕文字
    { kind: "non-generation-mixed", message: "这一段内容属于屏幕文字", sourceId: 12 },
    // note（场景与动作说明）是上下文，不是屏幕文字
    { kind: "non-generation-mixed", message: "这一段内容属于屏幕文字", sourceId: 19 },
    // 真正的分歧：对白段落里混进了屏幕文字
    { kind: "non-generation-mixed", message: "这一段内容属于屏幕文字", sourceId: 13 },
  ],
}, paragraphs, cases);
assert.equal(preconditions.items.length, 1, "只有当前属于生成内容的段落才可能真有问题");
assert.equal(preconditions.items[0].sourceId, 13);
assert.equal(preconditions.dropped["non-generation-mixed"], 3);
assert.match(
  preconditions.summary,
  /另已忽略：后期文字混入生成内容 3 条「该段本就被排除在生成内容之外」/u,
  "挡掉的理由要说清是「本来就不会进画面」，与「无法核实」区分开",
);
// 段落不存在时（编号对不上）也不能凭空成立
assert.equal(
  scriptAuditDropReason("non-generation-mixed", undefined),
  "该段已被排除在生成内容之外（字幕/屏幕文字/标题/场景说明），本来就不会进画面",
);
assert.equal(scriptAuditDropReason("effect-as-action", undefined), "该段已标为 effect，程序分类与模型判断一致、无需处理");
assert.equal(
  scriptAuditDropReason("speaker-wrong", undefined),
  null,
  "说话人类别不做分类前提：它要抓的正是「这段该是对白却被归成别的」",
);

// ---------------------------------------------------------------------------
// 4. 并入脚本审查：新增一行 check、不覆盖已有结论、且永不把状态升级成 BLOCKED
// ---------------------------------------------------------------------------
const baseReview: ScriptReviewReport = {
  status: "PASS",
  checks: [
    { label: "原文完整性", status: "PASS", detail: "段落编号连续" },
    { label: "非生成内容排除", status: "PASS", detail: "字幕与提示框已排除" },
  ],
  flags: [],
  issues: [],
};

const merged = scriptAuditReview(baseReview, { ...normalized, model: "test-model" });
assert.equal(merged.checks.length, 3);
assert.equal(
  merged.checks.at(-1)?.label,
  SCRIPT_AUDIT_CHECK_LABEL,
  "审核要单独占一行 check，便于在脚本审查页定位",
);
assert.equal(merged.checks.at(-1)?.status, "REVISE", "发现问题时该行标 REVISE");
assert.match(merged.checks.at(-1)?.detail ?? "", /4 项需确认/u);
assert.match(merged.checks.at(-1)?.detail ?? "", /test-model/u);
assert.equal(merged.status, "REVISE");
assert.equal(merged.issues.length, 4, "审核问题要并进 issues，供脚本审查页逐条处理");
assert.equal(merged.flags.length, 4);

const cleanAudit = scriptAuditCounts([]);
const mergedClean = scriptAuditReview(baseReview, {
  summary: "没有发现问题。",
  items: [],
  counts: cleanAudit,
  dropped: scriptAuditDropped(),
  model: "",
});
assert.equal(mergedClean.checks.at(-1)?.status, "PASS");
assert.equal(mergedClean.status, "PASS", "没问题时不改变原状态");
assert.deepEqual(mergedClean.checks[0], baseReview.checks[0], "原有 check 不得被改写");

// 既有 BLOCKED 必须保持：审核是顾问，不是解封器
const blockedReview: ScriptReviewReport = {
  status: "BLOCKED",
  checks: [{ label: "人物对白覆盖", status: "BLOCKED", detail: "没有识别到人物对白" }],
  flags: [],
  issues: [],
};
const blockedMerged = scriptAuditReview(blockedReview, {
  summary: "没有发现问题。",
  items: [],
  counts: cleanAudit,
  dropped: scriptAuditDropped(),
  model: "",
});
assert.equal(blockedMerged.status, "BLOCKED", "审核通过也不能把已有 BLOCKED 解开");

// 反过来：审核自己发现问题时，最多到 REVISE，绝不 BLOCK 流程
assert.notEqual(merged.status, "BLOCKED", "自动审核不应把流程卡死");

// 重复并入要幂等，否则每跑一次就会多出一堆重复条目
const mergedTwice = scriptAuditReview(merged, { ...normalized, model: "test-model" });
assert.equal(mergedTwice.checks.length, 3, "重复并入不应新增第二行同类 check");
assert.equal(mergedTwice.issues.length, 4, "同一问题不得重复堆叠");
assert.equal(mergedTwice.flags.length, 4);

// ---------------------------------------------------------------------------
// 5. 断点还原：结果随 scriptReview 持久化，重新打开项目要能看到
// ---------------------------------------------------------------------------
const restored = scriptAuditFromReview(merged);
assert.ok(restored, "带审核 check 的记录必须能还原出审核结果");
assert.equal(restored.items.length, 4);
assert.equal(restored.items[0].kind, "effect-as-action");
assert.equal(restored.summary, merged.checks.at(-1)?.detail);
assert.equal(
  scriptAuditFromReview(baseReview),
  null,
  "没有审核过的项目不得凭空显示审核面板",
);

// 只有带 kind 标记的 issues 才算审核条目——AI 结构复核、旗标推导出来的问题不算
const mixedIssues = scriptAuditFromReview({
  ...merged,
  issues: [
    ...merged.issues,
    { message: "结构复核提出的问题", sourceId: 13 },
  ],
});
assert.equal(mixedIssues?.items.length, 4, "没有 kind 标记的普通问题不得被算进审核条目");

// ---------------------------------------------------------------------------
// 6. 文案与提示词的硬约束
// ---------------------------------------------------------------------------
assert.equal(
  Object.keys(SCRIPT_AUDIT_KIND_LABELS).length,
  7,
  "六类可报告问题 + other，界面分组依赖这张表",
);
const systemPrompt = SCRIPT_AUDIT_SYSTEM;
assert.match(systemPrompt, /effect-as-action/u, "提示词必须写明后期特效与现场动作的区分");
assert.match(systemPrompt, /逐段/u, "必须要求逐段判断，否则模型只给整体印象、会漏掉误分类");
assert.match(systemPrompt, /场景设定/u, "场景一致性判断要以「场景设定」那一句为基准");
assert.match(systemPrompt, /空座位/u, "要点明被对话的人不在场会导致什么后果");
assert.match(systemPrompt, /不能\*\*改写原文|改写原文/u, "必须说明模型不能改写原文");
assert.match(
  systemPrompt,
  /不要为了凑数硬报/u,
  "要写明空结果正常，否则模型会硬编问题出来",
);
assert.match(
  systemPrompt,
  /已经提到过\*\*的道具不算矛盾|已经提到过/u,
  "要给出反例：场景里已出现的道具不算矛盾，否则会误报",
);
assert.doesNotMatch(
  systemPrompt,
  /餐桌|饭桌/u,
  "提示词里不要写入事故原词：那等于把词送进模型上下文，可能被原样吐回",
);

console.log("script audit checks passed");
