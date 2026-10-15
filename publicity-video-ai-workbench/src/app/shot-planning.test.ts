import assert from "node:assert/strict";
import {
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  buildCaseShots,
  buildImagePrompts,
  continuityVisualActions,
  estimateSpeechSeconds,
  extractQuotedDialogue,
  findContinuityReferenceShot,
  hydrateLegacyShotSources,
  planCaseChunks,
  recalculateShotTiming,
  reorderActions,
  shotRevisionDialoguePreserved,
  splitOptionsForShot,
  summarizeShot,
  splitShotItems,
} from "./shot-planning.ts";
import { videoDurationBucket } from "./video-prompt.ts";
import {
  cleanImagePromptAction,
  cleanImagePromptScene,
  dedupeVisualSegments,
  normalizeImagePromptBriefs,
  normalizeImagePromptModelResult,
  stripTailFrameDialogueActions,
  stripImagePromptNoise,
} from "./image-prompt.ts";
import {
  IMAGE_PROMPT_CONDITIONAL_FIELDS,
  IMAGE_PROMPT_SENT_FIELDS,
  IMAGE_PROMPT_SYSTEM,
  IMAGE_PROMPT_WITHHELD_FIELDS,
  IMAGE_PROMPT_WITHHELD_REASONS,
  imagePromptContinuityFact,
  imagePromptDialogueFact,
  imagePromptModelPayload,
} from "./image-prompt-request.ts";
import type { ExtractedCase } from "./workbench-data";

const sample: ExtractedCase = {
  id: "S3-E1",
  group: "报销范围",
  title: "长对白案例",
  sourceIds: [34, 37, 38, 39, 40, 41],
  dialogueCount: 4,
  storyboardCount: 4,
  note: "",
  items: [
    {
      sourceId: 34,
      type: "visual_direction",
      text: "画面：审计人员A从电脑屏幕调出报销单。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 37,
      type: "dialogue",
      speaker: "审计人员A",
      text: "第一轮完整提问",
      estimatedSeconds: 14,
    },
    {
      sourceId: 38,
      type: "dialogue",
      speaker: "工作人员",
      text: "工作人员完整回答",
      estimatedSeconds: 10,
    },
    {
      sourceId: 39,
      type: "visual_direction",
      text: "画面：审计人员A调出微信付款记录并放大日期。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 40,
      type: "dialogue",
      speaker: "审计人员A",
      text: `${"甲".repeat(55)}。${"乙".repeat(55)}。`,
      estimatedSeconds: 20,
    },
    {
      sourceId: 41,
      type: "dialogue",
      speaker: "工作人员",
      text: "明白了，我们立行立改。",
      estimatedSeconds: 4,
    },
  ],
};

const chunks = planCaseChunks(sample);
assert.equal(chunks.length, 6, "纯画面描述应独立成镜，其余对白再按说话轮次或自然句点拆分");

// 存量案例没有 items 时，段落里的 note/action 场景也不能被 fallbackItems 丢掉。
// 案例三的“酬金发放单”就是这种形态：它应成为对白前后的独立画面镜头。
const legacySceneChunks = planCaseChunks(
  {
    id: "S3-E1",
    group: "无依据发放酬金",
    title: "自立名目、自定标准发放酬金",
    sourceIds: [39, 40, 41, 42, 43],
    dialogueCount: 4,
    storyboardCount: 1,
    note: "",
  },
  [
    { id: 39, kind: "dialogue", text: "工作人员A：院长，这是发放明细表，请您审阅。" },
    { id: 40, kind: "note", text: "酬金发放单：2026年3月全勤奖，每人200元。" },
    { id: 41, kind: "dialogue", text: "B：这个酬金发放没有依据吧？" },
    { id: 42, kind: "dialogue", text: "A：这是按照惯例发放的。" },
    { id: 43, kind: "dialogue", text: "B：如果没有依据就不能发放。" },
  ] as never,
);
assert.ok(
  legacySceneChunks.some((chunk) => chunk.some((row) => row.sourceId === 40)),
  "没有 items 的存量案例也要保留纯场景段落",
);
assert.ok(
  legacySceneChunks.length > 1,
  "案例三的场景描述不能继续和全部对白合成一个镜头",
);
assert.equal(
  chunks[0][0].sourceId,
  34,
  "案例开头的纯画面描述应独立成无对白镜头",
);
assert.equal(
  chunks[3][0].sourceId,
  39,
  "对白之间的纯画面说明应独立成新镜头",
);

const shots = buildCaseShots(sample, chunks);
// 2026-10-07（Layer 3）：纯画面镜不再恒为 0 秒。旧模型只算对白朗读时长，无对白的
// 镜头因此拿到 0——既看不出这一镜需要多少时间，提交豆包时也会掉进最小档。
// 现在按可见动作节拍估 4—4.5 秒，稳定落在 5 秒档（4 秒是 MIN_SHOT_SECONDS 下限，
// 超过 5 秒会跳进 10 秒档，白白多花一倍视频额度）。
assert.ok(
  (shots[0].estimatedSeconds ?? 0) >= 4,
  `纯画面镜必须有正时长，实际 ${shots[0].estimatedSeconds}`,
);
assert.equal(videoDurationBucket(shots[0].estimatedSeconds), 5);
assert.equal(shots[0].speaker, "无人物对白");
assert.ok(shots[0].action.some((action) => action.includes("电脑屏幕")));
assert.equal(shots[1].estimatedSeconds, 14);
assert.ok(shots[3].action.some((action) => action.includes("微信付款记录")));
assert.match(shots[5].speaker, /审计人员A.*工作人员/u);
assert.equal(findContinuityReferenceShot(shots, shots[0].id), undefined);
assert.equal(
  findContinuityReferenceShot(shots, shots[2].id)?.id,
  shots[1].id,
  "连续镜头应使用紧邻上一镜的已选图，而不是跳回案例首图",
);
assert.equal(
  findContinuityReferenceShot(
    [
      shots[0],
      {
        ...shots[1],
        caseId: "S9-E1",
        continuity: `优先使用${shots[0].id}的结尾截图作为连续性参考。`,
      },
    ],
    shots[1].id,
  )?.id,
  shots[0].id,
  "历史分镜中明确写出的参考镜头 ID 仍应生效",
);

