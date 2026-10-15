import assert from "node:assert/strict";
import {
  DEFERRED_STORYBOARD_RULE_VERSIONS,
  STORYBOARD_RULE_VERSION,
  mergeProjectSnapshots,
  migrateLegacyProjects,
  needsStoryboardRebuild,
  normalizeProjectSnapshot,
  normalizeWorkspaceSnapshot,
} from "./project-store.ts";
import { SPEECH_UNITS_PER_SECOND } from "./shot-planning.ts";

const snapshot = {
  schemaVersion: 1,
  id: "project-1",
  title: "审计科普视频",
  sourceFileName: "审计科普视频.docx",
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z",
  currentStage: "storyboard",
  workflowStage: "storyboard",
  selectedId: "S1-E1-01",
  selectedCaseId: "S1-E1",
  selectedImagePromptId: "S1-E1-01",
  scriptDrafts: [{ id: 1, kind: "meta", text: "标题：审计科普视频" }],
  caseDrafts: [{ id: "S1-E1" }],
  shotDrafts: [{ id: "S1-E1-01" }],
  imagePromptDrafts: [
    {
      id: "S1-E1-01",
      prompt:
        "画风参考。\n构图要求：采用比正常画面稍远一档的宽松中景或中全景，镜头适当后退。所有人物、手势和关键道具完整集中在画面中央，人物周围保留充足、连续的环境背景。\n16:9 横屏。",
    },
  ],
  scriptReview: {
    status: "PASS",
    checks: [],
    flags: [],
    issues: [],
  },
  extractionEngine: "脚本结构提取器",
  storyboardRuleVersion: "v1",
  uploadedNames: { "S1-E1-01": "参考图.jpg", invalid: 42 },
  history: [
    {
      id: "history-1",
      kind: "feedback",
      createdAt: "2026-08-09T10:01:00.000Z",
      title: "画面反馈",
      decision: "adopted",
    },
  ],
};

const normalized = normalizeProjectSnapshot(snapshot);
assert.equal(normalized.title, "审计科普视频");
assert.deepEqual(normalized.uploadedNames, {
  "S1-E1-01": "参考图.jpg",
});
assert.equal(normalized.history[0].decision, "adopted");
assert.equal(
  normalized.speechRate,
  SPEECH_UNITS_PER_SECOND,
  "旧项目补的默认口播节奏必须就是基线本身（2026-09-18 基线由 6 调为 5）",
);
assert.equal(SPEECH_UNITS_PER_SECOND, 5.5);
assert.equal(
  normalized.shotDrafts[0].storyboardConfirmed,
  false,
  "仍在分镜阶段的旧项目应保持待确认",
);
assert.equal(
  normalized.imagePromptDrafts[0].prompt,
  "画风参考。\n16:9 横屏。",
  "旧项目应自动移除为安全区裁切准备的构图提示",
);

const customPace = normalizeProjectSnapshot({ ...snapshot, speechRate: 4.8 });
assert.equal(customPace.speechRate, 4.8);

const progressedProject = normalizeProjectSnapshot({
  ...snapshot,
  workflowStage: "imagePrompt",
});
assert.equal(
  progressedProject.shotDrafts[0].storyboardConfirmed,
  false,
  "所在阶段不能代替人工确认，缺失确认字段必须待确认",
);
const explicitlyReopenedShot = normalizeProjectSnapshot({
  ...snapshot,
  workflowStage: "imagePrompt",
  shotDrafts: [{ id: "S1-E1-01", storyboardConfirmed: false }],
});
assert.equal(
  explicitlyReopenedShot.shotDrafts[0].storyboardConfirmed,
  false,
  "修改后明确撤销的确认状态不能被旧项目迁移覆盖",
);

