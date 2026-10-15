// Canonical demo data used by the current workbench.

import { buildVideoPromptText } from "./video-prompt.ts";

export type StageKey =
  | "script"
  | "cases"
  | "scriptReview"
  | "storyboard"
  | "imagePrompt"
  | "reference"
  | "videoPrompt";
type ShotStatus = "ready" | "missing";

export type Shot = {
  id: string;
  caseId?: string;
  referenceId?: string;
  /**
   * 展示编号（1、2、3…），只由这一镜在本案例内的顺序决定。
   *
   * 2026-10-07 之前界面直接把 `shot.id`（`S1-E1-01`）当镜号显示，而 `id` 同时
   * 又是画面词与媒体任务的键、还被当成内容身份——插入一个分镜就让后面全部重新
   * 编号，用户已确认的图和确认状态随之错绑。现在三者拆开：
   * `shotNumber` 只负责显示，`id` 只做稳定句柄，内容身份走
   * `media-workflow.ts` 的 `shotContentIdentity`。
   */
  shotNumber?: number;
  title: string;
  chapter: string;
  image?: string;
  /** 参考图采用时的画面签名；重建时沿用旧签名，不能把过期图片标成有效。 */
  imageSourceSignature?: string;
  status: ShotStatus;
  storyboardConfirmed?: boolean;
  speaker: string;
  location: string;
  dialogue: string;
  action: string[];
  continuity: string;
  /**
   * 2026-09-16 晚：确认分镜时的字段快照（makeShotConfirmedSnapshot）。
   * 用于在确认被修改重置后，向用户列出「上次确认后改了哪些字段」。
   */
  confirmedSnapshot?: string;
  estimatedSeconds?: number;
  /** 手动指定的视频目标时长档位（5/10/15 秒）；写入提示词并作为提交参数。 */
  videoSecondsOverride?: number;
  /** 2026-09-16：逐镜覆盖的视频模型（缺省时用项目默认）。 */
  videoModel?: string;
  speechRateOverride?: number;
  sourceItems?: ExtractedCaseItem[];
  planningNote?: string;
  prompt: {
    reference: string;
    action: string;
    dialogue: string;
    constraints: string;
  };
  /**
   * 文本模型润色后的视频词（2026-09-17 镜头时序结构：镜头1 开场空镜 / 镜头2 主体表演+{}台词 /
   * 镜头3 收尾空镜）。description/direction 为旧格式字段，仅为兼容存量数据保留读取；
   * 未润色时提交走官方镜头时序模板兜底。
   */
  videoPromptPolished?: {
    script?: string;
    /** @deprecated 旧两段结构，读取时与 direction 拼接降级为 script。 */
    description?: string;
    /** @deprecated 旧两段结构，读取时与 description 拼接降级为 script。 */
    direction?: string;
    model?: string;
    updatedAt?: string;
    identityNote?: string;
    identityStatus?: "not-needed" | "matched" | "uncertain" | "unavailable";
    /**
     * 2026-10-08：生成这份润色稿时所依据的素材签名（见 `polish-digest.ts`）。
     *
     * 这是「素材没变就别重润」那道路闸的**落盘**版本。此前只有 `page.tsx` 内存里的
     * `Map`，刷新页面即清空，于是每次打开项目都把全部可用镜头重润一遍、重弹一遍。
     * 存量稿没有这个字段 → 判定退回内存那一路（同一次会话内不重复润），
     * 下一次真正润色时会自动补写上。
     */
    sourceSignature?: string;
  };
  /**
   * 2026-09-17 尾帧链：本镜候选视频验收通过后抽取的结尾画面（JPEG dataURL）。
   * 下一镜提交视频时自动作为参考图（优先级低于手动采用的分镜图），
   * 同案例内只需为首镜生成参考图，后续镜直接接上一镜尾帧。
   */
  videoLastFrame?: string;
  /** 抽取尾帧时的视觉签名；与当前分镜签名不符说明尾帧已过期，链路自动失效。 */
  videoLastFrameSignature?: string;
};

