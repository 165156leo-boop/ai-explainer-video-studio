import assert from "node:assert/strict";
import {
  backfillPerformanceCue,
  nonGenerationParagraphIds,
  normalizeExtractionReview,
  parseAiJsonObject,
  postProductionEffectParagraphIds,
} from "./extraction-review.ts";
import type { ExtractedCase, ScriptParagraph } from "./workbench-data.tsx";

const paragraphs: ScriptParagraph[] = [
  { id: 1, kind: "meta", text: "科研经费使用场景" },
  { id: 2, kind: "meta", text: "老师问小李：这张发票是谁提交的？" },
  { id: 3, kind: "meta", text: "小李：是我提交的。（把发票递过去）" },
];

const ruleCases: ExtractedCase[] = [{
  id: "S1-E1",
  group: "待复核内容",
  title: "规则未识别案例边界",
  sourceIds: [1, 2, 3],
  dialogueCount: 0,
  storyboardCount: 1,
  note: "等待复核",
  items: [],
}];

const review = normalizeExtractionReview(
  parseAiJsonObject(`\`\`\`json
  {
    "summary": "识别到一段连续问答。",
    "issues": [],
    "cases": [{
      "id": "S1-E1",
      "group": "科研经费",
      "title": "发票来源核对",
      "sourceIds": [3, 1, 2],
      "dialogues": [
        { "sourceId": 2, "speaker": "老师" },
        { "sourceId": 3, "speaker": "小李" }
      ],
      "reason": "两段对白围绕同一事项。"
    }]
  }
  \`\`\``),
  paragraphs,
  ruleCases,
);

assert.equal(review.changed, true);
assert.equal(review.cases[0].dialogueCount, 2);
assert.deepEqual(
  review.cases[0].items
    ?.filter((item) => item.type === "dialogue")
    .map((item) => item.sourceId),
  [2, 3],
);
assert.equal(review.cases[0].items?.find((item) => item.sourceId === 2)?.text, "这张发票是谁提交的？");
assert.equal(review.cases[0].items?.find((item) => item.sourceId === 3 && item.type === "dialogue")?.text, "是我提交的。");
assert.match(
  review.cases[0].items?.find((item) => item.type === "visual_direction")?.text ?? "",
  /把发票递过去/u,
);
assert.throws(
  () => normalizeExtractionReview({ cases: [{ ...review.cases[0], dialogues: [] }] }, paragraphs, ruleCases),
  /没有标出人物对白/u,
);

const multiSpeakerParagraphs: ScriptParagraph[] = [
  { id: 10, kind: "heading", text: "提示一：接待事项要真实" },
  { id: 11, kind: "note", text: "场景设定：办公室内，两人核对接待材料。" },
  { id: 12, kind: "dialogue", text: "小陈：“信息与实际对不上。” 王老师：“我马上核实并退款。”" },
];
const multiSpeakerCases: ExtractedCase[] = [{
  id: "S1-E1",
  group: "公务接待",
  title: "接待事项要真实",
  context: { title: "提示一：接待事项要真实", scene: "场景设定：办公室内，两人核对接待材料。" },
  sourceIds: [10, 11, 12],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "规则提取",
  items: [
    { sourceId: 12, sourceSegment: 1, type: "dialogue", speaker: "小陈", text: "信息与实际对不上。", estimatedSeconds: 1 },
    { sourceId: 12, sourceSegment: 2, type: "dialogue", speaker: "王老师", text: "我马上核实并退款。", estimatedSeconds: 1 },
  ],
}];
const multiSpeakerReview = normalizeExtractionReview({
  summary: "标题、场景与两句对白均保留。",
  issues: [],
  cases: [{
    id: "S1-E1",
    group: "公务接待",
    title: "接待事项要真实",
    sourceIds: [10, 11, 12],
    dialogues: [
      { sourceId: 12, segment: 1, speaker: "小陈" },
      { sourceId: 12, segment: 2, speaker: "王老师" },
    ],
  }],
}, multiSpeakerParagraphs, multiSpeakerCases);

assert.equal(multiSpeakerReview.issues.length, 0);
assert.deepEqual(
  multiSpeakerReview.cases[0].items
    ?.filter((item) => item.type === "dialogue")
    .map((item) => [item.sourceSegment, item.speaker, item.text]),
  [
    [1, "小陈", "信息与实际对不上。"],
    [2, "王老师", "我马上核实并退款。"],
  ],
);
assert.match(multiSpeakerReview.cases[0].context?.scene ?? "", /办公室/u);

