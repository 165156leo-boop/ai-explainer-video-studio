/**
 * 视频提示词润色与组装（2026-09-17 按火山方舟 Seedance 2.0 官方提示词指南重构）。
 *
 * 官方关键口径（volcengine.com/docs/82379/1587797）：
 *  - 时间层用「镜头1/镜头2/镜头3」分镜时序表达，不写精确秒数（精确时间支持不稳定）；
 *  - 每镜头内部顺序：运镜 → 主体动作表情 → 位置空间 → 音频；动作写惯性承接；
 *  - 台词用 {} 包裹、音效用 <>、音乐用（）、【】是字幕专用符号——禁止拿【】做小节标题；
 *  - 文案过度冗余易造成模型理解混乱；重要素材（参考图说明）越靠前越好。
 *
 * 两条硬约束（沿用并加强）：
 *  1. 台词逐字不改：润色正文里的台词必须以 {} 原样嵌入，服务端逐字比对，改写即拒收；
 *  2. 指令头/参数行/全局约束固定由服务端给出，模型无权改写。
 *
 * 2026-09-18（用户澄清语义，改动理由）：「我们上传的静态图片不一定就是首帧，我本来
 * 的意思也是生成一张参考图，从参考图发散生成视频，参考图可以上传好几张」。这与实测
 * 一致——豆包网页/桌面端只有参考图一种素材位，整页 HTML 扫描「首帧/尾帧/first_frame/
 * last_frame」零命中，首尾帧是 API 与 App 的能力。因此：
 *   - 普通分镜图仍作为可发散的画面参考；只有上一镜尾帧进入连续性链路时，置顶说明才明确
 *     将它作为本镜首帧参考图，并让镜头1承担首帧状态约束。镜位与运镜仍按本镜叙事需要移动，
 *     避免「敲门→原地回位→对着空椅子说话」这类成片；
 *   - 支持多张参考图并写明分工（画面基准 / 人物形象 / 画风 / 上一镜衔接）。
 */

import { AiInputRejected, AiOutputRejected } from "./ai-output-rejection.ts";

export type VideoPromptBrief = {
  id: string;
  title: string;
  scene: string;
  characters: string;
  /** 对白原文（`小陈：“…”` 形式），保留给提示词上下文与校验基准。 */
  dialogue: string;
  /**
   * 2026-09-17 修复「台词被改写」：把对白**预先切分**成逐句 { speaking, line } 一并送给模型。
   *
   * 起因：只给原始串 `小李：“刘老师，您提交的公务接待费用…”` 时，模型会把句首的称呼语
   * 「刘老师，」误判成「称呼对象」而移到大括号外，甚至把说话人写成「刘老师说」——
   * 逐字校验必然拒收。切分后 line 的边界一目了然，模型的活退化成「原样搬运」。
   */
  dialogueLines: Array<{ speaker: string; line: string }>;
  actions: string[];
  referenceNote: string;
  performance: string;
  continuity: string;
  constraints: string;
  /** 视觉模型用官方角色图与本镜场景图比对出的身份和动作事实。 */
  identityNotes?: string;
  seconds: number;
  aspectRatio: string;
  /** 本镜使用上一镜连续性画面作为首帧约束（非独立开场）。 */
  firstFrameReference?: boolean;
};

/** 只替换旧规划器的固定模板约束；用户另写的要求原样保留。 */
export function normalizeVideoConstraints(value: string): string {
  return value.replace(
    "全程固定镜头，不切镜、不转场、不运镜。",
    "一个镜头只采用一种与动作一致的运镜，不切镜、不转场。",
  );
}

export type PolishedVideoPrompt = {
  id: string;
  /**
   * 2026-09-17（用户拍板按官方公式重构）：镜头时序正文——「镜头1：…开场空镜 /
   * 镜头2：…主体表演+对白 / 镜头3：…收尾空镜」，台词以半角大括号原样嵌入正文。
   * 取代旧的 description+direction 两段结构（与固定段三层节奏指令互相打架）。
   */
  script: string;
  /** 模型结构不完整时，服务端使用确定性镜头模板兜底。 */
  fallback?: boolean;
};

export type VideoPromptAssembly = {
  /** 润色后的镜头时序正文（含 {} 台词）；无润色时由四段字段回退组装。 */
  script?: string;
  dialogue: string;
  performance: string;
  continuity: string;
  constraints: string;
  referenceNote: string;
  actions: string;
  estimatedSeconds?: number;
  /** 手动指定的目标时长档位（5/10/15 秒）；有值时优先于语速估算。 */
  targetSeconds?: number;
  aspectRatio?: string;
  /**
   * 2026-09-18：置顶的「参考图说明」（取代旧的 openingFrameNote）。官方要求
   * 「重要素材前置」，所以这段输出在提示词最顶部，不再垫尾。内容由
   * `buildReferenceImageNote` 统一生成，保证界面显示与提交内容一致。
   */
  referenceImageNote?: string;
  /** 视觉角色匹配结果，作为最终视频提示词的确定性身份锚点。 */
  identityNote?: string;
  /** 本镜首张参考图是上一镜尾帧时，镜头1按首帧约束差异化生成。 */
  firstFrameReference?: boolean;
};

/**
 * 参考图的用途分工（决定提示词里怎么描述这张图）。
 * 2026-09-18：豆包只有参考图素材位，多张图必须分工，否则模型容易把几张图揉成一张拼贴。
 */