export const stages: {
  key: StageKey;
  label: string;
  short: string;
  detail: string;
  state: string;
  version: string;
  source: string;
  output: string;
}[] = [
  {
    key: "script",
    label: "脚本导入",
    short: "导入",
    detail: "原始 Word · 63 段",
    state: "done",
    version: "原始文件",
    source: "酬金发放，这些雷区不要踩.docx",
    output: "完整原文与段落编号",
  },
  {
    key: "cases",
    label: "案例提取",
    short: "提取",
    detail: "6 个最小案例",
    state: "done",
    version: "提取 V2",
    source: "原始 Word",
    output: "3 个主题 · 6 个最小案例",
  },
  {
    key: "scriptReview",
    label: "脚本审查",
    short: "脚本审查",
    detail: "自动文字审查 · PASS",
    state: "done",
    version: "审查 R2",
    source: "机器提取草稿",
    output: "15 句对白全部覆盖",
  },
  {
    key: "storyboard",
    label: "分镜审查",
    short: "分镜",
    detail: "8 个视频镜头 · PASS",
    state: "done",
    version: "分镜 V5.3",
    source: "故事段生产单",
    output: "6 个案例拆为 8 个镜头",
  },
  {
    key: "imagePrompt",
    label: "画面提示词",
    short: "画面词",
    detail: "7 个基础画面包",
    state: "done",
    version: "提示词 V13.1",
    source: "豆包首帧提示词生产单",
    output: "7 条基础画面提示词",
  },
  {
    key: "videoPrompt",
    label: "视频提示词",
    short: "视频词",
    detail: "8 条已生成 · 待补图后提交",
    state: "active",
    version: "视频词 V5",
    source: "分镜 V5.3 + 参考图",
    output: "8 条四段式视频提示词",
  },
];