// 2026-10-08：对外展示编号统一按「案例内顺序」给（`S1-E1-01`），而存量 `continuity`
// 文本里嵌的是规划器当字面量写下的 `${案例号}-01`。两种写法现在指的是同一个意思，
// 所以解析必须两条都认，否则改了展示格式就断链。
const sameCasePair = [
  { ...shots[0], id: "S8-E1-04", caseId: "S8-E1", continuity: "同一案例内保持连续。" },
  { ...shots[1], id: "S8-E1-03", caseId: "S8-E1", continuity: "延续 S8-E1-01 的人物、服装、场景和关键道具。" },
];
assert.equal(
  findContinuityReferenceShot(sameCasePair, "S8-E1-03")?.id,
  "S8-E1-04",
  "同案例「上一镜」分支优先：文档顺序上的前一镜才是真正的上一镜，编号里的 S8-E1-01 只是规划器写的字面量",
);
assert.equal(
  findContinuityReferenceShot(
    [
      { ...shots[0], id: "S7-E1-01", caseId: "S7-E1" },
      { ...shots[1], id: "S7-E1-04", caseId: "S7-E1", continuity: "延续 S7-E1-01 的人物、服装、场景和关键道具。" },
    ],
    "S7-E1-04",
  )?.id,
  "S7-E1-01",
  "内部键写法（S7-E1-01 恰好是本案例第一镜的真键）仍按原语义解析",
);
// 跨案例引用只能靠显式编号（同案例「上一镜」分支不生效），这条必须真解析到，
// 且回退用展示编号时要排掉本镜自己——否则会变成「参考自己」。
const crossCaseShots = [
  { ...shots[0], id: "S6-E1-04", caseId: "S6-E1" },
  { ...shots[1], id: "S6-E2-01", caseId: "S6-E2", continuity: "延续 S6-E1-01 的人物、服装、场景和关键道具。" },
];
assert.equal(
  findContinuityReferenceShot(crossCaseShots, "S6-E2-01")?.id,
  "S6-E1-04",
  "跨案例的显式展示编号要回退解析到展示为 S6-E1-01 的那一镜（即内部键 S6-E1-04）",
);
// 2026-10-08 二轮：展示编号换下划线后，正文里写的会是 `S6-E1_01`；
// 存量正文里写的仍是 `S6-E1-01`。两种写法在这里指同一件事，都必须解析到同一镜
// ——存量文本一个字节都不重写，只认一种就会断链。
assert.equal(
  findContinuityReferenceShot(
    [
      { ...shots[0], id: "S6-E1-04", caseId: "S6-E1" },
      { ...shots[1], id: "S6-E2-01", caseId: "S6-E2", continuity: "延续 S6-E1_01 的人物、服装、场景和关键道具。" },
    ],
    "S6-E2-01",
  )?.id,
  "S6-E1-04",
  "下划线写法的显式展示编号同样要回退解析到正确的那一镜",
);
assert.equal(
  findContinuityReferenceShot(
    [{ ...shots[0], id: "S5-E1-01", caseId: "S5-E1", continuity: "优先使用S5-E1_01的结尾截图。" }],
    "S5-E1-01",
  ),
  undefined,
  "下划线写法指向本镜自己时同样不得解析成自参考",
);
assert.equal(
  findContinuityReferenceShot(
    [{ ...shots[0], id: "S5-E1-01", caseId: "S5-E1", continuity: "优先使用S5-E1-01的结尾截图。" }],
    "S5-E1-01",
  ),
  undefined,
  "编号指向本镜自己时不得解析成自参考",
);

const actionChainSample: ExtractedCase = {
  id: "S1-E1",
  group: "案例一",
  title: "接待事项要真实",
  context: {
    scene: "场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。",
  },
  sourceIds: [11, 12, 13, 14, 15],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "",
  items: [
    {
      sourceId: 11,
      type: "title_context",
      text: "5s-25s | 提示一：接待事项要真实",
      estimatedSeconds: 0,
    },
    {
      sourceId: 12,
      type: "visual_direction",
      text: "- 场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 13,
      type: "dialogue",
      speaker: "小陈",
      text: "核实时发现，处理笺上的来访人员实际没有来京。",
      estimatedSeconds: 6,
    },
    {
      sourceId: 14,
      type: "dialogue",
      speaker: "王老师",
      text: "我们没做好记录，也没及时报销，可能事后填错了。",
      estimatedSeconds: 5,
    },
    {
      sourceId: 15,
      type: "action_or_narration",
      text: "处理笺扫描件浮现，来访人员信息被红框圈出。",
      estimatedSeconds: 0,
    },
  ],
};
const [actionChainShot] = buildCaseShots(
  actionChainSample,
  planCaseChunks(actionChainSample),
);
assert.equal(
  actionChainShot.location,
  "场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。",
  "场景设定应只进入场景字段",
);
assert.deepEqual(actionChainShot.action, [
  "小陈对王老师说明核查发现",
  "王老师对小陈回应并说明原因",
]);
assert.ok(
  actionChainShot.action.every((action) =>
    !/提示一|场景设定|“|”/u.test(action),
  ),
  "动作链不得混入案例标题、场景设定或整段对白",
);
assert.equal(
  actionChainShot.prompt.action,
  actionChainShot.action.join(" → "),
  "视频提示词应使用同一条动作顺序",
);
const actionChainShots = buildCaseShots(
  actionChainSample,
  planCaseChunks(actionChainSample),
);
assert.equal(actionChainShots.length, 2, "对白后的纯画面描述应单独成为一镜");
assert.deepEqual(actionChainShots[1].action, [
  "处理笺扫描件浮现，来访人员信息被红框圈出。",
]);

// 2026-09-26：兜底动作链必须带对话对象（用户实测反馈「画面词粗略、没有对话内容」）。
// 推断规则：① 台词称呼语「X老师，…」确定性命中（上面两个 sample 的断言即覆盖）；
// ② 双人镜无称呼时回退到另一个说话人（actionChainSample 王老师的回应句覆盖）；
// ③ 称呼误判防护——「总之」「您看」「院长批示」这类不是称呼；
// ④ 多人（≥3 个说话人）chunk 无称呼时不乱指对象。
const vocativeGuardSample: ExtractedCase = {
  id: "S9-E1",
  group: "案例九",
  title: "称呼误判防护",
  context: { scene: "办公室" },
  sourceIds: [70, 71],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "",
  items: [
    {
      sourceId: 70,
      type: "dialogue",
      speaker: "小张",
      text: "总之，这件事就按制度办。",
      estimatedSeconds: 3,
    },
    {
      sourceId: 71,
      type: "dialogue",
      speaker: "李主任",
      text: "您看，这笔费用怎么处理。",
      estimatedSeconds: 3,
    },
  ],
};
const [vocativeGuardShot] = buildCaseShots(
  vocativeGuardSample,
  planCaseChunks(vocativeGuardSample),
);
assert.deepEqual(vocativeGuardShot.action, [
  "小张对李主任进行说明",
  "李主任对小张展示单据并说明数据",
], "「总之」「您看」不得被当成称呼；双人镜无称呼时回退到另一个说话人");
assert.ok(
  !vocativeGuardShot.action.some((action) => /对总之|对您看/u.test(action)),
  "非称呼片段绝不许以「对X」形态进动作链",
);

const multiSpeakerSample: ExtractedCase = {
  id: "S9-E2",
  group: "案例九",
  title: "多人镜不乱指对象",
  context: { scene: "会议室" },
  sourceIds: [72],
  dialogueCount: 1,
  storyboardCount: 1,
  note: "",
  items: [
    {
      sourceId: 70,
      type: "dialogue",
      speaker: "小张",
      text: "各位，这笔费用最近才结算。",
      estimatedSeconds: 3,
    },
    {
      sourceId: 71,
      type: "dialogue",
      speaker: "李主任",
      text: "我们马上核实。",
      estimatedSeconds: 3,
    },
    {
      sourceId: 72,
      type: "dialogue",
      speaker: "王处长",
      text: "先把凭证调出来。",
      estimatedSeconds: 3,
    },
  ],
};
const [multiSpeakerShot] = buildCaseShots(
  multiSpeakerSample,
  planCaseChunks(multiSpeakerSample),
);
assert.ok(
  multiSpeakerShot.action.every((action) => !/对/u.test(action)),
  "≥3 个说话人且无称呼命中时，不得硬塞对话对象",
);