export type VideoReferenceImageRole = "base" | "continuity" | "character" | "style";

export type VideoReferenceImage = {
  /** 给模型和用户看的这张图是什么（如「S2-E1-01 分镜画面」「审计员A 人物图」）。 */
  label: string;
  role: VideoReferenceImageRole;
  /**
   * 2026-09-19：role 为 character 时，这张人物图对应哪个角色名。
   * 给了就写成「图中人物即 X」——实测成片出现过两个说话人身份互换，原因正是
   * 提示词只写了台词归属、没写画面里谁是谁，模型只能猜。
   */
  personName?: string;
};

/**
 * 生成置顶的「参考图说明」。
 *
 * 2026-09-26：普通画面参考保持简短；连续性尾帧单独明确为本镜首帧参考图，避免模型把
 * 上一镜结尾当成无关素材，也避免把所有普通参考图误报成原生首帧参数。
 *
 * 没有参考图时返回 undefined（不输出空段）。
 */
export function buildReferenceImageNote(images: VideoReferenceImage[]) {
  const list = (images || []).filter((item) => item && String(item.label || "").trim());
  if (!list.length) return undefined;
  const firstReference = list[0];
  const basePart = firstReference.role === "continuity"
    ? "将第 1 张参考图（上一镜结尾画面）作为本镜首帧参考图上传，视频从该画面的角色位置、姿态、服装、道具和环境状态开始"
    : "根据第 1 张参考图作为画面参考生成视频";
  const whoClauses = list
    .map((item, index) => {
      const name = String(item.personName || "").trim();
      if (item.role !== "character" || !name) return "";
      return list.length === 1
        ? `参考图中的人物为「${name}」`
        : `第 ${index + 1} 张参考图中的人物为「${name}」`;
    })
    .filter(Boolean);
  const whoPart = whoClauses.length ? `；${whoClauses.join("，")}` : "";
  return `参考图说明：${basePart}${whoPart}。`;
}

/**
 * 2026-09-19 晚（用户拍板）：纯文字绑定不能消除两人身份互换，因此视频生成仍必须
 * 上传人物形象图并写明「图中人物即 X」（`VideoReferenceImage.personName`）。
 * 2026-09-20 起，视频词润色前再由视觉模型把官方角色图与本镜场景图做一次匹配，
 * 把站坐、位置和动作证据交给文本模型；最终提示词保留这条视觉身份锚点。
 */

/**
 * 2026-09-16：工作台可选的视频模型（直连通道的 ability_param.model 一一对应）。
 * 标准 Seedance 2.0 官方只支持 5 秒档，因此时长超过 5 秒时不允许选它（提交前拦下）。
 */
export const VIDEO_MODEL_IDS = ["seedance-2.0-mini", "seedance-2.0-fast", "seedance-2.0"] as const;
/**
 * 视频统一使用的模型（前台不再暴露选择）。
 * 2026-09-16 实测：mini 只能到 10 秒（15 秒会被豆包回「订阅标准套餐专属能力」），
 * fast 可以到 15 秒（两次实测出片 15.05s / 15.08s），因此固定用 fast。
 */
export const DEFAULT_VIDEO_MODEL = "seedance-2.0-fast";
export const VIDEO_MODEL_MAX_SECONDS: Record<string, number> = {
  // 2026-09-16 实测：Mini 超过 10 秒会被豆包判为「订阅标准套餐专属能力」而拒绝；
  // Fast 可以到 15 秒（实测出过 15 秒成片）；标准 2.0 只支持 5 秒。
  "seedance-2.0-mini": 10,
  "seedance-2.0-fast": 15,
  "seedance-2.0": 5,
};

export function videoModelLabel(id: string) {
  if (id === "seedance-2.0") return "Seedance 2.0（画质优先·仅 5 秒）";
  if (id === "seedance-2.0-fast") return "Seedance 2.0 Fast（速度优先）";
  return "Seedance 2.0 Mini（成本优先）";
}

/**
 * 豆包 Seedance 的时长档位。2026-09-25（用户拍板「一定要进到下一个挡位」）：
 * 估算秒数本身就是**台词的纯朗读时长**（字数 ÷ 语速基线），若档位 ≤ 估算，
 * 开头慢开口与结尾停顿就被挤掉——S2-E1-01 实测：6.9s 预估被压进 5 秒档，
 * 成片约 8 字/秒且无任何停顿。因此档位必须**严格大于**估算：取大于估算的
 * 最小档；估算 ≥ 15 时维持 15（超限镜由拆镜流程处理，不在此处放大）。
 */
export function videoDurationBucket(seconds?: number) {
  const value = Math.max(0, Number(seconds) || 0);
  for (const tier of [5, 10, 15]) {
    if (value < tier - 0.001) return tier;
  }
  return 15;
}

/**
 * 指令头（2026-09-17 按官方符号规范重构）：豆包会把「纯指令单」当成需要澄清的对话，
 * 因此这句固定由服务端给出。注意官方提示词符号体系里【】是字幕专用符号——
 * 固定指令一律不带【】小节标题，避免诱导模型渲染字幕。
 */
export const VIDEO_PROMPT_DIRECTIVE =
  "请直接按以下要求生成一支视频，不要提问、不要要求确认或补充任何参数。";