const generationBoundaryMigration = normalizeProjectSnapshot({
  ...snapshot,
  extractionEngine: "脚本结构提取器 · 规则版本 1.3",
  scriptDrafts: [
    { id: 1, kind: "heading", text: "提示一：接待事项要真实" },
    { id: 2, kind: "action", text: "镜头/特效：" },
    { id: 3, kind: "action", text: "处理笺扫描件浮现，错误信息被红框圈出。" },
    { id: 4, kind: "note", text: "弹出绿色提示框：✅ 信息必须真实准确" },
    { id: 5, kind: "note", text: "字幕（屏幕文字）：" },
    { id: 6, kind: "note", text: "❌ 填报信息与实际不符" },
    { id: 7, kind: "dialogue", text: "审计员：请核对处理笺信息。" },
  ],
  shotDrafts: [{
    id: "S1-E1-01",
    // 真实形态：这些动作是从脚本条目机器生成的，所以整句精确匹配即可安全摘除。
    action: ["审计员请核对处理笺信息", "处理笺扫描件浮现，错误信息被红框圈出。"],
  }],
  caseDrafts: [{
    id: "S1-E1",
    group: "公务接待",
    title: "接待事项要真实",
    sourceIds: [1, 2, 3, 4, 5, 6, 7],
    dialogueCount: 1,
    storyboardCount: 1,
    note: "规则提取",
    items: [
      { sourceId: 2, type: "action_or_narration", text: "镜头/特效：", estimatedSeconds: 0 },
      { sourceId: 3, type: "action_or_narration", text: "处理笺扫描件浮现，错误信息被红框圈出。", estimatedSeconds: 0 },
      { sourceId: 4, type: "visual_note", text: "弹出绿色提示框：✅ 信息必须真实准确", estimatedSeconds: 0 },
      { sourceId: 5, type: "visual_note", text: "字幕（屏幕文字）：", estimatedSeconds: 0 },
      { sourceId: 6, type: "visual_note", text: "❌ 填报信息与实际不符", estimatedSeconds: 0 },
      { sourceId: 7, type: "dialogue", speaker: "审计员", text: "请核对处理笺信息。", estimatedSeconds: 2 },
    ],
  }],
  scriptReview: {
    status: "REVISE",
    checks: [{ label: "非生成内容排除", status: "PASS", detail: "旧说明" }],
    flags: ["第4段的案例范围已人工调整", "第7段说话人需要核对"],
    issues: [
      { message: "提示框待确认", sourceId: 4 },
      { message: "说话人待确认", sourceId: 7 },
    ],
  },
});
// 2026-10-07：迁移是递进的（<1.5 ⊂ <1.6 ⊂ <1.7），一次加载就补齐到最新规则语义，
// 因此 1.3 的项目迁完标 1.7，而不是停在它上一档的 1.6——否则下次加载会重复跑一遍回填。
assert.equal(generationBoundaryMigration.extractionEngine, "脚本结构提取器 · 规则版本 1.7");
assert.deepEqual(
  generationBoundaryMigration.caseDrafts[0].sourceIds,
  [1, 7],
  "旧项目应移除空特效标签、后期特效正文与提示框字幕，只保留可生成的标题与对白",
);
assert.deepEqual(
  generationBoundaryMigration.caseDrafts[0].items?.map((item) => item.sourceId),
  [7],
  "案例条目里不应再残留被判定为后期特效的段落",
);
assert.deepEqual(
  generationBoundaryMigration.scriptDrafts
    .filter((paragraph) => paragraph.kind === "summary")
    .map((paragraph) => paragraph.id),
  [4, 5, 6],
  "提示框与字幕仍归入非生成内容，不被重新打上后期特效标签",
);
assert.deepEqual(
  generationBoundaryMigration.scriptDrafts
    .filter((paragraph) => paragraph.kind === "effect")
    .map((paragraph) => paragraph.id),
  [2, 3],
  "空的特效标签和它下面的特效正文都应标记为后期特效",
);
assert.deepEqual(
  generationBoundaryMigration.shotDrafts[0].action,
  ["审计员请核对处理笺信息"],
  "已经落进分镜动作的后期特效句要被摘掉，真实动作保留",
);
assert.deepEqual(generationBoundaryMigration.scriptReview.flags, ["第7段说话人需要核对"]);
assert.deepEqual(
  generationBoundaryMigration.scriptReview.issues.map((issue) => issue.sourceId),
  [7],
);
assert.match(generationBoundaryMigration.scriptReview.checks[0].detail, /后期特效单独标记/u);

const effectOnlyActionMigration = normalizeProjectSnapshot({
  ...snapshot,
  extractionEngine: "脚本结构提取器 · 规则版本 1.5",
  scriptDrafts: [
    { id: 1, kind: "heading", text: "提示一：接待事项要真实" },
    { id: 2, kind: "action", text: "镜头/特效：" },
    { id: 3, kind: "action", text: "处理笺扫描件浮现，错误信息被红框圈出。" },
  ],
  caseDrafts: [{ id: "S1-E1", sourceIds: [1, 2, 3], items: [] }],
  shotDrafts: [{ id: "S1-E1-01", action: ["处理笺扫描件浮现，错误信息被红框圈出。"] }],
});
assert.deepEqual(
  effectOnlyActionMigration.shotDrafts[0].action,
  [],
  "唯一一条动作就是后期特效时也必须清掉，不能让脏内容继续进入画面词",
);