export const shots: Shot[] = [
  {
    id: "S1-E1-01",
    title: "某教职工索要身份与银行卡信息",
    chapter: "案例一 · 劳务费代领",
    status: "missing",
    speaker: "某教职工",
    location: "高校教师办公室",
    dialogue:
      "某教职工：“小王，把你的身份证号和银行卡号发给我，我的项目经费还有结余，给你发点劳务费。”",
    action: [
      "电话已经接通",
      "看一眼项目文件夹",
      "拿稳手机并做一次小幅说明手势",
      "完整说完对白并保持通话状态",
    ],
    continuity: "只出现某教职工一人；与小王镜头按不同地点顺序呈现，不使用左右分屏。",
    prompt: {
      reference: "上传图片作为画面基础和视觉参考，保持画风和画面内容一致。",
      action:
        "电话已经接通→某教职工看一眼项目文件夹→拿稳手机并做一次小幅说明手势→完整说完对白→保持通话状态结束。",
      dialogue:
        "某教职工使用约45岁的偏沉中年男声，以自然、略带劝说感的语气完整说出原文对白。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。只出现某教职工一人，不得省略、截断或改写对白。",
    },
  },
  {
    id: "S1-E1-02",
    title: "小王确认劳务费到账",
    chapter: "案例一 · 劳务费代领",
    status: "missing",
    speaker: "小王",
    location: "青年居住或学习空间",
    dialogue: "小王：“叔叔，钱到账了，谢谢。”",
    action: [
      "确认到账短信",
      "立即拨号并等待接通",
      "把手机贴到耳边并完整说出对白",
      "轻微微笑并点头一次后立即结束",
    ],
    continuity:
      "这是收到款项后的后续时间节点；手机屏幕朝向小王，镜头只看见手机背面或侧边。",
    prompt: {
      reference: "上传图片作为画面基础和视觉参考，保持画风和画面内容一致。",
      action:
        "确认到账短信→立即拨号→电话接通→手机贴到耳边→完整说出对白→轻微微笑并点头一次→立即结束。",
      dialogue:
        "小王保持坐姿，电话接通并把手机贴到耳边后，自然感谢地完整说出原文对白。",
      constraints:
        "节奏自然偏快，动作衔接利落；全程固定镜头，不切镜、不转场、不运镜。不得省略、截断或改写对白。",
    },
  },
  {
    id: "S1-E2-01",
    title: "学生宣布助研费并说明返款用途",
    chapter: "案例一 · 学生劳务费套取经费",
    image: "/demo/s1-e2-group.png",
    status: "ready",
    speaker: "某学生（连续两句）",
    location: "高校课题组小会议室",
    dialogue:
      "某学生：“大家这个月科研都很辛苦，给大家做了2000元的助研费，回头收到钱每个人转给我1000元。”\n某学生（继续）：“统一用于课题组经费，支付无法报销的会务交流费、专家评审还有咱们日常团建消费。”",
    action: [
      "主讲学生身体略向前倾",
      "做轻微说明手势并连续说完两句对白",
      "其他三名学生保持倾听",
      "保持座位和人物位置结束",
    ],
    continuity: "保持相同场景、服装和人物位置；结尾不要离开座位。",
    prompt: {
      reference: "上传图片作为画面基础和视觉参考，保持画风和画面内容一致。",
      action:
        "主讲学生身体略向前倾→做轻微说明手势并连续说完两句对白→其他三名学生保持倾听→结束。",
      dialogue: "主讲学生自然偏快但清楚地连续完整说完生产单中的两句原文对白。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。其他学生只做轻微倾听反应，不得省略、截断或改写对白。",
    },
  },
  {
    id: "S2-E1-01",
    title: "审计人员A询问并指出问题",
    chapter: "案例二 · 岗位职责发放专家费",
    image: "/demo/s2-e1-audit.png",
    status: "ready",
    speaker: "审计人员A → 工作人员B → 审计人员A → 工作人员B",
    location: "高校办公室",
    dialogue:
      "审计人员A：“这笔专家费发放名单里，还包含部门管理干部，发放事由是什么？”\n工作人员B：“那段时间我们正在准备迎接检查，请他来做了一次工作指导。”\n审计人员A：“这种工作指导属于他的岗位职责范畴，学院不应该再给他发放专家费。请联系他退款吧。”\n工作人员B：“明白了。”",
    action: [
      "A轻指发放名单并询问",
      "B轻扶文件解释",
      "A说明问题并要求退款",
      "B点头回答后结束",
    ],
    continuity: "沿用审计人员 A 的固定外观，桌面材料位置不跳变。",
    prompt: {
      reference:
        "上传图片作为画面基础和视觉参考，保持画风和画面内容一致；审计员A的外观与人物参考图一致。",
      action:
        "A轻指发放名单并询问→B轻扶文件解释→A说明问题并要求退款→B点头回答→结束。",
      dialogue: "四句对白必须由对应人物按A→B→A→B顺序实际说出并完整说完。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。不得省略、截断或改写对白。",
    },
  },
  {
    id: "S2-E2-01",
    title: "工作人员C提出咨询",
    chapter: "案例二 · 评奖评优酬金咨询",
    image: "/demo/s2-e2-consult.png",
    status: "ready",
    speaker: "工作人员 C",
    location: "高校行政办公室",
    dialogue:
      "工作人员C：“这周我们将组织评审今年的奖助学金，需邀请专家到现场参评，我想咨询一下，能不能给评委发点酬金呢？”",
    action: [
      "C拿着评审安排表提出咨询",
      "C说完后放低表格并看向A",
      "A转向C并抬手准备解释",
      "保持准备解释的姿态结束",
    ],
    continuity: "截取A处于准备解释姿态的末帧，作为S2-E2-02的连续性参考。",
    prompt: {
      reference:
        "上传图片作为画面基础和视觉参考，保持画风和画面内容一致；审计员A的外观与人物参考图一致。",
      action:
        "C拿着评审安排表提出咨询→C说完后放低表格并看向A→A转向C并抬手准备解释→结束。",
      dialogue: "工作人员C以礼貌、清晰、温和的咨询语气完整说出生产单原文。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。不得省略、截断或改写对白。",
    },
  },
  {
    id: "S2-E2-02",
    title: "审计人员A完整解释规则",
    chapter: "案例二 · 评奖评优酬金咨询",
    image: "/demo/s2-e2-consult.png",
    status: "ready",
    speaker: "审计人员A（连续两句）",
    location: "高校行政办公室",
    dialogue:
      "审计人员A：“如果评选专家的工作岗位与奖助学金管理相关，参评就属于本职工作，不应该额外发放酬金；”\n审计人员A（继续）：“如果专家是教师身份，可按标准发放；如果专家是管理干部，不建议发放。”",
    action: [
      "A先做说明手势并说第一句",
      "A用小幅左右手势区分两类身份并说第二句",
      "C保持自然倾听",
      "人物保持原位结束",
    ],
    continuity:
      "优先使用S2-E2-01生成视频的结尾截图；人物、服装、场景、机位和C手中的安排表保持连续。",
    prompt: {
      reference:
        "优先上传S2-E2-01的结尾截图作为画面基础、视觉和连续性参考；审计员A外观与人物参考图一致。",
      action:
        "A先做说明手势并说第一句→再用小幅左右手势区分两类身份并说第二句→C保持倾听→结束。",
      dialogue: "审计人员A沉稳、清楚、自然偏快地连续完整说出生产单中的两句原文。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。C只做自然倾听反应，不得省略、截断或改写对白。",
    },
  },
  {
    id: "S3-E1-01",
    title: "提交发放单并明确否定",
    chapter: "案例三 · 无依据“全勤奖”",
    image: "/demo/s3-e1-submit.png",
    status: "ready",
    speaker: "学院工作人员 → 院长 → 学院工作人员 → 院长",
    location: "院长办公室",
    dialogue:
      "学院工作人员：“院长，这是这个月的酬金发放明细表，请您审阅。”\n院长：“这个酬金发放没有依据吧？”\n学院工作人员：“这是按照惯例发放的。”\n院长：“如果没有依据就不能发放。之前的工作惯例如果没有依据，以后就不能再发了。”",
    action: [
      "工作人员递交发放表",
      "院长查看发放表并质疑",
      "工作人员解释惯例",
      "院长做小幅否定手势并明确说明",
    ],
    continuity: "保持同一座位和文件位置；整段在同一个镜头内完成。",
    prompt: {
      reference: "上传图片作为画面基础和视觉参考，保持画风和画面内容一致。",
      action:
        "工作人员递交发放表→院长看表并质疑→工作人员解释惯例→院长做小幅否定手势并说明→结束。",
      dialogue: "四句对白必须由对应人物按工作人员→院长→工作人员→院长顺序完整说出。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。不得省略、截断或改写对白。",
    },
  },
  {
    id: "S3-E2-01",
    title: "指出定额加班费并说明制度问题",
    chapter: "案例三 · 超范围加班费",
    image: "/demo/s3-e2-overtime.png",
    status: "ready",
    speaker: "审计人员A → 审计人员B",
    location: "审查会议室",
    dialogue:
      "审计人员A：“这个单位以值班名义，按月定额发放加班费，金额从1800元至2400元不等。”\n审计人员B：“学校加班费管理办法明确了4个可通过‘在校值班’名义发放加班费的部门，这个部门不在其中。且其发放金额超出了制度规定的上限。”",
    action: [
      "A指向电脑记录并说明问题",
      "B使用制度文件继续解释",
      "两人保持原位",
      "电脑和座位保持不变后结束",
    ],
    continuity: "保持同一办公室、人物服装、电脑和座位；审计人员A沿用固定外观。",
    prompt: {
      reference:
        "上传图片作为画面基础和视觉参考，保持画风和画面内容一致；审计员A外观与人物参考图一致。",
      action: "A指向电脑记录并说明问题→B使用制度文件继续解释→两人保持原位结束。",
      dialogue: "两句对白必须由对应人物按A→B顺序实际说出并完整说完。",
      constraints:
        "全程固定镜头，不切镜、不转场、不运镜。不得省略、截断或改写对白。",
    },
  },
];

