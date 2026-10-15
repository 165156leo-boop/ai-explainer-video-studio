import type { VideoPromptSources } from "./video-prompt-input";

/**
 * 后台自动润色的**结果汇总**与**是否需要重润**判定（2026-10-08）。
 *
 * 这两件事都不该继续堆在 `page.tsx` 里：
 *
 * 1. 汇总文案。视频词润色是**按镜头串行**跑的全后台任务，早先每镜完成时各弹一条
 *    toast、且每条只停留 2.6 秒——后一条覆盖前一条。用户看到的就是一串互不相关的
 *    短句，原话：「我一登录，右下角就会一直弹出这些提示，我根本不知道他发生了什么，
 *    也不知道他改动了哪些，他就全做完了」。把 N 镜结果压成一条可展开的通知，是纯计算。
 *
 * 2. 重润判定。早先只有 `page.tsx` 里内存的 `Map` 记录「这一镜的哪个素材签名已润过」，
 *    刷新页面即清空，于是每次登录都把全部可用镜头重润一遍。现在多了一路**落盘签名**
 *    （`videoPromptPolished.sourceSignature`）。判据本身必须可单测——一次误判要么让
 *    已润色的结果被无谓重跑，要么让改过素材的镜头继续用旧稿。
 *
 * 素材签名同时在这里做两件事：把「哪些字段决定视频词」这件事集中到一处，并把它压成
 * 定长短串。压短是必须的——签名里有参考图的 dataURL（真实数据单张约 2 MB），
 * 既不能原样落盘、也不该进内存 Map 的键。
 */

/** 这一镜的结果是模型写的，还是服务端确定性模板兜的底。 */
export type AutoPolishSource = "model" | "fallback";

export type AutoPolishOutcome = {
  /** 对外展示编号（如 `S2-E1_01`），不是内部键。 */
  label: string;
  source: AutoPolishSource;
  /** 实际使用的模型名，用于明细行。兜底时模型原文被丢弃，不展示。 */
  model: string;
};

export type AutoPolishDigest = {
  /** 一行摘要。 */
  message: string;
  /** 逐镜明细，展开可见。 */
  detail: string[];
  /** 只要有一镜是模板兜底就报警告色——那是「润色没真正发生」的信号。 */
  tone: "ok" | "warn";
};

const FALLBACK_DETAIL = "模板兜底（未拿到模型输出）";

/**
 * 把本轮后台自动润色的逐镜结果压成一条通知。
 * 空数组返回 `null`：没有结果就不该弹窗。
 */
export function summarizeAutoPolish(
  outcomes: AutoPolishOutcome[],
): AutoPolishDigest | null {
  if (!outcomes.length) return null;
  const fallback = outcomes.filter((item) => item.source === "fallback").length;
  const modeled = outcomes.length - fallback;
  return {
    message: `本次自动润色 ${outcomes.length} 镜：模型 ${modeled} 镜 · 模板兜底 ${fallback} 镜`,
    detail: outcomes.map(
      (item) =>
        `${item.label} · ${item.source === "fallback" ? FALLBACK_DETAIL : item.model}`,
    ),
    tone: fallback ? "warn" : "ok",
  };
}

/**
 * 一轮后台自动润色的收集器（2026-10-08）。
 *
 * ## 为什么要「一轮」而不是「一镜一条」
 *
 * 润色是按镜头串行跑的全后台任务，一镜约 3 秒。早先每镜完成时各弹一条 toast、
 * 每条只停留 2.6 秒——后一条覆盖前一条。用户看到的就是一串互不相关的短句，
 * 既不知道总共发生了什么，也不知道哪些镜被改过。
 *
 * ## 为什么故意不收集失败
 *
 * 失败提示是**可操作的**（「已重试 2 次仍未成功——可改素材，或重新点生成」），
 * 压进汇总就会丢掉下一步该做什么。所以失败照旧单独弹，只是把它从本轮的等待名单里
 * 摘掉（`abandon`），好让汇总不至于永远等一个已经不会回来的镜头。
 *
 * 这个类不持有定时器：超时由调用方兜底，判定本身保持可单测。
 */
export class AutoPolishBatch {
  private pending = new Set<string>();
  private outcomes: AutoPolishOutcome[] = [];

  /** 登记本轮要润的镜头。重复登记（同一镜重试再次入队）不会放大批次。 */
  expect(shotIds: string[]) {
    for (const id of shotIds) this.pending.add(id);
  }

  /** 记一镜的最终润色结果（拿到模型输出，或服务端模板兜底）。 */
  record(shotId: string, outcome: AutoPolishOutcome) {
    this.pending.delete(shotId);
    this.outcomes.push(outcome);
  }

  /**
   * 这一镜不再等它了：失败已达上限、或确定性拒收（它有自己的可操作提示，
   * 且重发同样输入也只会同样失败）。
   */
  abandon(shotId: string) {
    this.pending.delete(shotId);
  }

  /** 本轮是否已无人可等——可以立刻汇总了。 */
  get settled() {
    return this.pending.size === 0;
  }

  /** 本轮既没有已收集的结果、也没有在等的镜头（说明还没开张）。 */
  get idle() {
    return this.pending.size === 0 && this.outcomes.length === 0;
  }

