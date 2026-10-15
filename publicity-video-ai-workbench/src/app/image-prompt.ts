import { AiInputRejected, AiOutputRejected } from "./ai-output-rejection.ts";
import {
  cleanImagePromptForProvider,
  promptRuleInstruction,
} from "./workspace-memory.ts";

export type ImagePromptBrief = {
  id: string;
  title: string;
  scene: string;
  characters: string;
  dialogue: string;
  actions: string[];
  continuity: string;
  rules: string[];
  referenceAssets: string[];
  fallbackPrompt: string;
  /** 2026-09-17：该镜以上一镜已选图锚定画风/人物/场景（不再上传风格图与人物图）。
   * 润色重装时不再追加“参考上传风格图”兜底句，改为补参考图分工行。 */
  styleAnchored?: boolean;
};

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

/**
 * 画面词「主体」段的长度：**不设上限**。
 *
 * 2026-09-18 用户决策（原话）：「我觉得模型不要限制它的那个字数了，不然有时候反而会
 * 影响他的发挥，对他的约束越小越好。」
 *
 * 当天早些时候我们按「冗余治理」的思路加过一条 `MAX_IMAGE_PROMPT_BODY = 200` 的
 * 按句截断。复盘后确认那条是**治错了地方**：模型写不长的根因不是它话多，而是
 * **该给的上下文没喂进去**（台词、连续性、已命中规则、参考图说明此前全被扣在服务端），
 * 它只能靠猜来补空，猜出来的东西才变冗余。把字段补齐（见 image-prompt-request.ts）之后，
 * 用长度闸门去砍它的表达只会砍掉有效细节——同一段画面描述里，「小陈指着文件」
 * 和「坐在办公桌对面的王老师抬头」都是必要信息，机器无法分辨哪句该丢。
 *
 * 保留的只有一处**纯安全阀**：`normalizeImagePromptBriefs` / `normalizeImagePromptModelResult`
 * 的 `text(..., 2_000)` 单镜硬上限，它防的是模型失控刷屏，不是创作长度，
 * 正常输出（实测 300—500 字）离它很远。
 */

/**
 * 「元语句 / 否定指令」识别。
 *
 * 模型会把**给创作者看的建议**写进画面描述，例如：
 *   移除或简化背景中的电脑、文件柜等元素，确保环境与原场景设定一致。
 *   王老师的形象细节需调整，使其与上一镜头保持一致；镜头角度和站位需调整。
 * 这些句子对生图模型既不是画面事实、也不是明确禁令，只会污染权重、分散重点。
 * 否定指令（不要／避免／禁止）同样收敛到这里剔除——服务端尾部只保留一句
 * 「画面中不要出现额外的文字信息与提示框。」（2026-09-18 压缩，原句是四类否定堆叠）。
 */
const META_CLAUSE_PATTERN =
  /保持一致|确保|务必|建议|注意|可考虑|移除|删除|简化|优化|需调整|应调整|要调整|重新调整|同步更新|不得|不应|无需|不用|不要|不能|避免|禁止|不出现|不呈现|不添加|不新增/u;

/** 评价性短语（审片意见），只匹配出现在分句末尾的「对象＋评价词」结构。 */
const EVALUATIVE_CLAUSE_PATTERN =
  /[^，。；\n]{0,6}(?:简洁|紧凑|层次分明|主次分明|重点突出|主体突出|画面美观|美观|协调|和谐|得体|饱满|丰富|细腻|流畅|规范|专业|生动|合理|平衡|到位|完整|准确|清晰|明确|突出)(?!的)\s*$/u;

/**
 * 按分句剔除「元语句 / 否定指令」与「评价语」，保留其余画面事实。
 *
 * 只在分句粒度上判断（以 `，,；;。` 与换行切分，**不切顿号**——顿号是列表内
 * 分隔，切开会产生「文件柜等元素」这类碎片）。整条分句命中即整条删除，
 * 于是一段「事实＋建议＋建议」的句子会恰好只留下事实。
 */
