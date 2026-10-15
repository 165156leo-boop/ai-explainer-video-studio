export type PolishKind = "image" | "video";

export type PolishResult = {
  ok: boolean;
  error?: string;
  /**
   * 确定性拒收（模型违规或素材缺字段）。调用方据此停止退避重试。
   * 2026-09-30 起与 `code` 并存：`rejected` 仍表示「别再自动重试了」，
   * `code` 进一步说明是哪一类，供界面给出不同的下一步建议。
   */
  rejected?: boolean;
  /** 服务端返回的错误码（`AI_OUTPUT_REJECTED` / `AI_INPUT_REJECTED` 等）。 */
  code?: string;
};

type Waiter = (result: PolishResult) => void;

function key(kind: PolishKind, shotId: string) {
  return `${kind}:${shotId}`;
}

/**
 * Shared request state for image and video prompt polish work. Request-specific
 * fetches and persistence remain with the caller; this class owns only the
 * concurrency-independent lifecycle contract.
 */
export class PolishState {
  private readonly versions = new Map<string, number>();
  private readonly retries = new Map<string, number>();
  private readonly exhausted = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();

  begin(kind: PolishKind, shotId: string) {
    const stateKey = key(kind, shotId);
    const version = (this.versions.get(stateKey) ?? 0) + 1;
    this.versions.set(stateKey, version);
    return version;
  }

  isCurrent(kind: PolishKind, shotId: string, version: number) {
    return this.versions.get(key(kind, shotId)) === version;
  }

  invalidate(kind: PolishKind, shotId: string) {
    return this.begin(kind, shotId);
  }

  recordRetry(kind: PolishKind, shotId: string) {
    const stateKey = key(kind, shotId);
    const attempts = (this.retries.get(stateKey) ?? 0) + 1;
    this.retries.set(stateKey, attempts);
    return attempts;
  }

  hasRetry(kind: PolishKind, shotId: string) {
    return this.retries.has(key(kind, shotId));
  }

  isExhausted(kind: PolishKind, shotId: string) {
    return this.exhausted.has(key(kind, shotId));
  }

  reset(kind: PolishKind, shotId: string) {
    const stateKey = key(kind, shotId);
    this.retries.delete(stateKey);
    this.exhausted.delete(stateKey);
  }

  clear() {
    this.versions.clear();
    this.retries.clear();
    this.exhausted.clear();
  }

  settle(kind: PolishKind, shotId: string, result: PolishResult) {
    const stateKey = key(kind, shotId);
    const waiters = this.waiters.get(stateKey);
    if (!waiters) return;
    this.waiters.delete(stateKey);
    for (const settle of waiters) settle(result);
  }

  settleAll(result: PolishResult) {
    const pending = [...this.waiters.entries()];
    this.waiters.clear();
    for (const [, waiters] of pending) {
      for (const settle of waiters) settle(result);
    }
  }

  succeed(kind: PolishKind, shotId: string) {
    this.reset(kind, shotId);
    this.settle(kind, shotId, { ok: true });
  }

  exhaust(kind: PolishKind, shotId: string, result: PolishResult) {
    const stateKey = key(kind, shotId);
    this.retries.delete(stateKey);
    this.exhausted.add(stateKey);
    this.settle(kind, shotId, result);
  }

  waitFor(kind: PolishKind, shotId: string) {
    return new Promise<PolishResult>((resolve) => {
      const stateKey = key(kind, shotId);
      const waiters = this.waiters.get(stateKey) ?? [];
      waiters.push(resolve);
      this.waiters.set(stateKey, waiters);
    });
  }

  hasWaiters(kind: PolishKind, shotId: string) {
    return this.waiters.has(key(kind, shotId));
  }
}