  /** 取出并清空：调用方拿到 `null` 表示本轮没有任何可汇报的结果。 */
  take(): AutoPolishDigest | null {
    const digest = summarizeAutoPolish(this.outcomes);
    this.pending.clear();
    this.outcomes = [];
    return digest;
  }
}


/**
 * 这一镜还需不需要重润。三路信息按可信度排列：
 *
 * 1. `hasPolished` 为假：压根没有结果 → 必须润；
 * 2. `storedSignature`（落盘、跨会话有效）：等于当前素材签名 → 结果就是当前的，跳过。
 *    这是本次新增的一路，也是「每次登录都重跑一遍」的根治点；
 * 3. `sessionSignature`（内存、只在本页会话内有效）：等于当前签名 → 本会话已润过，跳过。
 *    存量项目没有落盘签名，靠它避免同一次会话里重复润色。
 *
 * 三者都不满足 → 素材相对结果是新的，必须重润。
 */
export function needsVideoPromptRepolish(input: {
  hasPolished: boolean;
  storedSignature?: string;
  sessionSignature?: string;
  currentSignature: string;
}): boolean {
  if (!input.hasPolished) return true;
  // 已有落盘签名时它才代表结果；入队写下的会话签名不能让旧稿冒充新稿。
  if (input.storedSignature) return input.storedSignature !== input.currentSignature;
  if (input.sessionSignature && input.sessionSignature === input.currentSignature) {
    return false;
  }
  return true;
}

/**
 * 视频词润色只依赖这些素材字段。签名相同即复用已有润色结果；
 * 2026-09-16：润色改为后台自动执行后，靠它判断「素材变了，需要重新润色」。
 *
 * `image`（本镜参考图）必须在内：它不是发给文本模型的素材，但**决定视觉身份匹配的
 * 输入**（`requestPolishedVideoPrompts` 用 `shot.image` 当场景图），换图会改变
 * `identityNotes`，也就改变润色结果。
 */
export type VideoPromptSourceFields = {
  id: string;
  title: string;
  location: string;
  speaker: string;
  dialogue: string;
  action: string[];
  prompt: {
    reference: string;
    action: string;
    dialogue: string;
    constraints: string;
  };
  continuity: string;
  image?: string;
  videoSecondsOverride?: number;
  estimatedSeconds?: number;
};

function videoPromptSourceFields(shot: VideoPromptSourceFields) {
  return [
    shot.id,
    shot.title,
    shot.location,
    shot.speaker,
    shot.dialogue,
    shot.action.filter(Boolean).join("~"),
    shot.prompt.reference,
    shot.prompt.action,
    shot.prompt.dialogue,
    shot.prompt.constraints,
    shot.continuity,
    shot.videoSecondsOverride ?? "auto",
    shot.estimatedSeconds ?? 0,
  ];
}

/**
 * 32 位 FNV-1a。用两个不同种子各跑一遍拼成 16 位十六进制，够短也够稳。
 * 不用 `crypto`：签名在浏览器端计算，且这里只需要「变了就一定不同」的工程强度。
 */
function fnv1a(input: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 按镜头对象缓存签名。参考图 dataURL 单张约 2 MB，而调用点（`videoPromptSourceKey`）
 * 在**每次渲染**都会对所有镜头求一遍签名——不缓存的话，改一个字段要重算全部图片的哈希。
 * 命中条件是「同一对象 + 小字段未变 + 参考图仍是同一个字符串实例」，
 * 编辑走的是 `{...shot}` 不可变更新，因此任何一次真实改动都会落到未命中分支重算。
 */
const signatureCache = new WeakMap<
  VideoPromptSourceFields,
  { fields: string; image?: string; signature: string }
>();

export function videoPromptSourceSignature(shot: VideoPromptSourceFields): string {
  const fields = JSON.stringify(videoPromptSourceFields(shot));
  const cached = signatureCache.get(shot);
  if (cached && cached.fields === fields && cached.image === shot.image) {
    return cached.signature;
  }
  const signature = `${fnv1a(fields, 0x811c9dc5)}${fnv1a(shot.image ?? "", 0x811c9dd7)}${fnv1a(fields, 0x9e3779b1)}`;
  signatureCache.set(shot, { fields, image: shot.image, signature });
  return signature;
}

// 大图只在内容变化时重算，缓存有界，避免每次打字都重扫多张 base64 图片。
const referenceHashes = new Map<string, string>();
function referenceHash(value = "") {
  let hash = referenceHashes.get(value);
  if (!hash) {
    hash = `${fnv1a(value, 0x811c9dc5)}${fnv1a(value, 0x9e3779b1)}`;
    if (referenceHashes.size >= 32) referenceHashes.delete(referenceHashes.keys().next().value!);
    referenceHashes.set(value, hash);
  }
  return hash;
}

/** 版本化签名覆盖文本、实际场景参考、角色图/绑定、衔接对象和所用模型。 */
export function videoPromptInputSignature(shot: VideoPromptSourceFields, sources: VideoPromptSources, model: string) {
  const dependencies = JSON.stringify([
    videoPromptSourceSignature(shot), referenceHash(sources.sceneImage),
    sources.continuityShotId, sources.firstFrameReference, sources.bindings,
    sources.references.map(reference => [reference.roleName, reference.characterName, referenceHash(reference.image)]),
    model,
  ]);
  return `v2-${referenceHash(dependencies)}`;
}