/**
 * 全局约束行（2026-09-17 重构）：收敛旧的【语音要求】+【收尾要求】+【语速分配】三段。
 * 官方口径：精确时间（如 0.5—1 秒）支持不稳定，节奏用镜头时序表达；语速不写数字，
 * 只写「按台词顺序自然分配」。收尾缓冲由「镜头3 收尾空镜」承担，
 * 删除与语音要求互相矛盾的「不要在结尾留下大段无人说话的空白」。
 *
 * 2026-09-19（用户看真实成片反馈）：成片语速偏慢。原措辞「同一语速从容」是在让模型
 * 放慢——而台词按语速基线折算往往本就贴着/超出档位容量（实测 84 字 = 16.8 秒 vs 15 秒档），
 * 再「从容」必然超时或赶尾。改为「语速较快、咬字清晰」：快而不含糊，
 * 保留「先说的不抢速、后说的不变慢」继续钉住两人语速均衡。
 */
/**
 * 全局约束行（2026-09-19 二次精简，用户拍板）：只保留三条用户点名要的——
 * ① 开头慢开口（开口前自然闭嘴、稍作停顿后再缓慢开口；上一版成片开头展开太快）；
 * ② 结尾停顿收尾（台词说完后自然闭嘴、停一小段再收尾）；
 * ③ 运镜与动作自洽（人物离开原位时镜头跟随，不得同时锁机位）。
 * 删掉的：语速类措辞（「语速较快」实测催出 7 字/秒的赶话与跳对白——装不下时模型
 * 用提速+丢内容消化，节奏问题应该靠拆镜解决而不是写进提示词）、面部稳定/无字幕
 * 水印等常规约束、按台词分配时间的细则。
 */
export const VIDEO_GLOBAL_CONSTRAINTS =
  "全程：开口说话前人物自然闭嘴，稍作停顿后再缓慢开口；" +
  "台词说完后人物自然闭嘴，保持一小段停顿再收尾。" +
  "运镜与人物动作必须自洽：人物需要离开原位、跨过门槛或切换到另一空间时，镜头要随之跟随，" +
  "不得同时锁定机位；反之不移动的镜头保持镜头平稳，不做无意义运镜。" +
  "道具物理连续：人物手持或接触的道具必须始终与手或稳定支撑面保持真实接触；" +
  "手离开道具前必须明确由另一只手接住，或先放到桌面等支撑面再松手；不得悬浮、穿手、瞬移或无支撑停留。";

const VIDEO_CONTINUITY_CONSTRAINTS =
  "全程：以已上传的首帧画面状态为起点，首个镜头只做与动作链一致的自然承接，不机械重复闭嘴或停顿，不重置人物位置、姿态、服装、道具和环境关系；" +
  "台词说完后人物保持姿势，动作自然收尾。" +
  "运镜与人物动作必须自洽：人物需要离开原位、跨过门槛或切换到另一空间时，镜头要随之跟随，" +
  "不得同时锁定机位；反之不移动的镜头保持镜头平稳，不做无意义运镜。" +
  "道具物理连续：人物手持或接触的道具必须始终与手或稳定支撑面保持真实接触；" +
  "手离开道具前必须明确由另一只手接住，或先放到桌面等支撑面再松手；不得悬浮、穿手、瞬移或无支撑停留。";

function buildVideoGlobalConstraints(firstFrameReference?: boolean) {
  return firstFrameReference ? VIDEO_CONTINUITY_CONSTRAINTS : VIDEO_GLOBAL_CONSTRAINTS;
}

const DOOR_ENTRY_PATTERN = /(?:进入|走进|走入|步入|踏入|跨入|推门进入|推门走进)(?:办公室|房间|室内)|(?:进门|进屋)/u;
const DOOR_KNOCK_PATTERN = /敲(?:一下|了)?门|敲门/u;

/**
 * 门口进场是有因果顺序的动作链，不能交给润色模型自由重排。
 * 只在素材确实同时出现「敲门」和「进入室内」时附加，避免污染普通镜头。
 */
export function doorEntrySequenceConstraint(value: string) {
  const text = String(value || "");
  if (!DOOR_KNOCK_PATTERN.test(text) || !DOOR_ENTRY_PATTERN.test(text)) return "";
  return (
    "门口进场顺序（硬约束）：人物先在门口敲门一次，再进入办公室，进门后才与室内人物说话；" +
    "若门已打开，只保留敲门动作，不再开门或关门；不得先进入后敲门、边进门边说话，或敲门后退回原位。"
  );
}

/** 续镜兼容旧润色稿：去掉旧模板在镜头1机械写入的闭嘴/停顿句，保留原本的起始动作。 */
function normalizeContinuityOpening(script: string, firstFrameReference?: boolean) {
  if (!firstFrameReference) return script;
  return script.replace(
    /^镜头1：[^。\n]*?(?:自然闭嘴|闭嘴)[^。\n]*?自然过渡到([^。\n]*)。/mu,
    (_match, opening: string) =>
      `镜头1：以已上传首帧状态为起点，保持首帧中的人物位置、姿态、服装、道具和环境关系不变，自然承接到${opening}。`,
  );
}

/** 计入朗读时长的字符：汉字、字母、数字；标点不计（破折号/省略号拉长音也忽略）。 */
export function countSpeechChars(text: string) {
  return (String(text || "").match(/[一-鿿A-Za-z0-9]/gu) || []).length;
}

export type DialogueSpeaker = { speaker: string; line: string; chars: number };

/**
 * 把对白拆成「说话人：台词」行。支持 `小陈：“…”` / `小王:"…"` 两种冒号与两种引号。
 * 没有引号台词（纯旁白/动作描述）时返回空数组。
 */