export function stripImagePromptNoise(text: string) {
  const parts = text.split(/([，,；;。\n])/u);
  let result = "";
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index];
    const separator = parts[index + 1] ?? "";
    if (!clause.trim()) continue;
    if (META_CLAUSE_PATTERN.test(clause) || EVALUATIVE_CLAUSE_PATTERN.test(clause)) {
      // 整条剔除时把句末终止符补回上一条保留的分句，
      // 否则「事实，建议。」会被粘成「事实，」再把句号一起丢掉。
      if (
        (separator === "。" || separator === "\n")
        && result
        && !/[。\n]$/u.test(result)
      ) {
        result += separator;
      }
      continue;
    }
    result += clause + separator;
  }
  return result
    .replace(/[，,；;、]+(?=[。\n]|$)/gu, "")
    .replace(/([。])\1+/gu, "$1")
    .replace(/^[，,；;、\s]+/u, "")
    .trim();
}

/**
 * 视觉段落的去重键：只保留文字骨架（去掉标点与空白）。
 * 用于识别「分镜的 location 与 action[0] 本来是同一句话」这种重复，
 * 以及同一镜里被拆成多条的相同动作。
 */
export function visualSegmentKey(value: string) {
  return value
    .replace(/[\s，,。.；;：:、（）()“”"'‘’…－—·]/gu, "")
    .trim();
}

/**
 * 剔除与场景（location）重复的动作条目，并去掉动作之间的重复。
 *
 * 真实成因：分镜数据里 location 常常直接写成 action[0]（例如
 * location＝「审计人员A坐在办公桌前，桌上堆着报销单，电脑屏幕上调出两张报销单，
 * 分别标注：」，action[0] 一字不差）。旧模板把两者都拼进画面词，于是同一句话
 * 出现两遍、还留下「分别标注：。」这种残缺句。
 */
export function dedupeVisualSegments(location: string, actions: string[]) {
  const locationKey = visualSegmentKey(location);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const action of actions) {
    const key = visualSegmentKey(action);
    if (!key) continue;
    if (locationKey && (key === locationKey
      || locationKey.includes(key)
      || key.includes(locationKey))) {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(action);
  }
  return kept;
}

function cleanImagePromptField(value: string, trimTail = true) {
  const clean = value
    .replace(/^[^，。；\n]{0,6}(?:场景设定|地点设定|场景|地点)[：:]\s*/u, "")
    .trim();
  return trimTail ? clean.replace(/[，,；;：:、\s]+$/u, "").trim() : clean;
}

/**
 * 场景（scene）字段的清洗。
 *
 * 2026-09-18：`scene` 直接取自分镜的 `location`，而 location 常常带着分镜自己的
 * 字段标签——实测 S1-E1-02 发给模型的是「场景设定：办公室里，审计小陈站在办公桌前，
 * 与王老师沟通。」。`actions` 那条路径本来就有去标签规则（cleanImagePromptAction），
 * `scene` 这条路却漏了，等于把内部字段名当画面事实喂给了模型。
 */
export function cleanImagePromptScene(value: string) {
  return cleanImagePromptField(value);
}

export function normalizeImagePromptBriefs(value: unknown): ImagePromptBrief[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new Error("画面词润色数量必须为 1—24 条");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!record(item)) throw new Error("画面词润色输入无效");
    const id = text(item.id, 80);
    if (!id || seen.has(id)) throw new Error("镜头 ID 缺失或重复");
    seen.add(id);
    const scene = cleanImagePromptScene(text(item.scene, 800));
    const actions = strings(item.actions, 10, 500);
    // 2026-09-30：同 video-prompt——这是本地素材缺字段，不是模型输出问题。
    // 只有以上一镜已选图锚定画风时才允许没有动作（画面由参考图决定）。
    // 2026-10-08 二轮：文案里**不带镜头编号**——服务端拿不到分镜列表，算不出对外展示
    // 的「第几镜」，回显内部键只会让用户照着去找却找不到（界面上显示的是展示编号）。
    // 「是哪一镜」由客户端用 `shotDisplayLabel` 补在提示前面。
    if (!scene || (!actions.length && item.styleAnchored !== true)) {
      throw new AiInputRejected("缺少场景或动作");
    }
    return {
      id,
      title: text(item.title, 200),
      scene,
      characters: text(item.characters, 500),
      dialogue: text(item.dialogue, 3_000),
      actions,
      continuity: text(item.continuity, 1_000),
      rules: strings(item.rules, 12, 1_000),
      referenceAssets: strings(item.referenceAssets, 8, 300),
      fallbackPrompt: text(item.fallbackPrompt, 2_000),
      styleAnchored: item.styleAnchored === true,
    };
  });
}

