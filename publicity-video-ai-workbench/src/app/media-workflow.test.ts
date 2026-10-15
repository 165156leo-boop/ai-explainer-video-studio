import assert from "node:assert/strict";
import {
  canUseVideoPromptForShot,
  candidateMatchesSelectedImage,
  chooseProviderAccount,
  imageRetrySourcePrompt,
  inheritShotAssets,
  makeShotConfirmedSnapshot,
  needsProviderHistoryCheck,
  normalizeMediaJob,
  normalizeImageRetryPrompt,
  normalizeProviderBaseUrl,
  referenceImageStale,
  safeProjectSegment,
  shotBriefLabel,
  shotCaseId,
  shotConfirmedChanges,
  shotContentIdentity,
  shotDisplayLabel,
  shotDisplayNumber,
  shotVisualSignature,
  tailFrameEnhancementInstruction,
  upstreamProviderFailure,
} from "./media-workflow.ts";
import type { InheritableShot } from "./media-workflow.ts";

const videoReferences = [
  { id: "S1-E1-01", status: "ready" as const, image: "data:image/png;base64,ready" },
  { id: "S1-E1-02", status: "missing" as const },
];
assert.equal(
  canUseVideoPromptForShot(
    { id: "S1-E1-01", storyboardConfirmed: true },
    videoReferences,
  ),
  true,
);
assert.equal(
  canUseVideoPromptForShot(
    { id: "S1-E1-02", storyboardConfirmed: true },
    videoReferences,
  ),
  false,
);
assert.equal(
  canUseVideoPromptForShot(
    { id: "S1-E1-01", storyboardConfirmed: false },
    videoReferences,
  ),
  false,
);
assert.equal(
  canUseVideoPromptForShot(
    {
      id: "S1-E1-03",
      storyboardConfirmed: true,
      status: "ready",
      image: "data:image/png;base64,legacy-ready",
    },
    videoReferences,
  ),
  true,
);

// 2026-09-16 晚：分镜 → 参考图级联失效（过期判定 / 视觉签名 / 确认快照差异）。
const visualShot = {
  speaker: "小陈",
  location: "办公室内，办公桌前",
  action: ["指向文件", "倾听回应"],
  continuity: "接上一镜站位",
  dialogue: "王老师，学院在三年前报销了几笔公务接待费用。",
};
const signature = shotVisualSignature(visualShot);
assert.equal(shotVisualSignature({ ...visualShot }), signature);
// 对白不影响画面——改对白不判过期
assert.equal(shotVisualSignature({ ...visualShot, dialogue: "改成另一句台词" }), signature);
// 画面字段一变即签名变化
assert.notEqual(shotVisualSignature({ ...visualShot, location: "会议室" }), signature);
assert.notEqual(shotVisualSignature({ ...visualShot, action: ["移动物品"] }), signature);

assert.equal(referenceImageStale(visualShot, { image: "data:image/png;base64,x", imageSourceSignature: signature }), false);
assert.equal(
  referenceImageStale(
    { ...visualShot, location: "会议室" },
    { image: "data:image/png;base64,x", imageSourceSignature: signature },
  ),
  true,
);
// 存量数据兼容：没有签名的已采用图不判过期（确认分镜时会补签）
assert.equal(referenceImageStale(visualShot, { image: "data:image/png;base64,x" }), false);
assert.equal(referenceImageStale(visualShot, undefined), false);
assert.equal(referenceImageStale(visualShot, { imageSourceSignature: signature }), false);

const tailEnhancement = tailFrameEnhancementInstruction("S2-E1-01");
assert.match(tailEnhancement, /第 1 张参考图（上一镜 S2-E1-01 验收视频的尾帧）/u);
assert.match(tailEnhancement, /静态首帧连续性高清重绘/u);
assert.match(tailEnhancement, /修复视频压缩、运动模糊、锯齿和细节涂抹/u);
assert.match(tailEnhancement, /不得添加、删除、复制或移动任何人物与物体/u);
assert.match(tailEnhancement, /本镜动作只在后续视频提示词中执行/u);
assert.doesNotMatch(tailEnhancement, /再按本镜动作起点只做最小必要变化/u);