const visualOnlyParagraphs: ScriptParagraph[] = [
  { id: 20, kind: "heading", text: "提示一：接待事项要真实" },
  { id: 21, kind: "dialogue", text: "审计员：请核对处理笺信息。" },
  { id: 22, kind: "effect", text: "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”和“未实际到访”" },
  { id: 23, kind: "note", text: "弹出绿色提示框：✅ 信息必须真实准确" },
  { id: 24, kind: "note", text: "字幕（屏幕文字）：" },
  { id: 25, kind: "note", text: "❌ 填报信息与实际不符" },
  { id: 26, kind: "note", text: "✅ 正确做法：及时如实填报" },
];
const visualOnlyCases: ExtractedCase[] = [{
  id: "S1-E1",
  group: "公务接待",
  title: "接待事项要真实",
  sourceIds: visualOnlyParagraphs.map((paragraph) => paragraph.id),
  dialogueCount: 1,
  storyboardCount: 1,
  note: "规则提取",
  items: [
    { sourceId: 21, type: "dialogue", speaker: "审计员", text: "请核对处理笺信息。", estimatedSeconds: 2 },
    { sourceId: 22, type: "visual_effect", text: "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”和“未实际到访”", estimatedSeconds: 0 },
    { sourceId: 23, type: "visual_note", text: "弹出绿色提示框：✅ 信息必须真实准确", estimatedSeconds: 0 },
  ],
}];
const visualOnlyReview = normalizeExtractionReview({
  summary: "保留画面特效，排除后期文字。",
  issues: [],
  cases: [{
    id: "S1-E1",
    group: "公务接待",
    title: "接待事项要真实",
    sourceIds: visualOnlyParagraphs.map((paragraph) => paragraph.id),
    dialogues: [{ sourceId: 21, speaker: "审计员" }],
  }],
}, visualOnlyParagraphs, visualOnlyCases);
assert.deepEqual(visualOnlyReview.cases[0].sourceIds, [20, 21, 22]);
assert.ok(visualOnlyReview.cases[0].items?.some((item) => item.sourceId === 22));
assert.equal(
  visualOnlyReview.cases[0].items?.find((item) => item.sourceId === 22)?.type,
  "visual_effect",
  "后期特效段落只能登记为 visual_effect，不能变成画面动作或场景",
);
assert.ok(!visualOnlyReview.cases[0].items?.some((item) => [23, 24, 25, 26].includes(item.sourceId)));

// 真实文档「提示一」的段落顺序：「镜头/特效：」→ 特效正文 → 提示框 → 字幕块 → 下一节。
// 事故复盘：特效正文里写着「处理笺扫描件浮现在餐桌上方」，只排除标签、不排除正文，
// 它就会被当成画面动作，最后被生图模型忠实画出一张餐桌。
const realDocumentShape: ScriptParagraph[] = [
  { id: 30, kind: "meta", text: "标题：公务接待，这些关口要把牢" },
  { id: 31, kind: "heading", text: "5s-25s | 提示一：接待事项要真实" },
  { id: 32, kind: "action", text: "场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。" },
  { id: 33, kind: "dialogue", text: "小陈：“王老师，学院在三年前报销了几笔公务接待费用。”" },
  { id: 34, kind: "effect", text: "镜头/特效：" },
  { id: 35, kind: "action", text: "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”和“未实际到访”" },
  { id: 36, kind: "note", text: "弹出绿色提示框：✅ 公务接待处理笺信息必须真实准确" },
  { id: 37, kind: "note", text: "字幕（屏幕文字）：" },
  { id: 38, kind: "note", text: "❌ ：接待事项不真实，填报信息与实际不符" },
  { id: 39, kind: "heading", text: "25s-45s | 提示二：填写接待记录要规范" },
];
assert.deepEqual(
  [...postProductionEffectParagraphIds(realDocumentShape)].sort((left, right) => left - right),
  [34, 35],
  "空特效标签与其正文都要划入后期特效",
);
assert.ok(
  !postProductionEffectParagraphIds(realDocumentShape).has(36),
  "特效块遇到「提示框」这类非生成构造就收口，不把后面的提示框吞进来",
);
assert.ok(
  !nonGenerationParagraphIds(realDocumentShape).has(35),
  "特效正文不并入非生成集合：场景一致性旗标需要指向它",
);