const openingSceneSample: ExtractedCase = {
  id: "S2-E1",
  group: "案例二",
  title: "填写接待记录要规范",
  context: {
    scene: "场景设定：部门办公室门口，小李敲门进来，手里拿着平板。",
  },
  sourceIds: [28, 30, 31],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "",
  items: [
    {
      sourceId: 28,
      type: "visual_direction",
      text: "场景设定：部门办公室门口，小李敲门进来，手里拿着平板。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 30,
      type: "dialogue",
      speaker: "小李",
      text: "刘老师，跟您确认些细节。",
      estimatedSeconds: 3,
    },
    {
      sourceId: 31,
      type: "dialogue",
      speaker: "小李",
      text: "您看，处理笺和用餐清单上的人数不同。",
      estimatedSeconds: 4,
    },
  ],
};
const openingSceneShots = buildCaseShots(
  openingSceneSample,
  planCaseChunks(openingSceneSample),
);
// 2026-10-07（Layer 2）：场景行里带**关键道具与状态变化**（「敲门进来，手里拿着平板」）
// 时，这一行描述的是独立的画面事件，必须单独给一个镜位。旧代码按「场景设定：」前缀
// 一刀切排除，再由 sceneOpeningAction 把动作抠回对白镜，于是同一镜里既有动作又有台词，
// 谁也没被完整表达。只交代时空的场景行（案例一的「办公室里，…站在办公桌前」）
// 仍然是 scene_context，不拆镜——这正是用户说的「案例一动作与对白是衔接的」。
assert.equal(
  openingSceneShots.length,
  2,
  "带道具与进门动作的场景行应独立成镜，纯时空场景行不拆",
);
assert.equal(openingSceneShots[0].speaker, "无人物对白");
assert.deepEqual(openingSceneShots[0].action, ["小李敲门进来，手里拿着平板"]);
assert.ok(
  openingSceneShots.every((shot) =>
    shot.action.every((action) => !/场景设定/u.test(action)),
  ),
  "场景描述中的真实起始动作可提取，但不得保留场景标签",
);
// 对白行没有 `performance_cue` 时仍回退到口播意向串：动作链不能为空，
// `normalizeVideoPromptBriefs` 会以「缺少场景或动作」硬拒收。
assert.deepEqual(openingSceneShots[1].action, [
  "小李对刘老师提出核实请求",
  "小李继续展示单据并说明数据",
]);

// 2026-10-07（Layer 0 的用户可见结果）：原文舞台提示（`performance_cue`）存在时，
// 动作链写**原文里真实发生的动作**，而不是合成的口播意向串。用户原话：
// 「像第一个分镜，动作与对白是衔接的，在一个分镜里可以表达」——那正是这种形态。
const cueDrivenSample: ExtractedCase = {
  id: "S1-E1",
  group: "接待事项",
  title: "动作与对白衔接",
  sourceIds: [12, 13, 14],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "",
  items: [
    {
      sourceId: 12,
      type: "visual_direction",
      text: "场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 13,
      type: "dialogue",
      speaker: "王老师",
      text: "我们没做好记录，也没及时报销。",
      estimatedSeconds: 4,
      performance_cue: "一愣",
    },
    {
      sourceId: 14,
      type: "dialogue",
      speaker: "小陈",
      text: "温和地提醒您补全记录。",
      estimatedSeconds: 4,
    },
  ],
};
const cueDrivenShots = buildCaseShots(
  cueDrivenSample,
  planCaseChunks(cueDrivenSample),
);
assert.equal(
  cueDrivenShots.length,
  1,
  "衔接动作不得把同一时刻劈成「有动作没台词」和「有台词没动作」两镜",
);
assert.deepEqual(
  cueDrivenShots[0].action,
  ["王老师一愣", "小陈对王老师进行说明"],
  "有真实舞台提示时用原文动作；没有提示的那一句才回退到口播意向串",
);
assert.ok(
  (cueDrivenShots[0].estimatedSeconds ?? 0) >= 4,
  "动作时间必须进入时长估算（Layer 3），不能只按对白字数",
);

const rebalancedDialogue = [
  "刘老师，您提交的公务接待费用，跟您确认些细节。",
  "您看，这份公务接待报销总费用2250元。公务接待处理笺上来访人数填的6人，公务接待用餐清单中来访人数变成10人，陪同人数有5人，两份单子填的来访人数不一致，且陪同人数超过规定标准。",
  "抱歉，我赶紧核实修改。",
  "麻烦您了，公务接待来访人数要准确，陪同人数也不能超标，来访人员在10人及以下的，我方陪同人不得超过3人；来访人员超过10人的，我方陪同人员不得超过来访人数1/3。如果确实有超标部分咱们就自行承担吧。",
  "好的，感谢提醒，以后一定注意。",
];
const rebalancedSample: ExtractedCase = {
  id: "S2-E1",
  group: "填写接待记录要规范",
  title: "短回答不应孤立成镜",
  sourceIds: [30, 31, 32, 33, 34],
  dialogueCount: 5,
  storyboardCount: 3,
  note: "",
  items: rebalancedDialogue.map((text, index) => ({
    sourceId: 30 + index,
    type: "dialogue",
    speaker: index === 2 || index === 4 ? "刘老师" : "小李",
    text,
    estimatedSeconds: estimateSpeechSeconds(text),
  })),
};
const rebalancedChunks = planCaseChunks(rebalancedSample);
const rebalancedShots = buildCaseShots(rebalancedSample, rebalancedChunks);
// 2026-09-16：对白语速基线由 6 字/秒调为 5 字/秒后，同样的台词需要更多镜位，
// 本案例由 3 镜变为 4 镜；2026-09-24 基线全局对齐 5.5 字/秒，台词更紧凑，
// 规划器重新合并为 3 镜。真正要守的不变量是「不留孤立短镜」——每镜都必须落在
// 4—15 秒的有效区间内，因此这里同时断言镜数与区间。
assert.equal(rebalancedShots.length, 3, "5.5 基线下应全案例重排为 3 镜，而不是留下 2 秒短镜头");
assert.ok(
  rebalancedShots.every(
    (shot) =>
      (shot.estimatedSeconds ?? 0) >= MIN_SHOT_SECONDS - 0.001 &&
      (shot.estimatedSeconds ?? 0) <= MAX_SHOT_SECONDS + 0.001,
  ),
  `每镜时长必须落在 ${MIN_SHOT_SECONDS}—${MAX_SHOT_SECONDS} 秒，实际：${rebalancedShots
    .map((shot) => shot.estimatedSeconds)
    .join(", ")}`,
);
assert.deepEqual(
  rebalancedShots.map((shot) => shot.referenceId),
  rebalancedShots.map((shot) => shot.id),
  "每个分镜必须绑定自己的画面词与参考图",
);
const perShotPrompts = buildImagePrompts(
  rebalancedShots.map((shot) => ({ ...shot, referenceId: "S2-E1-01" })),
);
assert.deepEqual(
  perShotPrompts.map((prompt) => prompt.id),
  rebalancedShots.map((shot) => shot.id),
  "即使旧数据共享 referenceId，也必须一镜生成一条画面词",
);
assert.ok(
  perShotPrompts[0].prompt.includes(rebalancedShots[0].action.join("；")),
  "首镜画面词应完整使用本镜动作",
);
assert.ok(
  perShotPrompts.slice(1).every((prompt) =>
    prompt.prompt.includes("本镜变化："),
  ),
  "继承上一镜的画面词只保留本镜新增变化，不能重复整条动作链",
);
assert.ok(
  perShotPrompts.every((prompt, index) =>
    prompt.prompt.includes(rebalancedShots[index].continuity),
  ),
  "每条画面词必须带上对应镜头的连续性约束",
);
assert.equal(
  findContinuityReferenceShot(
    [rebalancedShots[0], {
      ...rebalancedShots[1],
      continuity: "新地点独立开场，不沿用上一镜。",
    }],
    rebalancedShots[1].id,
  ),
  undefined,
  "明确说明不沿用上一镜时不应建立依赖",
);
assert.ok(
  rebalancedShots.every((shot) => (shot.estimatedSeconds ?? 0) <= 15),
  "自动重排后的每镜都应保持在 15 秒内",
);
assert.ok(
  rebalancedShots.every((shot) => (shot.estimatedSeconds ?? 0) >= 4),
  "短回答应与相邻语义段合并",
);
assert.equal(
  rebalancedChunks
    .flat()
    .filter((item) => item.type === "dialogue")
    .map((item) => item.text)
    .join(""),
  rebalancedDialogue.join(""),
  "重排只能改变切点，不能改写或遗漏对白",
);