export function parseDialogueSpeakers(dialogue: string) {
  const speakers: DialogueSpeaker[] = [];
  const re = /([^\n:：]{1,15}?)[：:][ \t]*[“"]([^”"]+)[”"]/gu;
  for (const match of String(dialogue || "").matchAll(re)) {
    const speaker = match[1].trim();
    const line = match[2].trim();
    if (!speaker || !line) continue;
    const chars = countSpeechChars(line);
    if (chars > 0) speakers.push({ speaker, line, chars });
  }
  return speakers;
}

/**
 * 把「谁说哪一句」放在最终视频提示词里，并把句首称呼解释成听者。
 * 这段是确定性生成的，避免润色模型只保留台词正文、却把两张脸和声音
 * 随机互换。只有两位及以上说话人时才输出，单人独白不增加噪声。
 */
export function buildSpeakerIdentityNote(dialogue: string) {
  const speakers = parseDialogueSpeakers(dialogue);
  const unique = [...new Set(speakers.map((item) => item.speaker))];
  if (unique.length < 2) return undefined;
  const order = speakers
    .map((item, index) => `第${index + 1}句由「${item.speaker}」开口`)
    .join("；");
  const listeners = speakers
    .map((item) => String(item.line).match(/^([一-鿿]{2,6})[，,：:]/u)?.[1] || "")
    .filter((name, index, all) => name && all.indexOf(name) === index)
    .map((name) => `句首称呼「${name}」是正在听的人，不是本句说话人`)
    .join("；");
  return (
    `说话人绑定（硬约束）：${order}。` +
    (listeners ? `${listeners}。` : "") +
    "口型、面部朝向与声音必须和上述台词归属一一对应，绝不互换人物身份。"
  );
}


function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function strings(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
}

export function normalizeVideoPromptBriefs(value: unknown): VideoPromptBrief[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new Error("视频词润色数量必须为 1—24 条");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!record(item)) throw new Error("视频词润色输入无效");
    const id = text(item.id, 80);
    if (!id || seen.has(id)) throw new Error("镜头 ID 缺失或重复");
    seen.add(id);
    const scene = text(item.scene, 800);
    const actions = strings(item.actions, 10, 500);
    const dialogue = text(item.dialogue, 3_000);
    // 2026-09-30：这是**本地素材**不满足最低契约，不是模型的问题（此前抛裸 Error，
    // 前端按瞬时错误退了 2 次）。实测 `S1-E1-02`：动作被 continuityVisualActions 的
    // 口语化过滤规则清空后，同样的请求必然同样失败，退避重试纯属白等。
    // 2026-10-08 二轮：文案里**不带镜头编号**——服务端算不出对外展示的「第几镜」，
    // 回显内部键会让用户照着去找却找不到；编号由客户端用 `shotDisplayLabel` 补。
    if (!scene || !actions.length) throw new AiInputRejected("缺少场景或动作");
    const seconds = Math.round(Number(item.seconds) || 0);
    return {
      id,
      title: text(item.title, 200),
      scene,
      characters: text(item.characters, 500),
      dialogue,
      dialogueLines: parseDialogueSpeakers(dialogue).map(({ speaker, line }) => ({
        speaker,
        line,
      })),
      actions,
      referenceNote: text(item.referenceNote, 800),
      performance: text(item.performance, 800),
      continuity: text(item.continuity, 1_000),
      constraints: normalizeVideoConstraints(text(item.constraints, 800)),
      identityNotes: text(item.identityNotes, 1_200) || undefined,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
      aspectRatio: text(item.aspectRatio, 16) || "16:9",
      firstFrameReference: item.firstFrameReference === true,
    };
  });
}