export function cleanImagePromptAction(value: string) {
  let clean = value
    .replace(
      /(?:，|,)?(?:旁边)?(?:弹出|打出)\s*[“"]?[^，。；\n”"]*[”"]?(?:\s*(?:和|与)\s*[“"][^”"]*[”"])?/gu,
      "",
    )
    .replace(/(?:字幕|屏幕文字|提示框)[：:].*$/gu, "")
    .replace(/[❌✅⏰]/gu, "")
    // 台词绝不能进生图提示词——模型会试图把台词画成画面里的文字。
    // 真实成因：分镜 action 里写着「某教职工完整说出："小王，把你的身份证号…"」。
    // 只保留「开口说话」这个可见事实；「不呈现字幕文字」这半句由尾部那句统一的
    // 文字约束覆盖，不在这里重复，少一个否定词就少一分权重稀释。
    .replace(
      /(?:完整|连续|依次|逐字)?\s*(?:说完|说出|说道|说|念出|念|读出|复述)\s*[：:]?\s*[“"][^”"\n]*(?:[”"]|(?=[，。；\n]|$))/gu,
      "开口说话",
    )
    // 屏幕上可读的文字内容一律降级成「相关信息」（含未闭合的引号）。
    .replace(/[“"][^”"\n]{3,}(?:[”"]|(?=[，。；\n]|$))/gu, "相关信息")
    .replace(/[“"][^”"\n]{0,2}[”"]/gu, "")
    .trim();
  if (
    /(?:屏幕|处理笺|结算单|新闻|账单|报销单|凭单|明细|支付详情)/u.test(clean)
  ) {
    clean = clean
      .replace(/[“"]([^”"]+)[”"]/gu, "相关信息")
      .replace(
        /((?:处理笺|结算单|新闻|屏幕)[^，。；\n]{0,24}?)(?:写的是|显示为)[^，。；\n]+/gu,
        "$1呈现相关信息",
      );
  }
  const cleaned = cleanImagePromptField(clean, false)
    // 「…报销单，分别标注：」这类以冒号收尾却没有内容的残缺句。
    .replace(
      /[，,、]?\s*(?:分别|依次)?\s*(?:标注|标出|标明|写着|写的是|显示为|显示|呈现|内容为|注明)[：:]\s*$/u,
      "",
    )
    // 源素材里被截断的省略号残句（「…（人名可以*号代替），其…」）。
    .replace(/(?<=^|[，,、；;。\n])[^，。；\n]{0,8}…(?=[，。；\n]|$)/gu, "")
    .replace(/[，,；;：:、\s]+$/u, "")
    .trim();
  // 只剩「相关信息」的片段不携带任何可见信息，整条丢弃，
  // 避免拼出「画面呈现：相关信息相关信息；」这种空转。
  return /^(?:相关信息[，,、；;\s]*)+$/u.test(cleaned) ? "" : cleaned;
}

/**
 * 尾帧续镜不把对白改写成画面动作。
 *
 * 对白仍会发给模型，用于判断人物关系和表情，但最终画面词里不需要出现
 * 「某人说：……」「另一人回应：……」这类叙述；它们既不是新增视觉变化，
 * 还会把模型重新带回上一版的动作复述模板。普通首镜不走这条清洗。
 */
export function stripTailFrameDialogueActions(value: string) {
  const withoutDialogueActions = value.replace(
    /[^。；\n]*?(?:说|回应|表示|说明|确认处理)[：:]\s*[“"][^”"]*[”"][。]?/gu,
    "",
  );
  return withoutDialogueActions
    .split(/(?<=。)/u)
    .filter(
      (sentence) =>
        !/[“"][^”"]+[”"]/u.test(sentence) &&
        !/(?:说|回应|表示|说明|确认处理)[：:]/u.test(sentence),
    )
    .join("")
    .trim();
}

export function normalizeImagePromptModelResult(
  value: unknown,
  briefs: ImagePromptBrief[],
) {
  if (!record(value) || !Array.isArray(value.prompts)) {
    throw new Error("模型没有返回逐镜画面词");
  }
  const expected = new Set(briefs.map((brief) => brief.id));
  const prompts = new Map<string, string>();
  for (const item of value.prompts) {
    if (!record(item)) throw new Error("模型返回的画面词格式无效");
    const id = text(item.id, 80);
    let prompt = cleanImagePromptForProvider(text(item.prompt, 2_000));
    if (!expected.has(id) || prompts.has(id)) {
      throw new Error("模型返回了未知或重复的镜头 ID");
    }
    // 以下 5 条都是「模型违反了内容规则」——同 2026-10-08 二轮决定：文案不带镜头编号，
    // 编号由客户端补。其余信息（哪个字段、哪一处）保留。
    if (/(?:工作台|素材库|规则库|保留.{0,12}角色名|原对白)/u.test(prompt)) {
      throw new AiOutputRejected("画面词混入了内部操作说明");
    }
    if (/(?:人物参考图|用于锁定[^。；\n]{0,24}人物外观)/u.test(prompt)) {
      throw new AiOutputRejected("模型正文擅自添加了人物参考绑定");
    }
    if (prompt.length < 40) throw new AiOutputRejected("画面词过短");
    if (/(?:弹出|打出)\s*[“"]/u.test(prompt)) {
      throw new AiOutputRejected("混入了后期弹出文字");
    }
    // 2026-09-18：收紧模型自由发挥。剔除模型自己发明的「调整建议」式元语句与
    // 审片口吻的评价语——它们是真实成品里可验证的噪声（「王老师的形象细节需调整，
    // 使其与上一镜头保持一致」「场景简洁，人物互动清晰，信息突出」）。
    // 依据是用户实测反馈「有时加了很多自己的想法，提示词冗余，生图重点混乱」。
    // 注意：这里**不做长度截断**，长度闸门已按用户决策撤掉（见文件头部说明）。
    prompt = stripImagePromptNoise(prompt);
    if (prompt.length < 40) {
      throw new AiOutputRejected("画面词在剔除建议与评价语后过短");
    }
    const brief = briefs.find((candidate) => candidate.id === id)!;
    if (brief.styleAnchored) {
      prompt = stripTailFrameDialogueActions(prompt);
    }
    prompt = prompt
      .split(/(?<=。)/u)
      .filter(
        (sentence) =>
          !/(?:人物|服装|场景|道具|凭证)[^。]{0,40}(?:连续|接续|延续)|(?:连续|接续|延续)[^。]{0,40}(?:人物|服装|场景|道具|凭证)/u.test(
            sentence,
          ),
      )
      .join("")
      .replace(/[，,。]?\s*[^，。；\n]{1,16}(?:自然)?闭嘴(?=[，,。]|$)[，,。]?/gu, "")
      .replace(/[，,。]?\s*嘴部无遮挡(?=[，,。]|$)[，,。]?/gu, "")
      .trim();
    // 规则追加去重（2026-09-18）：既与模型主体比对，也与**已经收集进来的约束**比对。
    //
    // 真实缺陷：规则库里同一个「人物绑定」被存了两条（标题只差「（重复记录）」后缀），
    // 而 promptRuleInstruction 对绑定类规则返回的是同一句模板文案，
    // 旧实现只做 `.filter((x) => !prompt.includes(x))`——`prompt` 此时还只是模型主体，
    // 于是两条都通过过滤、同一句话被追加两遍。
    // 实测 S1-E1-02 重装后出现两行完全相同的「小陈的外观严格沿用上传的审计员A人物参考图…」。
    const ruleConstraints: string[] = [];
    for (const rule of brief.rules) {
      const [title, ...instruction] = rule.split("：");
      const constraint = promptRuleInstruction({
        title,
        instruction: instruction.join("："),
      });
      if (!constraint) continue;
      if (prompt.includes(constraint) || ruleConstraints.includes(constraint)) continue;
      ruleConstraints.push(constraint);
    }
    const fallbackCharacterConstraints = brief.fallbackPrompt
      .split(/\r?\n/u)
      .filter((line) => /人物图/u.test(line) && /(?:眼镜|发型|脸型|服装)/u.test(line))
      .filter((line) => !prompt.includes(line));
    prompt = [
      !/16\s*:\s*9/u.test(prompt) ? "16:9 横屏。" : "",
      brief.styleAnchored
        ? // 续镜以上一镜已选图锚定画风与人物场景：重装参考图分工行，绝不追加风格图兜底句
          //（该镜提交时不传风格图，加了会造成“引用了没传的图”的悬空约束）。
          "参考图为上一镜的已选画面：画风、人物外观与服装、场景环境严格以它为准，不另立风格；构图与动作按本镜分镜执行。"
        : !/(?:扁平|线条|MG)/u.test(prompt)
          // 2026-09-25（用户拍板）：画风句统一为「MG插画风格」——不再点名「剪映式
          // 扁平线条」，画风锚定交给上传的风格图本身（只参考画法），避免把参考图的
          // 具体流派名写死在提示词里、换风格图时提示词与素材脱节。
          // 2026-09-26（三版对照实验定案，用户拍板）：画风句采用「画法示范」形态——
          // 风格图必须含示范人物（锚住脸型画法，纯环境图会漂成卡通脸），但明确
          // 「图中人物不得作为本镜角色出场」（防身份泄露）；并禁姓名牌/桌牌等
          // 可读文字（B 版实证模型会在桌上写角色名）。
          ? "采用已上传风格图的MG插画风格。参考图仅作画风与人物画法示范：只参考它的线条、配色、人物五官比例与上色方式；图中人物不得作为本镜角色出场，其服装、发型、站位与场景布局一律不作参考。桌面上不得出现姓名牌、桌牌或任何带文字的物品；墙面文件与海报只画色块示意，不画文字线条。"
          : "",
      prompt.replace(/[。\s]+$/u, "") + "。",
      ...ruleConstraints,
      ...fallbackCharacterConstraints,
      brief.continuity ? `连续性保持：${brief.continuity}` : "",
      !/(?:首帧[^。；]{0,24}闭嘴|闭嘴[^。；]{0,24}首帧)/u.test(prompt)
        ? "首帧人物自然闭嘴，嘴部无遮挡。"
        : "",
      // 2026-09-18 用户决策：尾部这条负面约束从「不要字幕、姓名标签、提示框、
      // 无关人物或大段可读文字。」压缩成一句短句。原句把四类否定堆在一起，
      // 既稀释了主体画面的权重（生图模型对提示词尾部同样敏感，且否定词在
      // CLIP 类文本编码器里往往被忽略或被当作正向词），又和主体里的正向描述
      // 打架（模型写「红色框圈出关键内容」、尾部却写「不要提示框」）。
      // 现在只保留两条真正必要、且互不冲突的：不出现额外文字、不出现提示框。
      !/(?:不要|不出现|避免)[^。；]{0,24}(?:文字信息|提示框)/u.test(prompt)
        ? "画面中不要出现额外的文字信息与提示框。"
        : "",
    ].filter(Boolean).join("\n");
    prompts.set(id, prompt);
  }
  if (prompts.size !== briefs.length) throw new Error("模型遗漏了部分镜头");
  return briefs.map((brief) => ({ id: brief.id, prompt: prompts.get(brief.id)! }));
}