const options = splitOptionsForShot(shots[5]);
assert.ok(options.length > 0, "包含两轮对白的镜头应提供人工拆分点");
const [before, after] = splitShotItems(shots[5], options[0].key);
assert.ok(before.some((item) => item.type === "dialogue"));
assert.ok(after.some((item) => item.type === "dialogue"));

const parentheticalSample: ExtractedCase = {
  id: "S4-E1",
  group: "括号画面说明",
  title: "2022 报销单",
  sourceIds: [50],
  dialogueCount: 1,
  storyboardCount: 1,
  note: "",
  items: [{
    sourceId: 50,
    type: "dialogue",
    speaker: "审计人员A",
    text: "请核对这笔费用。（画面显示2022年度报销单）",
    estimatedSeconds: 12,
  }],
};
const parentheticalShots = buildCaseShots(
  parentheticalSample,
  planCaseChunks(parentheticalSample),
);
assert.equal(parentheticalShots.length, 2);
assert.equal(parentheticalShots[1].dialogue, "审计人员A：“请核对这笔费用。”");
assert.equal(
  parentheticalShots[1].estimatedSeconds,
  estimateSpeechSeconds("请核对这笔费用。"),
);
assert.equal(parentheticalShots[0].speaker, "无人物对白");
assert.ok(parentheticalShots[0].action.some((action) => action.includes("2022年度报销单")));

const approvedSampleDialogue =
  "这个单位以值班名义，按月定额发放加班费，金额从1800元至2400元不等。学校加班费管理办法明确了4个可通过在校值班名义发放加班费的部门，这个部门不在其中。且其发放金额超出了制度规定的上限。";
// 2026-09-16：语速基线由 6 字/秒调为 5 字/秒后，这条 88 字的样片对白估算为 17.8 秒。
// 2026-09-24 基线全局对齐 5.5 字/秒，估算为 16.2 秒——仍超 15 秒上限。
// 这正对应了用户反馈「前半段赶、后半段空 4—5 秒」的那类样本：把 88 字压进 15 秒
// 等于 5.9 字/秒，模型只能前段抢速、后段用空白补足。因此这里不再断言它「在单镜容量内」，
// 而是显式记录它已超限、必须拆镜——避免以后误以为它还能压进 15 秒。
const approvedSampleDialogueSeconds = estimateSpeechSeconds(approvedSampleDialogue);
assert.equal(
  approvedSampleDialogueSeconds,
  16.2,
  "全局基线（5.5 字/秒）下该样片对白估算为 16.2 秒",
);
assert.ok(
  approvedSampleDialogueSeconds > MAX_SHOT_SECONDS,
  `该样片对白（约 88 字）已超出 ${MAX_SHOT_SECONDS} 秒单镜上限，应拆成两个镜头，而不是压进 15 秒`,
);
const relaxedTiming = recalculateShotTiming(
  {
    ...shots[0],
    dialogue: `审计人员A：“${"甲".repeat(60)}”`,
  },
  4.8,
);
assert.equal(relaxedTiming.estimatedSeconds, 12.5);
assert.match(relaxedTiming.planningNote ?? "", /舒缓节奏/u);
const overriddenTiming = recalculateShotTiming(
  {
    ...shots[0],
    dialogue: `审计人员A：“${"甲".repeat(60)}”`,
    speechRateOverride: 7.2,
  },
  4.8,
);
assert.equal(overriddenTiming.estimatedSeconds, 8.3);
assert.match(overriddenTiming.planningNote ?? "", /紧凑节奏/u);

const legacyCase: ExtractedCase = {
  id: "S2-E1",
  group: "历史归档",
  title: "可回退编辑",
  sourceIds: [23, 24],
  dialogueCount: 2,
  storyboardCount: 1,
  note: "",
};
const hydratedLegacyShots = hydrateLegacyShotSources(
  [{
    id: "S2-E1-01",
    title: "可回退编辑",
    chapter: "历史归档",
    status: "missing",
    speaker: "审计人员A → 工作人员B",
    location: "高校办公室",
    dialogue: "审计人员A：“这笔费用的发放事由是什么？”\n工作人员B：“这是一次工作指导。”",
    action: ["A询问", "B回答"],
    continuity: "保持同场",
    prompt: { reference: "", action: "", dialogue: "", constraints: "" },
  }],
  [legacyCase],
  [],
);
assert.equal(hydratedLegacyShots[0].caseId, "S2-E1");
assert.equal(hydratedLegacyShots[0].sourceItems?.length, 2);
assert.ok(
  splitOptionsForShot(hydratedLegacyShots[0]).length > 0,
  "历史归档镜头补齐来源后应恢复人工拆分点",
);

const originalActions = ["拿起凭证", "核对日期", "说明问题", "收好凭证"];
assert.deepEqual(
  reorderActions(originalActions, 2, 0),
  ["说明问题", "拿起凭证", "核对日期", "收好凭证"],
  "动作拖动后应按新位置保存",
);
assert.deepEqual(originalActions, ["拿起凭证", "核对日期", "说明问题", "收好凭证"]);

const promptBriefs = normalizeImagePromptBriefs([{
  id: "S1-E1-01",
  title: "接待事项要真实",
  scene: "高校办公室",
  characters: "小陈与王老师",
  dialogue: "小陈说明核查发现，王老师回应。",
  actions: ["小陈说明核查发现", "王老师回应"],
  continuity: "保持人物、服装和桌面凭证连续。",
  rules: ["小陈沿用审计员A形象"],
  referenceAssets: ["剪映扁平线条风参考图", "审计员A人物参考图"],
  fallbackPrompt: "16:9 横屏，剪映扁平线条风，高校办公室双人沟通场景。",
}]);
assert.deepEqual(
  normalizeImagePromptModelResult({
    prompts: [{
      id: "S1-E1-01",
      prompt: "16:9横屏，剪映式扁平线条插画，只参考上传风格图的画法。高校办公室内，小陈与王老师隔桌沟通，桌面放置审计凭证，人物身份与空间位置清晰。首帧两人自然闭嘴，保持服装、站位和桌面凭证连续，不出现字幕、提示框、无关人物或大段可读文字。",
    }],
  }, promptBriefs).map((item) => item.id),
  ["S1-E1-01"],
  "模型润色结果必须逐镜完整映射回原镜头 ID",
);
const completedModelPrompt = normalizeImagePromptModelResult({
  prompts: [{
    id: "S1-E1-01",
    prompt: "高校办公室内，小陈站在办公桌前与王老师沟通，小陈说明核查发现，王老师认真回应，小陈自然闭嘴。人物、服装和凭证连续，严格接续上一镜结束状态。",
  }],
}, promptBriefs)[0].prompt;
assert.match(completedModelPrompt, /16:9 横屏/u);
// 2026-09-25：画风句统一为「采用已上传风格图的MG插画风格，只参考上传风格图的画法」。
assert.match(completedModelPrompt, /采用已上传风格图的MG插画风格/u);
assert.match(completedModelPrompt, /首帧人物自然闭嘴/u);
assert.match(completedModelPrompt, /画面中不要出现额外的文字信息与提示框/u);
assert.doesNotMatch(completedModelPrompt, /上一镜|小陈自然闭嘴/u);
assert.match(completedModelPrompt, /保持人物、服装和桌面凭证连续/u);
assert.doesNotMatch(completedModelPrompt, /工作台复用规则|素材库/u);
assert.throws(
  () => normalizeImagePromptModelResult({
    prompts: [{
      id: "S1-E1-01",
      prompt: "16:9 横屏，剪映式扁平线条画风。高校办公室里，财务人员小李沿用上传的审计员A人物参考图，站在桌前核对凭证。画面采用中景构图，桌面凭证清晰可见。",
    }],
  }, [{ ...promptBriefs[0], rules: [], referenceAssets: ["剪映扁平线条风参考图"] }]),
  /擅自添加了人物参考绑定/u,
  "模型不能自行给未匹配规则的角色绑定人物参考图",
);
assert.throws(
  () => normalizeImagePromptModelResult({
    prompts: [{
      id: "S1-E1-01",
      prompt: "16:9横屏，本提示词由工作台根据素材库规则生成，请保留角色名和原对白，再创建办公室双人沟通画面。",
    }],
  }, promptBriefs),
  /内部操作说明|过短/u,
  "模型结果不得把工作台元数据带进豆包提示词",
);
assert.equal(
  cleanImagePromptAction("处理笺扫描件浮现在桌面上方，旁边弹出“？”和“未实际到访”"),
  "处理笺扫描件浮现在桌面上方",
  "图片提示词应保留可视动作，但删除后期弹出文案",
);
assert.equal(
  cleanImagePromptAction("新闻显示为我校赴M公司调研"),
  "新闻呈现相关信息",
  "动作进入模型前不应携带屏幕上的可读新闻文字",
);