// ---------------------------------------------------------------------------
// 画面词是分镜的派生物：分镜被清理过，旧画面词就不能再继续被信任。
//
// 2026-09-18 端到端实测发现：迁移把脚本、案例、分镜动作都清干净了，**但已经写好的画面词
// 还带着「餐桌」**——而它正是这一轮要根治的那个缺陷。润色过的画面词无法用整句匹配摘除
// （原文「处理笺扫描件浮现在餐桌上方…」在画面词里已经被改写成「餐桌上方，处理笺」），
// 所以这里不猜内容，只认一条不变量：**源变了，派生物就重建。**
// ---------------------------------------------------------------------------
const stalePromptMigration = normalizeProjectSnapshot({
  ...snapshot,
  extractionEngine: "脚本结构提取器 · 规则版本 1.5",
  scriptDrafts: [
    { id: 1, kind: "heading", text: "提示一：接待事项要真实" },
    { id: 2, kind: "action", text: "镜头/特效：" },
    { id: 3, kind: "action", text: "处理笺扫描件浮现在餐桌上方，错误信息被红框圈出。" },
    { id: 4, kind: "dialogue", text: "审计员：请核对处理笺信息。" },
  ],
  caseDrafts: [{
    id: "S1-E1",
    group: "公务接待",
    title: "接待事项要真实",
    sourceIds: [1, 2, 3, 4],
    dialogueCount: 1,
    storyboardCount: 1,
    note: "规则提取",
    items: [
      { sourceId: 3, type: "action_or_narration", text: "处理笺扫描件浮现在餐桌上方，错误信息被红框圈出。", estimatedSeconds: 0 },
      { sourceId: 4, type: "dialogue", speaker: "审计员", text: "请核对处理笺信息。", estimatedSeconds: 2 },
    ],
  }],
  shotDrafts: [
    {
      id: "S1-E1-01",
      location: "场景设定：办公室里，审计员核对材料。",
      action: ["审计员请核对处理笺信息", "处理笺扫描件浮现在餐桌上方，错误信息被红框圈出。"],
    },
    {
      id: "S1-E1-02",
      location: "场景设定：办公室里。",
      action: ["审计员记录核对结果"],
    },
  ],
  imagePromptDrafts: [
    {
      id: "S1-E1-01",
      status: "missing",
      prompt: "16:9横屏，扁平线条画风。办公室里，审计员核对处理笺。餐桌上方，处理笺被红框圈出。",
      promptModel: "glm-4-flash-250414",
    },
    {
      id: "S1-E1-02",
      status: "ready",
      image: "data:image/png;base64,AAAA",
      prompt: "16:9横屏，扁平线条画风。办公室里，审计员在记录。",
      imageSourceSignature: "sig-2",
    },
  ],
  scriptReview: {
    status: "REVISE",
    checks: [{ label: "非生成内容排除", status: "PASS", detail: "旧说明" }],
    flags: [],
    issues: [],
  },
});

const cleanedPrompt = stalePromptMigration.imagePromptDrafts.find(
  (item) => item.id === "S1-E1-01",
);
const untouchedPrompt = stalePromptMigration.imagePromptDrafts.find(
  (item) => item.id === "S1-E1-02",
);
assert.ok(cleanedPrompt && untouchedPrompt, "两条画面词都要在");
assert.doesNotMatch(
  cleanedPrompt.prompt,
  /餐桌|红框圈出/u,
  "分镜被清理过 → 旧画面词必须重建，不能再带着已经移除的内容",
);
assert.match(
  cleanedPrompt.prompt,
  /办公室里/u,
  "重建后的画面词仍要基于清理后的分镜（地点保留）",
);
assert.equal(
  cleanedPrompt.promptModel,
  undefined,
  "重建出来的是模板，不能再标成「模型润色过」",
);
assert.equal(
  untouchedPrompt.prompt,
  "16:9横屏，扁平线条画风。办公室里，审计员在记录。",
  "没被清理的镜头，画面词一字不动（不能顺手全量重建）",
);
assert.equal(untouchedPrompt.image, "data:image/png;base64,AAAA", "已采用的图不因迁移丢失");
assert.equal(untouchedPrompt.imageSourceSignature, "sig-2");

const older = normalizeProjectSnapshot({
  ...snapshot,
  updatedAt: "2026-08-09T09:00:00.000Z",
  title: "旧标题",
});
assert.deepEqual(
  mergeProjectSnapshots([normalized], [older]).map((project) => project.title),
  ["审计科普视频"],
);