// 确认快照：能列出上次确认后改了哪些字段
const baseShot = { ...visualShot, estimatedSeconds: 15, videoSecondsOverride: 15 };
const snapshotShot = {
  ...baseShot,
  confirmedSnapshot: makeShotConfirmedSnapshot(baseShot),
};
assert.deepEqual(shotConfirmedChanges(snapshotShot), []);
assert.deepEqual(
  shotConfirmedChanges({
    ...snapshotShot,
    dialogue: "改过的对白",
    videoSecondsOverride: 10,
    action: ["新增动作"],
  }),
  ["动作", "对白", "视频时长"],
);
// 无快照（从未确认 / 旧数据）返回空
assert.deepEqual(shotConfirmedChanges(visualShot), []);

// 2026-10-07（Layer 1）：内容身份配对。
//
// 用户实测反馈的 bug：加入「空白动作分镜」之后，此前确认过的分镜全部对不上，
// 旧图与确认状态跟着错绑。原话：「确认的分镜生成内容不能光按照分镜名字对应，
// 而是内容对应，改名还能找到。」根因是 `shot.id` 同时被当成内容身份使用。
// 下面四条用例分别守住这条诉求的四个形态。
const contentShots: InheritableShot[] = [
  {
    id: "S1-E1-01",
    caseId: "S1-E1",
    dialogue: "小陈：“核实时发现处理笺上的来访人员没有来。”",
    image: "data:image/png;base64,first",
    status: "ready",
    storyboardConfirmed: true,
    confirmedSnapshot: "snapshot-first",
    sourceItems: [{ sourceId: 14, type: "dialogue" }],
  },
  {
    id: "S1-E1-02",
    caseId: "S1-E1",
    dialogue: "王老师：“我们没做好记录。”",
    image: "data:image/png;base64,second",
    status: "ready",
    storyboardConfirmed: true,
    sourceItems: [{ sourceId: 15, type: "dialogue" }],
  },
];

// ① 只改标题（改名）——图和确认状态必须继续跟着走。
const renamed = inheritShotAssets(
  contentShots.map((shot) => ({ ...shot, title: "换过的标题" })),
  contentShots,
);
assert.ok(
  renamed.every((entry) => entry.exact && entry.idKept),
  "只改标题不得改变内容身份",
);
assert.deepEqual(
  renamed.map((entry) => entry.shot.storyboardConfirmed),
  [true, true],
  "改名后确认状态必须保留",
);
assert.deepEqual(
  renamed.map((entry) => entry.shot.image),
  ["data:image/png;base64,first", "data:image/png;base64,second"],
  "改名后图片必须保留",
);

// ② 在中间插入一个空白动作镜——其余分镜的图、确认状态和**编号**都不许动。
const withInsert: InheritableShot[] = [
  contentShots[0],
  {
    id: "S1-E1-02",
    caseId: "S1-E1",
    dialogue: "本镜无人物对白；原旁白只用于理解画面，不生成旁白音频。",
    status: "missing",
    sourceItems: [{ sourceId: 16, type: "visual_direction" }],
  },
  contentShots[1],
];
const inserted = inheritShotAssets(withInsert, contentShots);
assert.deepEqual(
  inserted.map((entry) => entry.shot.id),
  ["S1-E1-01", "S1-E1-03", "S1-E1-02"],
  "插入一镜时新镜领空闲编号，旧镜编号不动（图与媒体任务都挂在上面）",
);
assert.deepEqual(
  inserted.map((entry) => entry.shot.storyboardConfirmed),
  [true, false, true],
  "新插入的镜保持待确认，旧镜确认状态不动",
);
assert.deepEqual(
  inserted.map((entry) => entry.shot.image),
  ["data:image/png;base64,first", undefined, "data:image/png;base64,second"],
);