// ---------------------------------------------------------------------------
// 2026-09-18：用户实测「有时润色加了很多自己的想法，提示词冗余，生图时重点混乱」。
// 下面这批用例的输入全部取自真实项目快照（workbench-data.json）里逐字出现的文本。
// ---------------------------------------------------------------------------
assert.equal(
  stripImagePromptNoise(
    "处理笺扫描件浮现在餐桌上方，移除或简化背景中的电脑、文件柜等元素，确保环境与原场景设定的简单办公桌环境一致。",
  ),
  "处理笺扫描件浮现在餐桌上方。",
  "模型自加的「移除/简化…确保…」调整建议必须剔除，只留画面事实",
);
assert.equal(
  stripImagePromptNoise(
    "王老师的形象细节（如发型、服装颜色、面部特征）需调整，使其与上一镜头保持一致；镜头角度和站位需调整，确保与前一镜头的视角和空间关系匹配。",
  ),
  "",
  "整条都是「需调整／保持一致」的元语句应被整条剔除",
);
assert.equal(
  stripImagePromptNoise("场景简洁，人物互动清晰，信息突出，构图紧凑，空间关系明确。"),
  "",
  "审片口吻的评价语整句剔除——它稀释主体权重，是「重点混乱」的直接来源",
);
assert.equal(
  stripImagePromptNoise("小陈站在办公桌前核对凭证，画面简洁，凭证清晰。"),
  "小陈站在办公桌前核对凭证。",
  "评价语混在事实句里时只删评价半句，画面事实必须留下",
);
assert.equal(
  stripImagePromptNoise(
    "小陈站在办公桌前与王老师沟通，王老师认真回应，光线保持室内自然光。",
  ),
  "小陈站在办公桌前与王老师沟通，王老师认真回应，光线保持室内自然光。",
  "可见的表情与光线描述不属于评价语，不得误删",
);
assert.equal(
  stripImagePromptNoise("画面中有一份被红色标记突出的凭证，旁边放着计算器。"),
  "画面中有一份被红色标记突出的凭证，旁边放着计算器。",
  "「突出的」是定语而不是评价语，不得误删",
);
assert.equal(
  stripImagePromptNoise("画面显示微信支付账单，不要出现提示框。"),
  "画面显示微信支付账单。",
  "模型自己写的否定指令收敛掉，由服务端统一附加，避免正反指令互相对立",
);

// 2026-09-18：把润色链路四阶段 trace 一遍后，从真实数据里揪出的两处缺陷，锁成契约。
assert.equal(
  cleanImagePromptScene("场景设定：办公室里，审计小陈站在办公桌前，与王老师沟通。"),
  "办公室里，审计小陈站在办公桌前，与王老师沟通。",
  "分镜自带的「场景设定：」字段标签不能当画面事实喂给模型",
);
assert.equal(
  cleanImagePromptScene("办公室里，审计小陈站在办公桌前，与王老师沟通。"),
  "办公室里，审计小陈站在办公桌前，与王老师沟通。",
  "没有字段标签的场景必须原样保留",
);
assert.equal(
  cleanImagePromptAction("地点：办公室内，小陈与王老师沟通。"),
  "办公室内，小陈与王老师沟通。",
  "动作路径与场景路径必须使用相同的字段标签清洗规则",
);

const duplicateRulePrompt = normalizeImagePromptModelResult(
  {
    prompts: [{
      id: "S1-E1-01",
      prompt:
        "16:9横屏，高校办公室内，小陈站在办公桌前与王老师面对面沟通，小陈伸手指着桌上的凭证说明情况，王老师认真倾听。",
    }],
  },
  [{
    ...promptBriefs[0],
    continuity: "",
    rules: [
      "小陈沿用审计员A形象：小陈出现时，人物外观统一沿用审计员A的固定人物参考图。",
      "小陈沿用审计员A形象（重复记录）：小陈出现时，人物外观统一沿用审计员A的固定人物参考图。",
    ],
  }],
)[0].prompt;
assert.equal(
  duplicateRulePrompt
    .split(/\r?\n/u)
    .filter((line) => /外观严格沿用/u.test(line)).length,
  1,
  "规则库里的重复条目只能追加一次——去重必须同时比对已经收集的约束，不能只比模型主体",
);

// 2026-09-18 用户决策：「不要限制它的那个字数了，不然有时候反而会影响他的发挥，
// 对他的约束越小越好。」——长度上限整个撤掉。这条是**反例断言**：
// 旧实现会把下面这段砍到 200 字（原本 MAX_IMAGE_PROMPT_BODY），现在必须逐字保留。
const longBody =
  "高校办公室内，小陈坐在办公桌前，面前摊开一叠接待处理笺与结算单。" +
  "小陈逐页翻看凭证，用笔尖点出人数栏的差异，眉头微皱；".repeat(6) +
  "坐在对面的王老师双手放在膝上，身体微微前倾，视线跟着小陈的笔尖移动。";
assert.ok(longBody.length > 200, "样本必须足够长才具备验证意义");
const longBodyPrompt = normalizeImagePromptModelResult(
  { prompts: [{ id: "S1-E1-01", prompt: longBody }] },
  promptBriefs,
)[0].prompt;
assert.ok(
  longBodyPrompt.includes("坐在对面的王老师双手放在膝上"),
  "长度上限已撤除：模型写出的有效细节不得再被按句截断",
);
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /长度不设上限/u,
  "系统提示词不能再出现「严格不超过 N 个汉字」这类限额表述",
);
assert.doesNotMatch(
  IMAGE_PROMPT_SYSTEM,
  /不超过\s*\d+/u,
  "长度约束已按用户决策撤除，系统提示词里不得残留字数上限",
);

