/**
 * AI 输出被服务端规则拒收（2026-09-17）。
 *
 * 背景：提示词润色链路上有一批「模型违反硬规则」的拒收——台词被改写、混入内部术语、
 * 反问式措辞、自带【】分节标题等。这类失败是**确定性的**：同样的输入重发给同一个模型，
 * 大概率还是同样的违规。此前前端把它们和「模型过载/网络超时」混在一起，盲目重试 2 次
 * （10 秒 + 30 秒），既浪费用户 40 秒，又把「模型改了我的台词」这种需要用户知情的问题
 * 报成了「重试也没成功」。
 *
 * 因此把它单独标一个 code：前端据此**不做自动重试**，直接把真实原因交回用户，
 * 并保留「用未润色模板提交」的逃生口（模板是机械组装，台词天然逐字正确）。
 *
 * 2026-10-08 二轮：这些文案**不再带镜头编号**。服务端拿不到分镜列表，算不出对外展示的
 * 「第几镜」（`S1-E1_01`），回显内部键（`S1-E1-04`）只会让用户照着界面去找却找不到。
 * 所以分工是：服务端说「错在哪」，客户端用 `shotDisplayLabel` 补「是哪一镜」。
 */
export class AiOutputRejected extends Error {
  readonly code = AI_OUTPUT_REJECTED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AiOutputRejected";
  }
}

export const AI_OUTPUT_REJECTED_CODE = "AI_OUTPUT_REJECTED";

/**
 * 输入不符合服务端最低契约（2026-09-30）。
 *
 * 背景：与上面的「模型输出被拒收」同类，但方向相反——出错的是**我们自己发上去的素材**，
 * 而不是模型吐回来的内容。最典型的是 `normalizeVideoPromptBriefs` 的
 * `缺少场景或动作`：某个存量镜头没有可用的场景或动作，服务端当场 400。
 *
 * 此前这个 400 和「模型过载/网络抖动」共用同一个 catch 兜底，前端于是按瞬时错误
 * 退避重试两次（10 秒 + 30 秒）——同样的输入必然同样失败，用户白白多等 40 秒，
 * 真正的病因（这一镜的素材不完整）被淹没在「重试也没成功」里。
 *
 * 所以给它一个独立 code：前端据此**不做自动重试**，直接把缺什么交回用户
 * （同样不带镜头编号，见上）。
 */
export class AiInputRejected extends Error {
  readonly code = AI_INPUT_REJECTED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AiInputRejected";
  }
}

export const AI_INPUT_REJECTED_CODE = "AI_INPUT_REJECTED";

/**
 * 是否属于「重发同样输入必然同样失败」的确定性拒收。
 *
 * 两类都符合这个性质：素材不符合契约、模型违反内容硬规则。
 * 上游 502/429/超时**不**在此列——那些重发一次有可能成功，继续走退避重试。
 */
export function isDeterministicRejectionCode(code: unknown) {
  return code === AI_OUTPUT_REJECTED_CODE || code === AI_INPUT_REJECTED_CODE;
}