/**
 * 提交给豆包的视频提示词（2026-09-17 官方公式结构）。润色结果存分镜上
 * （`videoPromptPolished.script`，镜头时序正文、台词 {} 原样嵌入）时直接用；
 * 旧格式 description/direction 拼接降级；完全没有就按镜头时序模板兜底。
 * `referenceImageNote`（参考图说明，多图含分工）提交时传入，置顶输出；上一镜尾帧
 * 进入连续性链路时会明确作为本镜首帧参考图，并让镜头1从该状态开始。
 */
export const promptText = (shot: Shot, referenceImageNote?: string) => {
  const polished = shot.videoPromptPolished;
  const legacyScript = [polished?.description, polished?.direction]
    .map((item) => (item || "").trim())
    .filter(Boolean)
    .join("。");
  const continuationShot =
    /上一镜|上一分镜|接续|延续|连续性参考|结尾截图/u.test(shot.continuity) &&
    !/不(?:再)?沿用上一镜|无需(?:参考|沿用)上一镜|独立开场/u.test(shot.continuity);
  return buildVideoPromptText({
    script: polished?.script?.trim() || legacyScript || undefined,
    dialogue: shot.dialogue,
    performance: shot.prompt.dialogue,
    continuity: shot.continuity,
    constraints: shot.prompt.constraints,
    referenceNote: shot.prompt.reference,
    actions: shot.prompt.action,
    estimatedSeconds: shot.estimatedSeconds,
    targetSeconds: shot.videoSecondsOverride,
    referenceImageNote,
    identityNote: polished?.identityNote,
    firstFrameReference:
      continuationShot || /上一镜结尾画面|尾帧链/u.test(referenceImageNote || ""),
  });
};