// ────────────────────────────────────────────────────────────
// 2026-09-18 用户第二次追问（原话）：「你看你前面很多要发的都不是一些具体的东西，
// 你有的可能会产生一些歧义，就比如说你在服务端的时候会自动附加的，所以不用复述。
// 你为什么新版还要发，你要先自己判断要不要发过去。」
//
// 背景：第一版只发 5 个字段（把 dialogue / continuity / rules / referenceAssets
// 全扣在服务端，模型只能靠猜填空）；被追问后第二版直接放大到 9 个——那是从一个
// 极端走到另一个极端，**没有逐字段判断**。现在按一条标准重判：
//   只发「画面事实」；「管道机制」一律不发。
const payload = imagePromptModelPayload({
  projectTitle: "第5期-公务接待费",
  briefs: promptBriefs,
});
const payloadShot = payload.shots[0] as unknown as Record<string, unknown>;
assert.equal(
  Object.keys(payloadShot).length,
  IMAGE_PROMPT_SENT_FIELDS.length + IMAGE_PROMPT_CONDITIONAL_FIELDS.length,
  "字段数量必须与「固定发送 + 条件发送」清单一致——防止某次重构又凭感觉增删",
);
for (const field of IMAGE_PROMPT_SENT_FIELDS) {
  assert.ok(
    field in payloadShot,
    `${field} 必须发给模型：它是模型不看就写不出来的画面事实`,
  );
}
for (const field of IMAGE_PROMPT_WITHHELD_FIELDS) {
  assert.ok(
    !(field in payloadShot),
    `${field} 不该发：${IMAGE_PROMPT_WITHHELD_REASONS[field]}`,
  );
}
assert.equal(
  payloadShot.dialogue,
  "小陈说明核查发现，王老师回应。",
  "台词必须发给模型：不知道人在说什么、对谁说，就写不出对的表情和对话对象",
);
assert.equal(
  payloadShot.continuity,
  "保持人物、服装和桌面凭证连续。",
  "带画面事实的连续性要发（剔掉的只是程序样板句）",
);
const payloadJson = JSON.stringify(payload);
assert.ok(
  !payloadJson.includes("16:9 横屏，剪映扁平线条风，高校办公室双人沟通场景"),
  "程序模板成品 fallbackPrompt 不发给模型——发了它只会照抄模板，润色退化成复制",
);
assert.ok(
  !payloadJson.includes("小陈沿用审计员A形象"),
  "已命中的规则不发给模型：服务端重装时本来就会把同一句约束追加进成品，发过去只是让它复述一遍管道动作",
);

// 条件发送的 continuity：程序样板句必须被剔掉（服务端还会再追加一次），
// 但真画面事实必须留下——否则又回到「该给的上下文不给」。
assert.equal(
  imagePromptContinuityFact(
    "同一案例内保持人物身份、服装、场景与关键凭证连续；记录本镜结束时的人物站位、视线、手势和道具位置，供后续镜头接续。",
  ),
  "",
  "程序生成的样板句不是画面事实，且末尾半句是给操作者看的记录要求，不能喂给模型",
);
assert.equal(
  imagePromptContinuityFact(
    "延续 S1-E1-01 的人物、服装、场景和关键道具；严格接续上一镜结束时的站位、视线、手势和道具位置，不重置动作。",
  ),
  "",
  "第二类样板句同样剔除（存量 continuity 是连字符写法，用户数据不重写，必须继续认）",
);
// 2026-10-08 二轮：新生成的样板句换成下划线展示写法，同一个正则要一并认下——
// 只认一种会让另一种漏剔除，把「记录本镜结束时的人物站位…」这类给操作者看的说明
// 发给生图模型。
assert.equal(
  imagePromptContinuityFact(
    "延续 S1-E1_01 的人物、服装、场景和关键道具；严格接续上一镜结束时的站位、视线、手势和道具位置，不重置动作。",
  ),
  "",
  "新生成的下划线写法同样剔除",
);
assert.equal(
  imagePromptContinuityFact("只出现某教职工一人；与小王镜头按不同地点顺序呈现，不使用左右分屏。"),
  "只出现某教职工一人；与小王镜头按不同地点顺序呈现，不使用左右分屏。",
  "真正描述画面的连续性必须保留（这条来自「酬金发放」项目的真实数据）",
);
const boilerplateContinuityPayload = imagePromptModelPayload({
  projectTitle: "第5期-公务接待费",
  briefs: [{
    ...promptBriefs[0],
    continuity:
      "同一案例内保持人物身份、服装、场景与关键凭证连续；记录本镜结束时的人物站位、视线、手势和道具位置，供后续镜头接续。",
  }],
});
assert.ok(
  !("continuity" in (boilerplateContinuityPayload.shots[0] as unknown as Record<string, unknown>)),
  "只剩样板句时整个字段不发，而不是发一句空话占位",
);
assert.equal(
  imagePromptDialogueFact("本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。"),
  "",
  "「不生成旁白音频」是写给操作者的说明，不是台词，进请求体只会被模型当成要遵守的规则抄进画面",
);

// 系统提示词必须写清模型无法从字段里直接看到的事，否则等于把它放回去猜。
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /场景优先/u,
  "必须写明「场景优先」——真实分镜里 action 与 scene 会冲突（办公室 vs 越界地点）",
);
assert.doesNotMatch(
  IMAGE_PROMPT_SYSTEM,
  /餐桌|饭桌/u,
  "系统提示词不要写入事故里的越界物件名：那等于把词送进模型上下文，可能被原样吐回画面",
);
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /小李对着坐在办公桌后的刘老师说/u,
  "必须给出「对着坐在<位置>的<对象>说」的写法——这是「对着空座位说话」的正面解法",
);
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /只有开口的人才有名字/u,
  "characters 已不再发送，就必须告诉模型：说话人只写在 dialogue 的「名字：“台词”」前缀里",
);
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /不写人物外貌/u,
  "参考图清单已不再发送，就必须用一条写作规则替代它原本承担的信息",
);
assert.match(
  IMAGE_PROMPT_SYSTEM,
  /台词不进画面/u,
  "台词既然发给了模型，就必须同时讲明它只用于理解、不得写进画面",
);
assert.doesNotMatch(
  IMAGE_PROMPT_SYSTEM,
  /constraintsToAppend/u,
  "已经不发的字段不能在系统提示词里留说明，否则等于告诉模型它错过了什么",
);

assert.deepEqual(
  dedupeVisualSegments(
    "审计人员A坐在办公桌前，桌上堆着报销单，电脑屏幕上调出两张报销单，分别标注：",
    [
      "审计人员A坐在办公桌前，桌上堆着报销单，电脑屏幕上调出两张报销单，分别标注：",
      "2021年12月第8号凭证，报销加班餐费1,500元",
      "2021年12月第8号凭证，报销加班餐费1,500元",
    ],
  ),
  ["2021年12月第8号凭证，报销加班餐费1,500元"],
  "与场景重复的动作、以及动作之间的重复都要剔除",
);

// 模板路径：分镜真实数据里 location 与 action[0] 常是同一句话，且 action 里带台词原文。
const templateShot = {
  ...rebalancedShots[0],
  id: "S1-E1-01",
  location:
    "场景设定：审计人员A坐在办公桌前，桌上堆着报销单，电脑屏幕上调出两张报销单，分别标注：",
  action: [
    "审计人员A坐在办公桌前，桌上堆着报销单，电脑屏幕上调出两张报销单，分别标注：",
    "某教职工完整说出：“小王，把你的身份证号和银行卡号发给我。”",
  ],
  continuity: "同一案例内保持人物与场景连续。",
};
const templatePrompt = buildImagePrompts([templateShot])[0].prompt;
assert.equal(
  templatePrompt.split("桌上堆着报销单").length - 1,
  1,
  "模板不得把与场景重复的那句动作再拼一遍",
);
assert.doesNotMatch(
  templatePrompt,
  /完整说出|身份证号|银行卡号/u,
  "台词原文绝不能进生图提示词——模型会试图把它画成画面里的文字",
);
assert.match(templatePrompt, /开口说话/u, "被剥离台词的动手势应改写成可视的「开口说话」");
assert.doesNotMatch(templatePrompt, /。。|分别标注/u, "模板不得留下双句号或以冒号收尾的残缺句");
assert.doesNotMatch(templatePrompt, /场景设定/u, "分镜自带的字段标签不是画面内容");

// 端到端：模型同时给了事实、评价语和自加建议时，只有事实能活到最终提示词。
const noisyModelBody =
  "16:9横屏，剪映式扁平线条画风。办公室内，小陈站在办公桌前与王老师面对面沟通，小陈指着文件说明处理要求；王老师低头看文件。来访人员信息被醒目的红框圈出，突出显示关键内容。场景简洁，人物互动清晰，信息突出，构图紧凑，空间关系明确。处理笺扫描件浮现在餐桌上方，移除或简化背景中的电脑、文件柜等元素，确保环境与原场景设定一致。王老师的形象细节需调整，使其与上一镜头保持一致。";