// ③ 一旧镜拆成两镜：图只给更接近原镜的前一半，后一半回到待确认（不复制素材）。
const twoRowShot: InheritableShot = {
  id: "S1-E1-04",
  caseId: "S1-E1",
  dialogue: "小陈：“核实时发现处理笺上的来访人员没有来。”\n王老师：“我们没做好记录。”",
  image: "data:image/png;base64,pair",
  status: "ready",
  storyboardConfirmed: true,
  imageSourceSignature: '["小陈 → 王老师","办公室",["两个人在对话"],"接上一镜"]',
  sourceItems: [
    { sourceId: 14, type: "dialogue" },
    { sourceId: 15, type: "dialogue" },
  ],
};
const [splitA, splitB] = inheritShotAssets(
  [
    {
      id: "S1-E1-04",
      caseId: "S1-E1",
      dialogue: "小陈：“核实时发现处理笺上的来访人员没有来。”",
      status: "missing",
      sourceItems: [{ sourceId: 14, type: "dialogue" }],
    },
    {
      id: "S1-E1-05",
      caseId: "S1-E1",
      dialogue: "王老师：“我们没做好记录。”",
      status: "missing",
      sourceItems: [{ sourceId: 15, type: "dialogue" }],
    },
  ] satisfies InheritableShot[],
  [twoRowShot],
);
assert.equal(splitA.shot.image, "data:image/png;base64,pair", "拆分后前一半继承原图的素材");
assert.equal(splitB.shot.image, undefined, "拆分产生的另一半不得复制同一张图");
assert.equal(
  splitA.shot.storyboardConfirmed,
  false,
  "内容已经变了（拆分），不能沿用「已确认」——那是放行一镜没人看过的画面",
);
assert.equal(
  splitA.shot.imageSourceSignature,
  twoRowShot.imageSourceSignature,
  "同来源但不同内容的继承必须保留旧签名，让界面继续提示「这张图已过期」",
);

// ④ 两旧镜合并成一镜：来源冲突时不自动继承，留给用户判断。
const merged = inheritShotAssets(
  [
    {
      id: "S1-E1-01",
      caseId: "S1-E1",
      dialogue: "小陈：“核实时发现处理笺上的来访人员没有来。”\n王老师：“我们没做好记录。”",
      status: "missing",
      sourceItems: [
        { sourceId: 14, type: "dialogue" },
        { sourceId: 15, type: "dialogue" },
      ],
    },
  ] satisfies InheritableShot[],
  contentShots,
);
assert.equal(
  merged[0].shot.image,
  undefined,
  "合并后含有旧镜从未拍到的内容，不猜素材归属",
);
assert.equal(merged[0].shot.storyboardConfirmed, false);

// ⑤ 旧镜没配对上（内容变了）时，它的编号**不能被新镜捡走**。
// 这是 ①—④ 之外最容易漏的一种：旧镜回到待确认，但它的图片与画面词仍按旧编号索引，
// 新镜一旦沿用同一个号，页面就会把旧图装到新内容上，而且因为新镜是「待确认」，
// 界面上看不出任何异常。真实数据里 S2-E1-01（加班餐项目）就是这个形态。
const orphanedOld: InheritableShot[] = [{
  id: "S2-E1-01",
  caseId: "S2-E1",
  dialogue: "审计人员A：“这笔加班餐费发票对应的餐厅离学校有15公里。”",
  status: "missing",
  storyboardConfirmed: true,
  sourceItems: [{ sourceId: 22, type: "dialogue" }],
}];
const unrelated = inheritShotAssets(
  [
    {
      id: "S2-E1-01",
      caseId: "S2-E1",
      dialogue: "两名审计人员坐在办公桌前，桌上放着装订好的财务凭证。",
      status: "missing",
      sourceItems: [{ sourceId: 28, type: "visual_direction" }],
    },
  ] satisfies InheritableShot[],
  orphanedOld,
);
assert.equal(unrelated[0].previousIndex, -1, "内容完全不同，不该配对");
assert.notEqual(
  unrelated[0].shot.id,
  "S2-E1-01",
  "没配对上的新镜不得沿用未配对旧镜的编号——那个号后面还挂着旧图和旧画面词",
);

assert.equal(
  shotContentIdentity({ sourceItems: [{ sourceId: 14, type: "dialogue" }], dialogue: '小陈：“甲”' }),
  shotContentIdentity({ sourceItems: [{ sourceId: 14, type: "dialogue" }], dialogue: '小陈：“甲”' }),
);
assert.notEqual(
  shotContentIdentity({ sourceItems: [{ sourceId: 14, type: "dialogue" }] }),
  shotContentIdentity({ sourceItems: [{ sourceId: 15, type: "dialogue" }] }),
  "内容身份必须由原文行决定，而不是由分镜名字",
);