export type ScriptParagraph = {
  id: number;
  kind: "meta" | "section" | "heading" | "dialogue" | "note" | "summary" | "action" | "effect";
  text: string;
};

export type ExtractedCaseItem = {
  sourceId: number;
  sourceSegment?: number;
  type: string;
  speaker?: string;
  text: string;
  estimatedSeconds: number;
  sceneHint?: string;
  /**
   * 对白标签里带出的现场动作/神态提示（「王老师一愣」「小李走进来，把平板递过去」）。
   * 2026-10-07：规则版本 1.7 起由提取器产出。它是对白镜唯一的可执行动作来源——
   * 旧版把提示整段剥掉，对白镜因此只剩台词，下游只能合成口播意向串。
   * 命名沿用提取器 JSON 的 snake_case，避免边界再转一手。
   */
  performance_cue?: string;
};

export type ExtractedCase = {
  id: string;
  group: string;
  title: string;
  sourceIds: number[];
  dialogueCount: number;
  storyboardCount: number;
  note: string;
  estimatedSeconds?: number;
  context?: {
    title?: string;
    scene?: string;
    actionNotes?: string[];
  };
  items?: ExtractedCaseItem[];
};

export type ImagePromptPackage = {
  id: string;
  title: string;
  image?: string;
  status: ShotStatus;
  prompt: string;
  promptModel?: string;
  mediaSource?: {
    jobId: string;
    candidateId: string;
  };
  /**
   * 2026-09-16 晚：采用图片时的分镜视觉签名（shotVisualSignature）。
   * 分镜的画面字段（人物/场景/动作/衔接）之后再变，图即判定过期——
   * 由 referenceImageStale 计算，界面阻断视频词并列出改动，要求显式处理。
   */
  imageSourceSignature?: string;
  /** 上游衔接或画面要求改变后，旧图须由用户重新采用或确认保留。 */
  imageNeedsReview?: boolean;
};