const noisyResult = normalizeImagePromptModelResult(
  { prompts: [{ id: "S1-E1-01", prompt: noisyModelBody }] },
  promptBriefs,
)[0].prompt;
assert.match(noisyResult, /小陈站在办公桌前/u, "画面事实必须保留");
assert.doesNotMatch(
  noisyResult,
  /移除或简化|需调整|确保环境|场景简洁|人物互动清晰|构图紧凑|空间关系明确/u,
  "模型自加的调整建议与评价语不得进入最终提示词",
);
assert.match(noisyResult, /连续性保持：/u, "程序仍按规则附加连续性约束");
assert.match(
  noisyResult,
  /画面中不要出现额外的文字信息与提示框/u,
  "服务端统一附加的负面约束只剩一句短句，不依赖模型自觉",
);
assert.equal(
  cleanImagePromptAction("“2025年4月第8号凭证，报销水果1,000元”“2025年4月第12号凭证，报销食品180元”"),
  "",
  "整条只剩屏幕文字的片段应整条丢弃，不拼出空转的「相关信息相关信息」",
);

// 2026-09-17 生图逻辑改版：续镜以上一镜已选图为唯一参考，提示词只写增量变化。
const chainedPrompts = buildImagePrompts([
  rebalancedShots[0],
  { ...rebalancedShots[1], continuity: "接续上一镜，同场景人物位置不变。" },
]);
assert.match(
  chainedPrompts[0].prompt,
  /已上传风格图的MG插画风格/u,
  "首镜没有上一镜参考，仍以风格图锚定画风（MG插画措辞）",
);
assert.match(
  chainedPrompts[1].prompt,
  /参考图为上一镜 .+ 的已选画面/u,
  "续镜应声明以上一镜已选图为参考",
);
// 2026-10-08：发给模型的这段正文里也不再出现内部键。`rebalancedShots[0].id` 恰好是
// `案例-01`，两种写法同形，所以这里额外用一例内部键带缺口的来坐实。
// 同日二轮：展示编号换下划线，正文里的编号随之变成 `S4-E1_01`（内部键仍是 `S4-E1-04`）。
const labelChained = buildImagePrompts([
  { ...rebalancedShots[0], id: "S4-E1-04", caseId: "S4-E1" },
  { ...rebalancedShots[1], id: "S4-E1-03", caseId: "S4-E1", continuity: "接续上一镜，同场景人物位置不变。" },
]);
assert.match(
  labelChained[1].prompt,
  /参考图为上一镜 S4-E1_01 的已选画面/u,
  "续镜正文要用按顺序的展示编号，而不是内部键 S4-E1-04",
);
assert.doesNotMatch(
  labelChained[1].prompt,
  /S4-E1-04/u,
  "画面词正文里不得再出现内部键",
);
assert.match(
  chainedPrompts[1].prompt,
  /本镜变化：/u,
  "续镜画面词应以增量变化为主体",
);
assert.doesNotMatch(
  chainedPrompts[1].prompt,
  /风格图|人物图/u,
  "续镜不再引入风格图、人物图约束——上一镜图已是两者的成品实例",
);
assert.ok(
  chainedPrompts[1].prompt.includes("同场景人物位置不变"),
  "续镜仍须保留连续性衔接说明",
);

// 润色链路：styleAnchored 续镜重装参考图分工行，绝不追加风格图兜底句。
const continuationBriefs = normalizeImagePromptBriefs([{
  id: "S1-E1-02",
  title: "接续沟通",
  scene: "高校办公室",
  characters: "小陈与王老师",
  dialogue: "王老师补充说明。",
  actions: ["王老师起身走向窗边"],
  continuity: "接续上一镜，人物位置不变。",
  rules: [],
  referenceAssets: ["参考图为上一镜已选画面"],
  fallbackPrompt: "",
  styleAnchored: true,
}]);
const continuationPayload = imagePromptModelPayload({ briefs: continuationBriefs });
assert.equal(
  (continuationPayload.shots[0] as { continuityMode?: string }).continuityMode,
  "tail_frame",
  "继承尾帧的润色请求必须明确标记为只写增量变化",
);
const anchoredModelPrompt = normalizeImagePromptModelResult({
  prompts: [{
    id: "S1-E1-02",
    prompt: "高校办公室内，王老师起身走向窗边眺望窗外，小陈坐在原位记录。构图转为中景，光线保持室内自然光。",
  }],
}, continuationBriefs)[0].prompt;
assert.match(anchoredModelPrompt, /16:9 横屏/u);
assert.match(
  anchoredModelPrompt,
  /参考图为上一镜的已选画面/u,
  "styleAnchored 续镜润色后必须补上参考图分工行",
);
assert.doesNotMatch(
  anchoredModelPrompt,
  /风格图|扁平线条/u,
  "styleAnchored 续镜不得追加“参考上传风格图”的悬空兜底句",
);
assert.match(anchoredModelPrompt, /画面中不要出现额外的文字信息与提示框/u);
assert.doesNotMatch(
  stripTailFrameDialogueActions(
    "办公室门口，小李拿着平板走近。小李对着刘老师说：“来访人员超过10人。”刘老师回应：“好的。”。",
  ),
  /说[：:]|回应[：:]|来访人员超过10人/u,
  "继承尾帧时对白只用于理解关系，不得被改写成画面动作",
);

// 2026-09-17 分镜反馈渠道：AI 按反馈重写分镜时，引号内台词必须逐字保留。
const reviseOriginal =
  "小李：“王老师，学院这个月的报销单我来取。”\n王老师：“好，放桌上就行。”";
assert.deepEqual(
  extractQuotedDialogue(reviseOriginal),
  ["王老师，学院这个月的报销单我来取。", "好，放桌上就行。"],
  "应按出现顺序提取所有引号内台词",
);
assert.deepEqual(
  extractQuotedDialogue("本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。"),
  [],
  "无对白镜没有引号台词",
);
assert.ok(
  shotRevisionDialoguePreserved(reviseOriginal,
    "小李与王老师同框。小李：“王老师，学院这个月的报销单我来取。”递上文件。\n王老师：“好，放桌上就行。”",
  ),
  "引号外说明文字可以改写，引号内逐字一致即放行",
);
assert.ok(
  shotRevisionDialoguePreserved(reviseOriginal, reviseOriginal.replace("报销单", "报销单 ")),
  "空白差异容忍",
);
assert.ok(
  !shotRevisionDialoguePreserved(
    reviseOriginal,
    reviseOriginal.replace("报销单我来取", "凭证我来取"),
  ),
  "引号内改一个字必须拒收",
);
assert.ok(
  !shotRevisionDialoguePreserved(
    reviseOriginal,
    "小李：“王老师，学院这个月的报销单我来取。”",
  ),
  "漏掉一句台词必须拒收",
);
assert.ok(
  !shotRevisionDialoguePreserved(
    "本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。",
    "小李：“王老师您好。”",
  ),
  "无对白镜不得被 AI 凭空新增引号台词",
);
assert.ok(
  !shotRevisionDialoguePreserved(
    reviseOriginal,
    "王老师：“好，放桌上就行。”\n小李：“王老师，学院这个月的报销单我来取。”",
  ),
  "台词顺序调整也视为改写，必须拒收",
);