// 2026-10-08 用户拍板：对外展示统一用「案例号 + 案例内顺序号」，内部键一律不动。
// 真实数据里 `S1-E1` 案例的内部键是 `S1-E1-04` 在前、`S1-E1-03` 在后（插入分镜后留的
// 缺口），展示必须按顺序给 01、02，不能把内部键原样端出去。
//
// 同日二轮：改用下划线 `S1-E1_01`——用户追问过「内部编号和外部编号用同一种编码方式，
// 但最后的数字含义不同，是否需要区分」，所以定成**形式上不可能同形**：内部键恒为两个
// 连字符，展示编号是「连字符 + 下划线」。
const outOfOrderCase = [
  { id: "S1-E1-04" },
  { id: "S1-E1-03" },
  { id: "S2-E1-01" },
  { id: "S2-E1-02" },
];
assert.equal(
  shotDisplayLabel(outOfOrderCase, "S1-E1-04"),
  "S1-E1_01",
  "对外编号按案例内顺序给，与内部键的序号无关",
);
assert.equal(shotDisplayLabel(outOfOrderCase, "S1-E1-03"), "S1-E1_02");
assert.equal(shotDisplayLabel(outOfOrderCase, "S2-E1-01"), "S2-E1_01");
assert.equal(shotDisplayLabel(outOfOrderCase, "S2-E1-02"), "S2-E1_02");
assert.equal(
  shotDisplayNumber(outOfOrderCase, "S2-E1-02"),
  2,
  "顺序号按案例重置",
);
assert.equal(
  shotDisplayLabel([{ id: "S9-E3-07" }], "S9-E3-07"),
  "S9-E3_01",
  "案例内只有一镜时展示 01——即使内部键的序号是 07，人看到的是「本案例第一镜」",
);
assert.equal(
  shotDisplayLabel(outOfOrderCase, "all-image-prompts"),
  "all-image-prompts",
  "历史条目里的非分镜键（批次名、源文件名、已删镜的旧编号）必须原样回退，不能崩也不该被改写",
);
assert.equal(shotDisplayNumber(outOfOrderCase, "S3-E1-01"), undefined);

// 这是 2026-10-08 二轮真正要买到的不变量：展示编号与内部键**在任何数据下都不可能相等**。
// 相等就意味着用户抄下来的编号可以直接去当键用，而那正是上一轮混乱的来源
// （`findContinuityReferenceShot` 会把它解析到别的镜）。
for (const shot of outOfOrderCase) {
  assert.notEqual(
    shotDisplayLabel(outOfOrderCase, shot.id),
    shot.id,
    `展示编号不得与内部键同形（${shot.id}）`,
  );
}
assert.match(
  shotDisplayLabel(outOfOrderCase, "S1-E1-04"),
  /^S\d+-E\d+_\d{2}$/u,
  "展示编号的形态：案例号（连字符）+ 下划线 + 两位顺序号",
);

// `shotCaseId` 要同时吃「带 caseId」和「只能从 id 前缀切」两种存量分镜——这段表达式
// 原本在 page.tsx 里重复了六处，替换时必须行为一致。
assert.equal(shotCaseId({ id: "S1-E1-04" }), "S1-E1");
assert.equal(shotCaseId({ id: "S1-E1-04", caseId: "S1-E1" }), "S1-E1");
assert.equal(
  shotCaseId({ id: "S1-E1-04", caseId: "S2-E9" }),
  "S2-E9",
  "显式 caseId 优先于从 id 切出来的前缀",
);

// 胶片条第二行：同一案例内每一镜的 title 完全相同，只有人物与动作能区分本镜。
assert.equal(
  shotBriefLabel({ speaker: "小陈 → 王老师", action: ["小陈对王老师说明核查发现"] }),
  "小陈 → 王老师 · 小陈对王老师说明核查发现",
);
assert.equal(shotBriefLabel({ action: ["王老师一愣"] }), "王老师一愣");
assert.equal(shotBriefLabel({ speaker: "无人物对白" }), "无人物对白");
assert.equal(shotBriefLabel({}), "");
assert.equal(shotBriefLabel({ speaker: "  ", action: ["  "] }), "");
assert.equal(
  shotBriefLabel({ speaker: "小陈", action: ["甲".repeat(80)] }).length,
  60,
  "过长的简述要截断，否则胶片条第二行会被撑破",
);