export const scriptParagraphs: ScriptParagraph[] = [
  { id: 1, kind: "meta", text: "标题：酬金发放，这些雷区不要踩" },
  { id: 2, kind: "meta", text: "（沿用审计人员A形象）" },
  { id: 3, kind: "meta", text: "【动画脚本】" },
  { id: 4, kind: "section", text: "1. 虚假列支劳务费" },
  { id: 5, kind: "note", text: "画面：全屏标题卡，深蓝色背景，白色大字。" },
  { id: 6, kind: "note", text: "音效：轻微的“嗒”声。" },
  { id: 9, kind: "heading", text: "示例1. 通过科研经费为亲属发放劳务费" },
  {
    id: 10,
    kind: "dialogue",
    text: "某教职工和其亲属的电话场景：小王，把你的身份证号和银行卡号发给我，我的项目经费还有结余，给你发点劳务费。",
  },
  {
    id: 11,
    kind: "dialogue",
    text: "场景切换为另一个打电话的场景，人员变更为小王：叔叔，钱到账了，谢谢。",
  },
  { id: 13, kind: "heading", text: "示例2. 以发放学生劳务费形式套取科研经费" },
  {
    id: 14,
    kind: "dialogue",
    text: "某学生：大家这个月科研都很辛苦，给大家做了2000元的助研费，回头收到钱每个人转给我1000元，统一用于课题组经费，支付无法报销的会务交流费、专家评审还有咱们日常团建消费。",
  },
  {
    id: 15,
    kind: "note",
    text: "审计提醒：劳务费发放一定要真实、合规，严禁虚构劳务事项套取经费。",
  },
  { id: 17, kind: "section", text: "2. 岗位职责行为不得发放酬金" },
  { id: 18, kind: "note", text: "画面：全屏标题卡，深蓝色背景，白色大字。" },
  { id: 20, kind: "note", text: "音效：轻微的“嗒”声。" },
  { id: 22, kind: "heading", text: "示例1. 学院为职能部门人员发放酬金" },
  {
    id: 23,
    kind: "dialogue",
    text: "审计人员A：这笔专家费发放名单里，还包含部门管理干部，发放事由是什么？",
  },
  {
    id: 24,
    kind: "dialogue",
    text: "被审计单位工作人员B：那段时间我们正在准备迎接检查，请他来做了一次工作指导。",
  },
  {
    id: 25,
    kind: "dialogue",
    text: "审计人员A：这种工作指导属于他的岗位职责范畴，学院不应该再给他发放专家费。请联系他退款吧。",
  },
  { id: 26, kind: "dialogue", text: "B：明白了。" },
  { id: 28, kind: "heading", text: "示例2. 组织评奖评优工作发放酬金" },
  {
    id: 29,
    kind: "dialogue",
    text: "C：这周我们将组织评审今年的奖助学金，需邀请专家到现场参评，我想咨询一下，能不能给评委发点酬金呢？",
  },
  {
    id: 30,
    kind: "dialogue",
    text: "A：如果评选专家的工作岗位与奖助学金管理相关，参评就属于本职工作，不应该额外发放酬金；如果专家是教师身份，可按标准发放；如果专家是管理干部，不建议发放。",
  },
  {
    id: 31,
    kind: "note",
    text: "审计提醒：凡属本职工作职责范围内的事务，不应额外发放酬金。",
  },
  { id: 33, kind: "section", text: "3. 无依据发放酬金" },
  { id: 34, kind: "note", text: "画面：全屏标题卡，深蓝色背景，白色大字。" },
  { id: 36, kind: "note", text: "音效：轻微的“嗒”声。" },
  { id: 38, kind: "heading", text: "示例1. 自立名目、自定标准发放酬金" },
  {
    id: 39,
    kind: "dialogue",
    text: "工作人员A：院长，这是这个月的酬金发放明细表，请您审阅。",
  },
  {
    id: 40,
    kind: "note",
    text: "酬金发放单：2026年3月“全勤奖”，列20个人左右，每人200元。",
  },
  { id: 41, kind: "dialogue", text: "B：这个酬金发放没有依据吧？" },
  { id: 42, kind: "dialogue", text: "A：这是按照惯例发放的。" },
  {
    id: 43,
    kind: "dialogue",
    text: "B：如果没有依据就不能发放。之前的工作惯例如果没有依据，以后就不能再发了。",
  },
  { id: 45, kind: "heading", text: "示例2. 超标准、超范围发放加班费" },
  {
    id: 46,
    kind: "dialogue",
    text: "审计人员A：这个单位以值班名义，按月定额发放加班费，金额从1800元至2400元不等。",
  },
  {
    id: 47,
    kind: "dialogue",
    text: "审计人员B：学校加班费管理办法明确了4个可通过“在校值班”名义发放加班费的部门，这个部门不在其中。且其发放金额超出了制度规定的上限。",
  },
  {
    id: 48,
    kind: "note",
    text: "审计提醒：酬金发放须有明确的制度依据，要在规定标准内据实核定。",
  },
  { id: 50, kind: "summary", text: "69-78s（过渡：常见问题总结）" },
  {
    id: 51,
    kind: "summary",
    text: "画面：审计人员A合上文件，身后屏幕上浮现酬金发放规定核心条款。",
  },
  { id: 52, kind: "summary", text: "旁白：学校酬金发放规定中明确：" },
  {
    id: 53,
    kind: "summary",
    text: "应确保本单位、本项目发放酬金事项真实、合规、合理。",
  },
  {
    id: 54,
    kind: "summary",
    text: "对应案例一：不得违规发放津贴补贴。",
  },
  {
    id: 55,
    kind: "summary",
    text: "对应案例二：不得为职责范围内工作发放酬金。",
  },
  {
    id: 56,
    kind: "summary",
    text: "对应案例三：新增酬金项目需先请示备案后予以发放。",
  },
  { id: 59, kind: "summary", text: "94-98s（结尾金句）" },
  {
    id: 60,
    kind: "summary",
    text: "画面：审计人员A合上文件夹，微笑看向镜头，背景浮现温暖光线。",
  },
  {
    id: 62,
    kind: "summary",
    text: "旁白：酬金发放，守住“真实、合规、合理”——发得安心，拿得踏实。",
  },
  {
    id: 63,
    kind: "summary",
    text: "固定结尾：以上案例旨在提示风险。如有工作疑问，欢迎咨询审计处。",
  },
];