/** 从对白里取出每句台词的核心片段，用来确保模型没有在 {} 之外复述对白。 */
function dialogueExcerpts(dialogue: string) {
  return [...dialogue.matchAll(/[“"]([^”"]{6,})[”"]/gu)]
    .map((match) => match[1].replace(/\s+/gu, "").slice(0, 10))
    .filter(Boolean);
}

const INTERNAL_TERMS = /工作台|素材库|规则库|分镜审查|项目规则|Provider|接口|后端|像素|分辨率参数/u;
const ASKING_TERMS = /请(?:选择|确认|告诉我|提供)|需要(?:确认|补充|选择)|时长[^。\n]{0,8}(?:还是|或者)/u;

/** 提取正文中的 {} 包裹台词（官方台词符号）；容忍一层嵌套引号。 */
function extractBracedLines(text: string) {
  return [...String(text || "").matchAll(/\{([^{}]+)\}/gu)].map((match) =>
    match[1].trim(),
  );
}

/**
 * 台词比对前的归一化（2026-09-26 用户拍板放宽）：只关心「文字没有漂移」。
 * 空白与**全部标点**（中英文、引号、句读）都属排版噪声，不参与比对——
 * 2026-09-26 实测 glm-4-flash 高频把句尾「。」丢在 {} 外（3 次润色 1 次两连丢），
 * 逗号顿号互换也时有发生；这些都由「写回原文」机制还原，最终提示词的台词
 * 仍与对白原文逐字一致。
 * 语义改动（丢字、换字、增字、语序变化、把称呼语移到括号外）依然比对失败并拒收。
 */
function normalizeSpeechForCompare(value: string) {
  return String(value || "")
    .replace(/\s+/gu, "")
    .replace(/\p{P}/gu, "");
}

/** 空白不敏感的台词比对：模型可能在括号内折行。 */
function speechTextEqual(a: string, b: string) {
  return normalizeSpeechForCompare(a) === normalizeSpeechForCompare(b);
}

/**
 * 校验模型返回的润色结果（2026-09-17 镜头时序结构）：
 *  - script 为镜头时序正文，必须出现「镜头1」分段、长度达标；
 *  - 台词必须以官方 {} 符号原样嵌入：与对白原文逐字比对——数量一致、一字不改、
 *    无括号外复述；纯旁白镜不允许出现 {}；
 *  - 仍禁止内部术语、反问式措辞与【】小节标题（官方符号体系里【】= 字幕）。
 */
export function normalizeVideoPromptModelResult(
  value: unknown,
  briefs: VideoPromptBrief[],
): PolishedVideoPrompt[] {
  if (!record(value) || !Array.isArray(value.prompts)) {
    throw new Error("模型没有返回逐镜视频词");
  }
  const expected = new Set(briefs.map((brief) => brief.id));
  const results = new Map<string, { script: string; fallback?: boolean }>();
  for (const item of value.prompts) {
    if (!record(item)) throw new Error("模型返回的视频词格式无效");
    const id = text(item.id, 80);
    if (!expected.has(id) || results.has(id)) {
      throw new Error("模型返回了未知或重复的镜头 ID");
    }
    const brief = briefs.find((candidate) => candidate.id === id)!;
    const modelScript = text(item.script ?? item.prompt, 2_000);
    // 结构性错误不再把整条分镜卡死：模型漏掉「镜头1」或响应被截断时，
    // 用同一份已确认素材生成确定性模板。台词仍由下面的统一校验逐字保护，
    // 不会因为兜底而偷偷改写对白。
    const fallback = modelScript.length < 80 || !/镜头\s*1/u.test(modelScript);
    const script = fallback ? fallbackScriptForBrief(brief) : modelScript;
    // 以下 9 条都是「模型违反了内容规则」。同 2026-10-08 二轮决定：文案里不带镜头
    // 编号（服务端算不出对外展示的第几镜），编号由客户端补；句内其它定位信息
    // （哪个字段、第几句、共几句）一律保留——它们是用户能据此改素材的线索。
    for (const [field, content] of [["镜头正文", script]] as const) {
      if (INTERNAL_TERMS.test(content)) {
        throw new AiOutputRejected(`${field}混入了内部术语`);
      }
      if (ASKING_TERMS.test(content)) {
        throw new AiOutputRejected(`${field}混入了反问式措辞`);
      }
      if (content.includes("【")) {
        throw new AiOutputRejected(`${field}不应自带分节标题（【】是字幕符号）`);
      }
    }
    // 台词逐字校验：{} 内必须与对白原文一一对应、一字不改；{} 外不得复述对白。
    // 唯一被放行的是「多一层包裹引号」这种纯排版噪声——放行的同时把该句写回原文。
    const speakers = parseDialogueSpeakers(brief.dialogue);
    if (speakers.length === 0) {
      if (extractBracedLines(script).length > 0) {
        throw new AiOutputRejected("是无对白镜头，正文不应包含大括号台词");
      }
      results.set(id, { script: script.replace(/\s+$/u, ""), fallback: fallback || undefined });
    } else {
      let cursor = 0;
      let bracedIndex = 0;
      let repaired = "";
      for (const match of script.matchAll(/\{([^{}]+)\}/gu)) {
        const start = match.index ?? 0;
        const expected = speakers[bracedIndex]?.line;
        if (expected === undefined) {
          throw new AiOutputRejected(
            `台词括号数量超过了对白句数（${speakers.length} 句）`,
          );
        }
        if (!speechTextEqual(match[1], expected)) {
          throw new AiOutputRejected(
            `第 ${bracedIndex + 1} 句台词被改写，必须逐字使用原文`,
          );
        }
        const expectedSpeaker = speakers[bracedIndex].speaker;
        const leadContext = script.slice(Math.max(0, cursor), start).slice(-120);
        const previousSpeaker = speakers[bracedIndex - 1]?.speaker || "";
        const escapedSpeaker = expectedSpeaker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const hasExpectedSpeaker = new RegExp(
          `${escapedSpeaker}[^{}\\n]{0,60}说\\s*$`,
          "u",
        ).test(leadContext);
        const isContinuation =
          expectedSpeaker === previousSpeaker && /(?:随后|继续)说/u.test(leadContext);
        if (!hasExpectedSpeaker && !isContinuation) {
          throw new AiOutputRejected(
            `第 ${bracedIndex + 1} 句说话人标签与原对白不一致，应由「${expectedSpeaker}」开口`,
          );
        }
        repaired += script.slice(cursor, start) + `{${expected}}`;
        cursor = start + match[0].length;
        bracedIndex += 1;
      }
      if (bracedIndex !== speakers.length) {
        throw new AiOutputRejected(
          `台词括号数量（${bracedIndex}）与对白句数（${speakers.length}）不一致`,
        );
      }
      repaired += script.slice(cursor);
      const withoutBraces = repaired.replace(/\{[^{}]*\}/gu, "");
      for (const excerpt of dialogueExcerpts(brief.dialogue)) {
        if (withoutBraces.includes(excerpt)) {
          throw new AiOutputRejected("大括号外正文复述了对白");
        }
      }
      results.set(id, { script: repaired.replace(/\s+$/u, ""), fallback: fallback || undefined });
    }
  }
  // 批量润色时模型偶尔漏掉某个 ID；缺失项同样用确定性模板补齐，
  // 让单个镜头的模型波动不会阻塞整批结果。
  for (const brief of briefs) {
    if (!results.has(brief.id)) {
      results.set(brief.id, { script: fallbackScriptForBrief(brief), fallback: true });
    }
  }
  return briefs.map((brief) => ({ id: brief.id, ...results.get(brief.id)! }));
}

/** 把已清洗的 brief 转成无需模型参与的安全镜头模板。 */
function fallbackScriptForBrief(brief: VideoPromptBrief) {
  return buildFallbackShotScript({
    dialogue: brief.dialogue,
    performance: brief.performance,
    continuity: brief.continuity,
    constraints: brief.constraints,
    referenceNote: brief.referenceNote,
    actions: brief.actions.join("→"),
    estimatedSeconds: brief.seconds,
    aspectRatio: brief.aspectRatio,
    firstFrameReference: brief.firstFrameReference,
  });
}

/** 动作链按「→」拆分；找不到分隔符时整串作为单动作。 */
function splitActionChain(actions: string) {
  return String(actions || "")
    .split(/→/u)
    .map((item) => item.trim().replace(/[。.]$/u, ""))
    .filter(Boolean);
}

/**
 * 去掉行尾句末标点，避免与模板自己的标点叠成「。。」。
 *
 * 起因（2026-09-17 复盘真实提交的提示词）：`performance` 字段自带句号
 * （「由对应人物按顺序自然、清楚地完整说出原文对白。」），旧模板又补一个句号，
 * 于是正文里出现「；…原文对白。。」。
 */
function trimTrailingPunctuation(value: string) {
  return String(value || "")
    .trim()
    .replace(/[。.；;，,、]+$/u, "");
}

/** 逐句台词的引入词：同一说话人连续多句时只在首句写名字。 */
function dialogueLead(speaker: string, previousSpeaker: string) {
  if (speaker && speaker === previousSpeaker) return "随后继续说";
  return `${speaker}说`;
}

/**
 * 无润色时的回退正文：按官方镜头时序机械组装三段。
 * 2026-09-20（用户定案「每个人都是一个动作加一段对白」）：
 * 镜头1 开场承接（与说话人无关的场景动作，无台词）→
 * 镜头2 主体表演（提到谁的动作紧贴谁的对白：小陈的动作+小陈说{…}，随后王老师的
 * 动作+王老师说{…}；{} 台词原文逐字嵌入）→
 * 镜头3 收尾缓冲（剩余场景动作/特效 + 保持姿势、动作渐缓、无台词）。不写任何秒数。
 *
 * 2026-09-17 修三处语法缺陷（对照真实提交的提示词复盘，见各行的行内注释）：
 *  1. 句末标点重复 → trimTrailingPunctuation；
 *  2. 同一说话人重复姓名（「小李说{…}，小李说{…}」）→ dialogueLead；
 *  3. 镜头3 拼出「人物完成小李继续展示单据并说明数据后保持姿势」这种主语错乱
 *     → 改成「对白说完后，<收尾动作>，随后保持姿势、动作渐缓，无台词」，
 *       且只有 rest 里真的有第二个动作时才写收尾动作，避免与镜头2 重复同一句。
 */
export function buildFallbackShotScript(input: VideoPromptAssembly) {
  const actions = splitActionChain(input.actions);
  const speakers = parseDialogueSpeakers(input.dialogue);
  const performance =
    trimTrailingPunctuation(input.performance) ||
    (speakers.length ? "语气自然、神态连贯" : "动作连贯自然");
  // 2026-09-20（用户定案）：「每个人都是一个动作加一段对白」。旧做法把动作链第一段
  // 给镜头1、剩余动作整体拼在镜头2 开头——S1-E1-01 于是变成小陈的动作被镜头1 当
  // 「无台词开场」消耗掉、镜头2 只剩「王老师回应并说明原因」却排在 小陈的台词 前，
  // 模型读到「王老师回应」在前就让它先开口，两条成片身份互换。
  // 新规则：**提到谁的动作就归谁，紧贴在谁的对白之前**；不提任何说话人的句子
  // （场景/道具/特效）作镜头1 开场或镜头3 收尾。旧润色稿稳定，正是因为名字/动作/
  // 先后与对白天然同序——配对机制把这种「碰巧」变成确定性。
  const speakerOf = (clause: string) => {
    let best: { name: string; pos: number } | null = null;
    for (const name of new Set(speakers.map((item) => item.speaker).filter(Boolean))) {
      const pos = clause.indexOf(name);
      if (pos >= 0 && (!best || pos < best.pos)) best = { name, pos };
    }
    return best?.name ?? "";
  };
  const clausesBySpeaker = new Map<string, string[]>();
  const unbound: string[] = [];
  if (speakers.length) {
    for (const clause of actions) {
      const owner = speakerOf(clause);
      if (owner) {
        const list = clausesBySpeaker.get(owner) || [];
        list.push(clause);
        clausesBySpeaker.set(owner, list);
      } else {
        unbound.push(clause);
      }
    }
  }
  const lines: string[] = [];
  let openingFromUnbound = "";
  if (speakers.length) {
    // 镜头1 开场：首条与说话人无关的场景动作；没有则用通用承接——绝不占用任何
    // 说话人的动作（每个人的动作必须跟自己的对白在一起）。
    // 2026-09-25：通用承接由「环视所处环境」改为「人物保持原位的静止画面」——前者无主语，
    // 真机实测（c6765c46）豆包在确认卡里把「环视」自行指派给王老师先动，是身份
    // 错位的诱因之一；「保持原位」是状态不是动作，且措辞人数中立（单人/多人镜通用）。
    const opening =
      actions[0] && !speakerOf(actions[0])
        ? actions[0]
        : "人物保持原位的静止画面";
    openingFromUnbound = opening === actions[0] ? actions[0] : "";
    // 2026-09-18：不再硬写「固定机位」。静态参考图不是首帧，动作又常常需要人物离开
    // 原位（走近、推门、落座），写死机位会与动作打架——实测成片就是敲门之后原地回位。
    // 这里改成「镜头平稳」：不禁止必要的跟随，也不主动要求运镜。
    // 2026-09-19：补「自然闭嘴」+「缓慢展开」——实测成片开头 0.3 秒就进话/进动作，
    // 用户要求开头慢展开。
    lines.push(
      input.firstFrameReference
        ? `镜头1：第1张参考图作为本镜首帧，保持首帧中的人物位置、姿态、服装、道具和环境关系不变，从该状态自然承接到${trimTrailingPunctuation(opening)}，无台词。`
        : `镜头1：镜头平稳，人物自然闭嘴，稍作停顿后动作缓慢展开，自然过渡到${trimTrailingPunctuation(opening)}，无台词。`,
    );
    // 同一说话人有多个动作、多句台词时逐句分配：前面的句子多分（余数给首句），
    // 保证「动作→对白」节拍成对且不重复。
    const utteranceTotals = new Map<string, number>();
    for (const item of speakers) {
      utteranceTotals.set(item.speaker, (utteranceTotals.get(item.speaker) || 0) + 1);
    }
    const cursor = new Map<string, number>();
    let previousSpeaker = "";
    const pieces = speakers.map((item) => {
      const ownAll = clausesBySpeaker.get(item.speaker) || [];
      const seen = cursor.get(item.speaker) || 0;
      const total = utteranceTotals.get(item.speaker) || 1;
      const base = Math.floor(ownAll.length / total);
      const extra = ownAll.length % total;
      const size = base + (seen < extra ? 1 : 0);
      const own = ownAll.slice(seen, seen + size);
      cursor.set(item.speaker, seen + size);
      const lead = dialogueLead(item.speaker, previousSpeaker);
      previousSpeaker = item.speaker;
      const head = own.length ? `${own.map(trimTrailingPunctuation).join("，随后")}，` : "";
      return `${head}${lead}{${item.line}}`;
    });
    lines.push(`镜头2：${pieces.join("，随后")}，${performance}。`);
  } else {
    const opening = actions[0] || "画面交代所处环境与人物位置";
    const rest = actions.slice(1);
    const mainAction = trimTrailingPunctuation(
      rest.length ? rest.join("，随后") : "按分镜要求继续完成本镜动作",
    );
    lines.push(
      input.firstFrameReference
        ? `镜头1：第1张参考图作为本镜首帧，保持首帧中的人物位置、姿态、服装、道具和环境关系不变，从该状态自然承接到${trimTrailingPunctuation(opening)}，无台词。`
        : `镜头1：镜头平稳，人物自然闭嘴，稍作停顿后动作缓慢展开，自然过渡到${trimTrailingPunctuation(opening)}，无台词。`,
    );
    lines.push(`镜头2：${mainAction}，${performance}。`);
  }
  // 镜头3 收尾：剩余的场景/特效动作（不含已被镜头1 用作开场的那条）。
  const closingPool = openingFromUnbound
    ? unbound.filter((clause) => clause !== openingFromUnbound)
    : unbound;
  const closing = closingPool.length ? closingPool[closingPool.length - 1] : "";
  lines.push(
    closing
      ? `镜头3：对白说完后，${trimTrailingPunctuation(closing)}，随后人物自然闭嘴、保持姿势，动作渐缓，无台词。`
      : "镜头3：对白说完后，人物自然闭嘴，保持当前姿势，动作渐缓，无台词。",
  );
  return lines.join("\n");
}

export type VideoScriptWarning = {
  code:
    | "dialogue-in-closing-shot"
    | "camera-action-conflict"
    | "prop-contact-ambiguity"
    | "door-entry-order";
  message: string;
};

/** 「机位锁死」的写法。与下面的动作词同时出现即为自相矛盾。 */
const CAMERA_LOCK_PATTERN = /固定机位|镜头固定|机位固定|镜头锁定|机位锁定|静止机位/u;
/** 需要人物离开原位的动作词。 */
const SUBJECT_MOVE_PATTERN =
  /(?:进入|走进|走入|步入|踏入|跨过|跨入|推门|推开[\u4e00-\u9fff]{0,4}门|走出|离开|走向|走到|转身走向)/u;
/** 手持道具交接/放手时若没有明确接住或放置，模型容易生成悬浮道具。 */
const PROP_CONTACT_PATTERN = /(?:平板|手机|文件|单据|杯子|钥匙|笔记本|相机)/u;
const HAND_PATTERN = /左手|右手/u;
const HAND_RELEASE_PATTERN = /(?:放开|放下|松开|移开|离开)(?:左手|右手|手|平板|手机|文件|单据|杯子|钥匙|笔记本|相机)/u;

/**
 * 提示词结构告警（**不阻断提交**，只给用户看）。
 *
 * 2026-09-17：润色稿把第二句台词放进了「镜头3」收尾段，而官方三段结构与模板约定里
 * 镜头3 是无台词缓冲段。这类问题不能像「台词被改写」那样直接拒收——15 秒要塞下两句
 * 长台词时，模型把后一句后移未必更差；但用户有权知道结构被改了，所以做成可显示的告警。
 * 判定只看客观事实（大括号出现在收尾段），不做主观取舍。
 *
 * 2026-09-18 新增 `camera-action-conflict`：同一段里既写「固定机位」又写「进门/走到/跨过」
 * 这类需要离开原位的动作——这正是「敲门却没进门、对着空椅子说话」那支成片的提示词长相。
 * 模型面对这种自相矛盾的指令只能二选一，实测选了保机位。仍然是告警而不是拒收（用户有权
 * 保留某种拍法），但必须让用户在提交前看见。
 * 注意这条判定与台词无关，所以不能像旧版那样在「没有台词」时提前返回。
 */
export function videoScriptWarnings(
  script: string,
  dialogue: string,
): VideoScriptWarning[] {
  const text = String(script || "");
  if (!text) return [];
  const warnings: VideoScriptWarning[] = [];
  if (CAMERA_LOCK_PATTERN.test(text) && SUBJECT_MOVE_PATTERN.test(text)) {
    warnings.push({
      code: "camera-action-conflict",
      message:
        "提示词同时写了「固定机位」和需要人物离开原位的动作（进入/走到/跨过…）——两者矛盾，模型通常会保住机位、让人原地不动（实测出现过「敲门→开门→又退出来」这类成片）。建议把该动作改写成跟随主体移动的运镜，或拆成两个镜头。",
    });
  }
  if (PROP_CONTACT_PATTERN.test(text) && HAND_PATTERN.test(text) && HAND_RELEASE_PATTERN.test(text)) {
    warnings.push({
      code: "prop-contact-ambiguity",
      message:
        "提示词涉及手持道具的交接或放手，但没有明确写出另一只手接住或放到稳定支撑面。请固定一只手托住道具，或明确“先放到桌面再松手”，避免成片出现平板悬浮、穿手或瞬移。",
    });
  }
  const knockIndex = text.search(DOOR_KNOCK_PATTERN);
  const entryIndex = text.search(DOOR_ENTRY_PATTERN);
  if (knockIndex >= 0 && entryIndex >= 0 && entryIndex < knockIndex) {
    warnings.push({
      code: "door-entry-order",
      message:
        "润色稿把进门写在敲门前面了。系统提交时会强制改为“门口敲门一次 → 进入办公室 → 再与室内人物说话”；建议重新润色或检查动作素材是否也写反。",
    });
  }
  if (parseDialogueSpeakers(dialogue).length) {
    const closingIndex = text.search(/镜头\s*(?:[3-9]|\d{2,})/u);
    if (closingIndex >= 0 && /\{[^{}]+\}/u.test(text.slice(closingIndex))) {
      warnings.push({
        code: "dialogue-in-closing-shot",
        message:
          "有台词落在「镜头3」收尾段——约定里收尾段是无台词缓冲，结尾留白会被压缩。若想所有台词都留在镜头2，可点「立即重新润色」重试；长台词镜保留现状也可以。",
      });
    }
  }
  return warnings;
}

/**
 * 组装最终提交给豆包的视频提示词（2026-09-17 按官方公式重构，2026-09-18 改参考图语义）。
 *
 * 结构：参考图说明（置顶，官方「重要素材前置」）→ 一行指令头（防豆包反问）→
 * 一行参数 → 镜头时序正文（润色 script 或回退模板）→ 一行精简全局约束
 * （2026-09-19 二次精简：只留开头慢开口、结尾停顿收尾、运镜自洽三条）。
 * 删除了旧的【语速分配】秒数表、【语音要求】、【收尾要求】：官方明示精确时间
 * 不稳定，三段固定指令还与润色正文互相冲突；节奏一律交给镜头时序表达。
 * 台词以官方 {} 符号原样嵌入正文，不再单独输出对白段。
 */
export function buildVideoPromptText(input: VideoPromptAssembly) {
  const seconds = videoDurationBucket(input.targetSeconds ?? input.estimatedSeconds);
  const ratio = (input.aspectRatio || "16:9").trim() || "16:9";
  const rawScript = (input.script || "").trim() || buildFallbackShotScript(input);
  const script = normalizeContinuityOpening(rawScript, input.firstFrameReference);
  const doorSequence = doorEntrySequenceConstraint(`${input.actions}\n${script}`);
  const lines: string[] = [];
  if (input.referenceImageNote?.trim()) {
    lines.push(input.referenceImageNote.trim(), "");
  }
  const speakerIdentityNote = buildSpeakerIdentityNote(input.dialogue);
  if (speakerIdentityNote) lines.push(speakerIdentityNote, "");
  if (input.identityNote?.trim()) lines.push(input.identityNote.trim(), "");
  lines.push(
    VIDEO_PROMPT_DIRECTIVE,
    `时长 ${seconds} 秒，${ratio} 横屏。`,
    "",
    script,
    ...(doorSequence ? ["", doorSequence] : []),
    "",
    buildVideoGlobalConstraints(input.firstFrameReference),
  );
  return lines.join("\n");
}