assert.equal(normalizeProviderBaseUrl("http://127.0.0.1:8011/"), "http://127.0.0.1:8011");
assert.throws(() => normalizeProviderBaseUrl("https://example.com"), /只允许连接本机/u);
assert.equal(safeProjectSegment('酬金发放：雷区/测试?'), "酬金发放：雷区-测试-");
assert.throws(() => safeProjectSegment("..."), /项目名称/u);

const job = normalizeMediaJob({
  id: "job-1",
  projectId: "project-1",
  projectTitle: "测试项目",
  targetId: "S1-E1-01",
  mediaType: "image",
  accountId: "account-a",
  promptSnapshot: "提示词",
  status: "succeeded",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:01.000Z",
  candidates: [{ id: "candidate-1", fileName: "1.png", mimeType: "image/png" }],
});

assert.equal(job.candidates[0].status, "pending");
assert.equal(job.mediaType, "image");
assert.equal(
  job.targetLabel,
  undefined,
  "旧任务没有展示编号，读取时保持 undefined，界面回退 targetId",
);
assert.equal(
  normalizeMediaJob({ ...job, targetId: "S1-E1-04", targetLabel: "S1-E1-01" }).targetLabel,
  "S1-E1-01",
  "展示编号随任务落盘——服务端拿不到分镜列表，自己算不出顺序号",
);
assert.equal(
  normalizeMediaJob({
    ...job,
    mediaType: "video",
    errorCode: "MEDIA_JOB_FAILED",
    errorMessage: "豆包任务已提交，但没有取得可验证的媒体文件；请先核对豆包历史",
  }).errorCode,
  "ARTIFACT_NOT_AVAILABLE",
);

// 本地链路中断（历史记录里的原始 undici 文本）必须被还原成“状态不明确”，
// 否则界面只会显示一句英文超时并给出无保护的“重新生成”，导致重复消耗豆包额度。
const transportFailure = normalizeMediaJob({
  ...job,
  mediaType: "video",
  status: "failed",
  errorCode: "MEDIA_JOB_FAILED",
  errorMessage: "The operation was aborted due to timeout",
});
assert.equal(transportFailure.errorCode, "PROVIDER_STATUS_UNREACHABLE");
assert.match(transportFailure.errorMessage ?? "", /请先到豆包历史记录核对/u);
assert.equal(needsProviderHistoryCheck(transportFailure.errorCode), true);
assert.equal(needsProviderHistoryCheck("ARTIFACT_NOT_AVAILABLE"), true);
assert.equal(needsProviderHistoryCheck("GENERATION_TIMEOUT"), true);
assert.equal(needsProviderHistoryCheck("SUBMISSION_UNCERTAIN"), true);
assert.equal(needsProviderHistoryCheck("VIDEO_CONFIRM_NOT_TAKEN"), true);
assert.equal(needsProviderHistoryCheck("PROVIDER_RESTARTED_DURING_JOB"), true);
assert.equal(needsProviderHistoryCheck("LOCAL_PROVIDER_RESTARTED"), true);
assert.equal(needsProviderHistoryCheck(undefined), false);
// 明确的上游失败码仍然原样回传，不被二次推断。
assert.equal(
  normalizeMediaJob({
    ...job,
    errorCode: "DOUBAO_LOGIN_REQUIRED",
    errorMessage: "豆包账号未登录，请先在配置中登录",
  }).errorCode,
  "DOUBAO_LOGIN_REQUIRED",
);
assert.equal(
  normalizeMediaJob({
    ...job,
    errorCode: "DOUBAO_LOGIN_REQUIRED",
    errorMessage: "豆包账号未登录，请先在配置中登录",
  }).errorMessage,
  "豆包账号未登录，请先在配置中登录",
);
assert.equal(
  candidateMatchesSelectedImage(job, job.candidates[0], {
    jobId: "job-1",
    candidateId: "candidate-1",
  }),
  true,
);
assert.equal(
  candidateMatchesSelectedImage(job, job.candidates[0], {
    jobId: "job-1",
    candidateId: "candidate-2",
  }, "豆包候选 · 1.png"),
  false,
);
assert.equal(
  candidateMatchesSelectedImage(
    job,
    job.candidates[0],
    undefined,
    "豆包候选 · 1.png",
  ),
  true,
);
assert.equal(
  candidateMatchesSelectedImage(
    job,
    job.candidates[0],
    undefined,
    "本机上传 · replacement.png",
  ),
  false,
);