export const extractedCases: ExtractedCase[] = [
  {
    id: "S1-E1",
    group: "虚假列支劳务费",
    title: "通过科研经费为亲属发放劳务费",
    sourceIds: [9, 10, 11],
    dialogueCount: 2,
    storyboardCount: 2,
    note: "存在明确的地点与人物切换，按教师办公室和小王居住/学习区拆为两个镜头。",
  },
  {
    id: "S1-E2",
    group: "虚假列支劳务费",
    title: "以发放学生劳务费形式套取科研经费",
    sourceIds: [13, 14],
    dialogueCount: 1,
    storyboardCount: 1,
    note: "最小案例保持为一个逻辑单元，长对白在同一稳定镜头中连续表达。",
  },
  {
    id: "S2-E1",
    group: "岗位职责行为不得发放酬金",
    title: "学院为职能部门人员发放酬金",
    sourceIds: [22, 23, 24, 25, 26],
    dialogueCount: 4,
    storyboardCount: 1,
    note: "四轮同场对白合并为一个镜头，保留A→B→A→B的说话顺序。",
  },
  {
    id: "S2-E2",
    group: "岗位职责行为不得发放酬金",
    title: "组织评奖评优工作发放酬金",
    sourceIds: [28, 29, 30],
    dialogueCount: 2,
    storyboardCount: 2,
    note: "用户实测完整对白无法在单段内自然完成，按C提问与A回答拆为两个镜头。",
  },
  {
    id: "S3-E1",
    group: "无依据发放酬金",
    title: "自立名目、自定标准发放酬金",
    sourceIds: [38, 39, 40, 41, 42, 43],
    dialogueCount: 4,
    storyboardCount: 1,
    note: "发放单属于同场证据道具，四轮对话在院长办公室同一镜头内完成。",
  },
  {
    id: "S3-E2",
    group: "无依据发放酬金",
    title: "超标准、超范围发放加班费",
    sourceIds: [45, 46, 47],
    dialogueCount: 2,
    storyboardCount: 1,
    note: "两名审计人员围绕同一制度问题连续说明，保持同一办公室和文件关系。",
  },
];