assert.throws(
  () => normalizeProjectSnapshot({ ...snapshot, workflowStage: "unknown" }),
  /生产进度/u,
);

const workspace = normalizeWorkspaceSnapshot({
  schemaVersion: 2,
  activeProjectId: "project-1",
  projects: [snapshot],
  rules: [],
  assets: [],
});
assert.equal(workspace.activeProjectId, "project-1");
assert.equal(workspace.projects.length, 1);
assert.throws(
  () => normalizeProjectSnapshot({ ...snapshot, scriptReview: null }),
  /脚本审查记录/u,
);
assert.throws(
  () => normalizeProjectSnapshot({ ...snapshot, schemaVersion: 99 }),
  /更新版本/u,
);

// ---------------------------------------------------------------------------
// 加载时要不要按新规则重建分镜（2026-10-08）。
//
// 这条判断决定用户打开项目时，「已经确认过的分镜和已经采用的图」会被重建一次、
// 还是原样保留。误判的代价是单向的：重建会按内容身份尽量找回素材，但找不回的
// 那几镜会退回待确认——所以每一条放行条件都必须能被单独说清。
//
// 用户 2026-10-08 的两条裁定各自对应一个用例：
// ① 「提升版本号，加载时自动迁移」→ 落后版本的项目必须被放行重建；
// ② 「先只动公务接待费，加班餐暂时不迁移」→ 加班餐那一期的规则版本必须被拦住。
// ---------------------------------------------------------------------------
const ruleVersion = (storyboardRuleVersion: string, extractionEngine: string) => ({
  storyboardRuleVersion,
  extractionEngine,
});

assert.equal(
  STORYBOARD_RULE_VERSION,
  "semantic-action-chain-v10",
  "规则版本号是重建的开关本身，改它等于让全部存量项目重跑一次迁移",
);
assert.deepEqual(
  [...DEFERRED_STORYBOARD_RULE_VERSIONS],
  ["approved-sample-speed-v5"],
  "暂缓名单当前只该有加班餐那一期的规则版本；加一条就等于多冻结一个项目",
);

assert.equal(
  needsStoryboardRebuild(ruleVersion("v1", "脚本结构提取器")),
  true,
  "版本落后的项目要放行走新规则（用户裁定：提升版本号，加载时自动迁移）",
);
assert.equal(
  needsStoryboardRebuild(ruleVersion("", "脚本结构提取器 · 规则版本 1.6")),
  true,
  "连版本号都没有的老项目一定不是新规则产出的，同样要迁移",
);
assert.equal(
  needsStoryboardRebuild(ruleVersion(STORYBOARD_RULE_VERSION, "脚本结构提取器 · 规则版本 1.7")),
  false,
  "已经是当前规则版本的项目重复打开不能被重建一次（幂等）",
);
assert.equal(
  needsStoryboardRebuild(ruleVersion("approved-sample-speed-v5", "脚本结构提取器 · 规则版本 1.6")),
  false,
  "加班餐那一期按用户裁定暂不迁移，否则 6 镜会一次拆到 11 镜",
);
assert.equal(
  needsStoryboardRebuild(ruleVersion("semantic-action-chain-v8", "脚本结构提取器 · 已审查归档")),
  false,
  "归档产物的分镜是冻结的，任何自动迁移都要避开",
);
assert.equal(
  needsStoryboardRebuild(ruleVersion("semantic-action-chain-v8", "")),
  false,
  "没有提取器记录的项目不是工作台产出的，不重建",
);

// 已有服务端项目时，登录不得访问旧 IndexedDB、重新导入已删除项目。
const originalFetch = globalThis.fetch;
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
let legacyDatabaseReads = 0;
const workspaceRequests: string[] = [];
try {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      legacyDatabaseReads += 1;
      throw new Error("旧浏览器项目不应再被自动读取");
    },
  });
  globalThis.fetch = async (_input, init) => {
    workspaceRequests.push(init?.method ?? "GET");
    return Response.json({ projects: [snapshot], activeProjectId: snapshot.id, rules: [], assets: [] });
  };
  const remaining = await migrateLegacyProjects("deleted-project");
  assert.deepEqual(remaining.projects.map((project) => project.id), [snapshot.id]);
  assert.equal(remaining.activeProjectId, snapshot.id);
  assert.equal(legacyDatabaseReads, 0);
  assert.deepEqual(workspaceRequests, ["GET"]);
} finally {
  globalThis.fetch = originalFetch;
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
}

console.log("project snapshot checks passed");