assert.equal(
  imageRetrySourcePrompt(
    "基础画面词。\n针对上一轮候选的重试修正，必须优先遵守：\n1. 人物离镜头太远",
  ),
  "基础画面词。",
);
assert.equal(
  imageRetrySourcePrompt("基础画面词。\n本次已上传上一镜 S1-E1-01 的已选图作为连续性参考。"),
  "基础画面词。",
);
assert.equal(
  normalizeImageRetryPrompt({
    prompt: "16:9 横屏，剪映式扁平线条插画风格。办公室内，两位人物采用中景对话构图，审计人员将文件置于桌面中央并明确指向关键凭证，对方自然注视文件。",
  }),
  "16:9 横屏，剪映式扁平线条插画风格。办公室内，两位人物采用中景对话构图，审计人员将文件置于桌面中央并明确指向关键凭证，对方自然注视文件。",
);
assert.throws(
  () => normalizeImageRetryPrompt({ prompt: "根据用户反馈，这是上一轮候选的修改结果，人物靠近一些并保持办公室场景。" }),
  /内部分析说明/u,
);

assert.deepEqual(
  upstreamProviderFailure({
    error_code: "ARTIFACT_NOT_AVAILABLE",
    error_message: "请先核对豆包历史",
    http_status: 502,
  }),
  {
    code: "ARTIFACT_NOT_AVAILABLE",
    message: "请先核对豆包历史",
    status: 502,
  },
);

const accounts = [
  { id: "account-a", alias: "账号 A", enabled: true, loginStatus: "logged_in" as const },
  { id: "account-b", alias: "账号 B", enabled: true, loginStatus: "logged_in" as const },
];
assert.equal(chooseProviderAccount(accounts, [])?.id, "account-a");
assert.equal(
  chooseProviderAccount(accounts, [
    { accountId: "account-a", status: "running", createdAt: "2026-09-07T00:00:00.000Z" },
  ])?.id,
  "account-b",
);
assert.equal(
  chooseProviderAccount(
    [{ ...accounts[0], quotaBalance: 0 }, accounts[1]],
    [],
  )?.id,
  "account-b",
);

// 2026-09-16：豆包免费账号的视频额度按秒发放（每天约 50 秒 = 10 个 5 秒单位），
// 消耗按视频秒数计——所以「额度够不够」要按这一镜的时长判断。
// 剩 5 秒的账号做不了 15 秒镜头，但做得了 5 秒镜头，不能一刀切跳过。
const quotaAccounts = [
  { ...accounts[0], videoQuotaRemainingSeconds: 5 },
  { ...accounts[1], videoQuotaRemainingSeconds: 50 },
];
assert.equal(
  chooseProviderAccount(quotaAccounts, [], 15)?.id,
  "account-b",
  "15 秒镜头必须跳过只剩 5 秒的账号",
);
assert.equal(
  chooseProviderAccount(quotaAccounts, [], 5)?.id,
  "account-a",
  "5 秒镜头仍然可以用只剩 5 秒的账号（它并未被额度排除）",
);
assert.equal(
  chooseProviderAccount([{ ...accounts[0], videoQuotaRemainingSeconds: 0 }], [], 5),
  undefined,
  "剩 0 秒时任何时长都不分配",
);
assert.equal(
  chooseProviderAccount([{ ...accounts[0], videoQuotaRemainingSeconds: 0 }], [], 0)?.id,
  "account-a",
  "图片任务（0 秒）不受视频额度限制",
);
assert.equal(
  chooseProviderAccount([accounts[0]], [], 15)?.id,
  "account-a",
  "额度尚未上报时不能把可用账号误判为不可用",
);
console.log("media workflow checks passed");