// 2026-09-19（用户拍板）：后期特效在前期识别就不进案例/分镜——特效跟着案例流进
// sourceItems → 画面词/视频词，实测造成生成漂移。规划器必须把它排除，且新旧两种
// 流入形态都要挡住（visual_effect 直传 + 旧 schema 的 action_or_narration 混入由
// 上游迁移负责，这里锁直传形态）。
{
  const effectCase = {
    id: "S9-E1",
    title: "特效排除测试",
    sourceIds: [1, 2, 3],
    items: [
      { sourceId: 1, type: "visual_direction", text: "场景设定：办公室里，两人对话。", estimatedSeconds: 0 },
      {
        sourceId: 2,
        type: "dialogue",
        speaker: "小陈",
        text: "王老师，学院在三年前报销了几笔公务接待费用，时间较为集中。",
        estimatedSeconds: 7,
      },
      {
        sourceId: 3,
        type: "visual_effect",
        text: "处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”",
        estimatedSeconds: 0,
      },
    ],
  } as never as Parameters<typeof planCaseChunks>[0];
  const chunks = planCaseChunks(effectCase);
  const allItems = chunks.flat();
  assert.ok(
    !allItems.some((item) => item.type === "visual_effect"),
    "visual_effect 不得进入任何分镜块",
  );
  assert.ok(
    !chunks.flat().some((item) => String(item.text ?? "").includes("红框")),
    "特效文本不得以任何形式混进分镜",
  );
  assert.ok(
    chunks.flat().some((item) => item.type === "dialogue"),
    "过滤特效后正常对白仍要保留",
  );
}

// 2026-09-26：预览面板摘要——必须能从台词里抓出具体事实，让每镜一眼可辨。
{
  const shot = {
    id: "S2-E1-02",
    title: "填写接待记录要规范",
    location: "场景设定：部门办公室门口，财务人员小李路过时顺便敲门进来，手里拿着平板，语气轻松。",
    action: ["小李说明核查发现"],
    speaker: "小李",
    dialogue:
      '小李：“公务接待处理笺上来访人数填的6人，公务接待用餐清单中来访人数变成10人，陪同人数有5人，两份单子填的来访人数不一致，且陪同人数超过规定标准。”',
    continuity: "延续 S2-E1-01 的人物、服装、场景和关键道具。",
  } as never;
  const summary = summarizeShot(shot);
  assert.ok(summary.includes("6人"), "摘要应保留台词里的具体数字");
  assert.ok(summary.includes("10人"), "摘要应保留矛盾数字");
  assert.ok(summary.includes("处理笺"), "摘要应保留具体道具");
  assert.ok(!summary.includes("小李：“"), "摘要应去掉 speaker 前缀与引号");
  assert.ok(!summary.includes("说明核查发现"), "有具体台词时不应回退到空泛动作");
}
{
  const shot = {
    id: "S2-E1-01",
    title: "填写接待记录要规范",
    location: "场景设定：部门办公室门口，财务人员小李路过时顺便敲门进来，手里拿着平板，语气轻松。",
    action: ["财务人员小李路过时顺便敲门进来，手里拿着平板", "小李提出核实请求", "小李继续展示单据并说明数据"],
    speaker: "小李",
    dialogue:
      '小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”\n小李：“您看，这份公务接待报销总费用2250元。”',
    continuity: "同一案例内保持人物身份、服装、场景与关键凭证连续。",
  } as never;
  const summary = summarizeShot(shot);
  assert.ok(summary.includes("2250元"), "多句台词时应优先挑中带数字/对象的那句");
}
{
  const shot = {
    id: "S-X-01",
    title: "空泛台词 fallback",
    location: "场景设定：办公室里，审计员整理凭证。",
    action: ["审计员翻看凭证", "审计员抬头思考"],
    speaker: "审计员",
    dialogue: "本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。",
    continuity: "",
  } as never;
  const summary = summarizeShot(shot);
  assert.ok(summary.includes("办公室里"), "无有效台词时回退到场景");
  assert.ok(summary.includes("翻看凭证"), "无有效台词时回退到动作链");
}

// 2026-10-07（Layer 2）：用户举的第二个反例——「案例三在对白前有详细的动作描述，
// 需要单开分镜」。用的就是真实项目 S3-E1 的原文行形态：场景设定 + 空「画面：」
// 标签 + 两条 `action_or_narration` 前置动作 + 两条对白。
// 期望：前置动作独立成一镜（有电脑、凭证、新闻、处理笺这些关键道具与「打开」这类
// 状态变化），对白另成一镜；纯时空的场景行与空标签行都不贡献动作。
const detailedActionBeforeDialogue: ExtractedCase = {
  id: "S3-E1",
  group: "接待结算要及时",
  title: "接待结算要及时",
  sourceIds: [45, 46, 47, 48, 49, 50],
  dialogueCount: 2,
  storyboardCount: 2,
  note: "",
  items: [
    {
      sourceId: 45,
      type: "visual_direction",
      text: "场景设定：审计办公室，审计人员小赵翻看凭证，电脑上同时打开着单位内部信息平台的历史新闻。",
      estimatedSeconds: 0,
    },
    { sourceId: 46, type: "visual_direction", text: "画面：", estimatedSeconds: 0 },
    {
      sourceId: 47,
      type: "action_or_narration",
      text: "小赵看到一笔几年前的接待费用，最近才结算，跨度较长。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 48,
      type: "action_or_narration",
      text: "小赵又打开内部信息平台的历史新闻，发现处理笺和新闻对不上。",
      estimatedSeconds: 0,
    },
    {
      sourceId: 49,
      type: "dialogue",
      speaker: "小赵",
      text: "刘老师，有一笔前几年的接待费最近才结算，请您核实一下。",
      estimatedSeconds: 5,
    },
    {
      sourceId: 50,
      type: "dialogue",
      speaker: "刘主任",
      text: "因为间隔太久才报销，信息都记不清了，我们这就自查自纠。",
      estimatedSeconds: 6,
    },
  ],
};
const detailedActionShots = buildCaseShots(
  detailedActionBeforeDialogue,
  planCaseChunks(detailedActionBeforeDialogue),
);
assert.equal(detailedActionShots.length, 2, "对白前的详细动作描述必须单独成镜");
assert.equal(detailedActionShots[0].speaker, "无人物对白");
assert.ok(
  detailedActionShots[0].action.some((action) => action.includes("历史新闻")),
  "前置动作镜必须保留原文里的关键道具",
);
assert.ok(
  detailedActionShots[0].action.every((action) => !/^画面[：:]?$/u.test(action)),
  "只有字段标签没有内容的「画面：」行不得进动作链",
);
assert.ok(
  detailedActionShots.every((shot) =>
    shot.action.every((action) => !/^场景设定/u.test(action)),
  ),
  "场景行不得整句进动作链",
);
assert.ok(
  (detailedActionShots[0].estimatedSeconds ?? 0) >= MIN_SHOT_SECONDS - 0.001,
  "前置动作镜必须有正时长且不触发下限告警",
);

// 2026-10-07（回归 #10）：真实项目 `S1-E1-02` 曾走不通——提取器把「小陈温和地提醒」
// 里的舞台提示整段剥掉，对白镜没有任何可执行动作，`continuityVisualActions` 返回空，
// `normalizeVideoPromptBriefs` 以「缺少场景或动作」硬拒收。Layer 0 把提示找回来之后，
// 这条链路必须接通（校验本身仍然保持硬拒收，不放宽）。
const recoveredCueShot = buildCaseShots(cueDrivenSample, planCaseChunks(cueDrivenSample))[0];
assert.ok(
  continuityVisualActions(recoveredCueShot, recoveredCueShot.location).length > 0,
  "找回舞台提示后，对白镜必须能提供可执行动作",
);
assert.ok(
  recoveredCueShot.action.every((action) => !/^(?:进行说明|说明核查发现|提出询问)$/u.test(action)),
  "有真实动作时不得再写口播意向串",
);

console.log("shot planning checks passed");