// 2026-10-07（Layer 0）：舞台提示的**客户端迁移**（Python 侧的新导入另在
// `AI视频agent/scripts/test_extract_story_sections.py` 覆盖）。
//
// 旧提取器把「王老师一愣」「小李走进来，把平板递过去」这类提示整段剥掉，只留说话人。
// 对白镜因此没有可执行动作，下游只能合成「小陈对王老师说明核查发现」这类口播意向串，
// 再被 continuityVisualActions 全部删掉，最后 normalizeVideoPromptBriefs 以
// 「缺少场景或动作」硬拒收——表面故障离缺陷三层，所以必须从抽取层补回来。
//
// 迁移只补 `performance_cue` 一个字段：不删除、不重排、不覆盖用户改过的 speaker/text。
const cueParagraphs: ScriptParagraph[] = [
  { id: 15, kind: "dialogue", text: "王老师一愣：“我们接待时没做好记录。”" },
  { id: 16, kind: "dialogue", text: "小陈温和地提醒：“处理笺应该及时填写。”王老师点头：“好的。”" },
  { id: 30, kind: "dialogue", text: "小李站在门口笑着打招呼：“刘老师，跟您确认些细节。”" },
  { id: 31, kind: "dialogue", text: "小李走进来，把平板递过去：“您看，这份报销费用2250元。”" },
  { id: 49, kind: "dialogue", text: "小赵现场对话学院相关人员：“有一笔接待费最近才结算。”" },
  { id: 50, kind: "dialogue", text: "刘主任有些为难：“因为间隔太久才报销。”" },
  { id: 99, kind: "dialogue", text: "审计人员A（站在门口）：“这笔费用怎么处理？”" },
];
const cueCases: ExtractedCase[] = [{
  id: "S1-E1",
  group: "公务接待",
  title: "接待事项要真实",
  sourceIds: [15, 16, 30, 31, 49, 50, 99],
  dialogueCount: 7,
  storyboardCount: 4,
  note: "",
  items: [
    { sourceId: 15, type: "dialogue", speaker: "王老师", text: "我们接待时没做好记录。", estimatedSeconds: 3 },
    { sourceId: 16, type: "dialogue", speaker: "小陈", text: "处理笺应该及时填写。", estimatedSeconds: 3, sourceSegment: 1 },
    { sourceId: 16, type: "dialogue", speaker: "王老师", text: "好的。", estimatedSeconds: 1, sourceSegment: 2 },
    { sourceId: 30, type: "dialogue", speaker: "小李", text: "刘老师，跟您确认些细节。", estimatedSeconds: 3 },
    { sourceId: 31, type: "dialogue", speaker: "小李", text: "您看，这份报销费用2250元。", estimatedSeconds: 4 },
    { sourceId: 49, type: "dialogue", speaker: "小赵", text: "有一笔接待费最近才结算。", estimatedSeconds: 3 },
    { sourceId: 50, type: "dialogue", speaker: "刘主任", text: "因为间隔太久才报销。", estimatedSeconds: 3 },
    { sourceId: 99, type: "dialogue", speaker: "审计人员A", text: "这笔费用怎么处理？", estimatedSeconds: 2 },
  ],
}];
const cueMigrated = backfillPerformanceCue(cueParagraphs, cueCases)[0];
assert.equal(cueMigrated.items?.[0].performance_cue, "一愣");
assert.equal(
  cueMigrated.items?.[1].performance_cue,
  "温和地提醒",
  "段内第一处提示要落到该段第一句对白上",
);
assert.equal(cueMigrated.items?.[2].performance_cue, "点头", "同一段里第二句的提示要落到第二句");
assert.equal(cueMigrated.items?.[3].performance_cue, "站在门口笑着打招呼");
assert.equal(cueMigrated.items?.[4].performance_cue, "走进来，把平板递过去");
assert.equal(cueMigrated.items?.[5].performance_cue, "现场对话学院相关人员");
assert.equal(cueMigrated.items?.[6].performance_cue, "有些为难");
assert.equal(
  cueMigrated.items?.[7].performance_cue,
  undefined,
  "括号里的是场景说明（「审计人员A（站在门口）」），不是舞台提示",
);
assert.equal(
  cueMigrated.items?.[0].text,
  "我们接待时没做好记录。",
  "迁移只补字段，不得改写台词或说话人",
);
assert.deepEqual(
  backfillPerformanceCue(cueParagraphs, [cueMigrated]),
  [cueMigrated],
  "迁移必须幂等：重复执行结果不变",
);
// 幂等的第二层含义：无字段可补时要返回**同一个数组对象**，而不是等值的新数组——
// 调用方靠引用相等来决定「这次迁移什么都没做，不必回写项目」。
const cueAlreadyMigrated = [cueMigrated];
assert.equal(
  backfillPerformanceCue(cueParagraphs, cueAlreadyMigrated),
  cueAlreadyMigrated,
  "已带 performance_cue 的项目重复迁移时返回原数组，不做无意义的新建",
);
// 段落对不上（sourceId 不在原文里）时同样不得凭空补出内容。
const cueMissingParagraph: ExtractedCase[] = [{
  ...cueCases[0],
  sourceIds: [404],
  items: [{ sourceId: 404, type: "dialogue", speaker: "某人", text: "查不到原文的一句。", estimatedSeconds: 2 }],
}];
assert.equal(
  backfillPerformanceCue(cueParagraphs, cueMissingParagraph),
  cueMissingParagraph,
  "找不到原文段落时保持原样，不猜测提示",
);

console.log("extraction review tests passed");