const promptStyle =
  "采用已上传风格图的MG插画风格。参考图仅作画风与人物画法示范：只参考它的线条、配色、人物五官比例与上色方式；图中人物不得作为本镜角色出场，其服装、发型、站位与场景布局一律不作参考。桌面上不得出现姓名牌、桌牌或任何带文字的物品；墙面文件与海报只画色块示意，不画文字线条。";

export const imagePromptPackages: ImagePromptPackage[] = [
  {
    id: "S1-E1-01",
    title: "某教职工索要身份与银行卡信息",
    status: "missing",
    prompt: `${promptStyle}\n白天，16:9横屏，高校教师办公室，单地点单人中景。一名约45岁的东亚男性教职工坐在办公桌内侧，右手拿手机贴近耳边但不能挡住嘴和下半张脸，左手自然放在打开的项目文件夹旁。画面中严格只有这名教职工，不出现小王，不使用左右分屏。`,
  },
  {
    id: "S1-E1-02",
    title: "小王确认劳务费到账",
    status: "missing",
    prompt: `${promptStyle}\n稍后的白天，16:9横屏，青年居住空间或家中学习区，单地点单人中景。小王低头查看手机，屏幕正面必须朝向本人，镜头只看见手机背面或侧边；到账状态只通过视线和确认后的表情表达。画面中严格只有小王，不使用左右分屏。`,
  },
  {
    id: "S1-E2-01",
    title: "学生宣布助研费并说明返款用途",
    image: "/demo/s1-e2-group.png",
    status: "ready",
    prompt: `${promptStyle}\n白天，16:9横屏，高校课题组小会议室，中全景固定机位。四名东亚青年学生围桌而坐，主讲学生位于画面右侧靠前，其他三名听者保持安静倾听。人物总数严格四人，首帧全员自然闭嘴。`,
  },
  {
    id: "S2-E1-01",
    title: "审计人员A询问并指出问题",
    image: "/demo/s2-e1-audit.png",
    status: "ready",
    prompt: `${promptStyle}\n白天，16:9横屏，高校行政办公室双人中景。审计员A与工作人员B隔桌对坐，桌面中央放专家费发放名单。人物严格两人，A的眼镜、发型、脸型和服装必须与人物参考图一致。`,
  },
  {
    id: "S2-E2-01",
    title: "工作人员C咨询并由A解释规则",
    image: "/demo/s2-e2-consult.png",
    status: "ready",
    prompt: `${promptStyle}\n白天，16:9横屏，高校行政办公室双人中景。工作人员C和审计员A对坐交流，人物严格两人，首帧两人自然闭嘴，A的人物参考必须固定。`,
  },
  {
    id: "S3-E1-01",
    title: "提交发放单并明确否定",
    image: "/demo/s3-e1-submit.png",
    status: "ready",
    prompt: `${promptStyle}\n白天，16:9横屏，高校院长办公室双人中景，工作人员递出酬金发放明细表，院长质疑并明确否定。人物严格两人，桌面文件和办公室环境保持连续。`,
  },
  {
    id: "S3-E2-01",
    title: "指出定额加班费并说明制度问题",
    image: "/demo/s3-e2-overtime.png",
    status: "ready",
    prompt: `${promptStyle}\n白天，16:9横屏，高校审计办公室双人中景，A指出定额加班费，B随后解释制度问题。两人保持同一办公室、座位和电脑文件关系，A的人物参考必须固定。`,
  },
];
