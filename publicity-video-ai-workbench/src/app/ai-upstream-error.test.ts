import assert from "node:assert/strict";
import { mapAiUpstreamError } from "./ai-upstream-error.ts";
import {
  AI_INPUT_REJECTED_CODE,
  AI_OUTPUT_REJECTED_CODE,
  isDeterministicRejectionCode,
} from "./ai-output-rejection.ts";

const textPolicy = {
  authCode: "AI_AUTH_FAILED",
  upstreamCode: "AI_UPSTREAM_FAILED",
  fallbackMessage: (status: number) => `模型请求失败（${status}）`,
};

assert.deepEqual(
  mapAiUpstreamError(401, {}, textPolicy),
  { code: "AI_AUTH_FAILED", error: "模型请求失败（401）", status: 401 },
);
assert.deepEqual(
  mapAiUpstreamError(500, { error: { message: "服务繁忙" } }, textPolicy),
  { code: "AI_UPSTREAM_FAILED", error: "服务繁忙", status: 502 },
);
assert.deepEqual(
  mapAiUpstreamError(403, {}, {
    ...textPolicy,
    authStatuses: [401, 403],
    rateLimitCode: "AI_RATE_LIMITED",
  }),
  { code: "AI_AUTH_FAILED", error: "模型请求失败（403）", status: 403 },
);
assert.deepEqual(
  mapAiUpstreamError(429, {}, {
    ...textPolicy,
    authStatuses: [401, 403],
    rateLimitCode: "AI_RATE_LIMITED",
  }),
  { code: "AI_RATE_LIMITED", error: "模型请求失败（429）", status: 502 },
);
assert.deepEqual(
  mapAiUpstreamError(401, { error: "视觉模型密钥失效" }, {
    authCode: "VISION_AI_AUTH_FAILED",
    upstreamCode: "VISION_AI_UPSTREAM_FAILED",
    fallbackMessage: (status) => `视觉模型请求失败（${status}）`,
  }),
  { code: "VISION_AI_AUTH_FAILED", error: "视觉模型密钥失效", status: 401 },
);

// 2026-09-30：确定性拒收的分类边界。前端据此决定「不做自动重试」，
// 所以这里必须锁住「哪些码算确定性、哪些码仍应退避重试」。
assert.equal(isDeterministicRejectionCode(AI_OUTPUT_REJECTED_CODE), true);
assert.equal(isDeterministicRejectionCode(AI_INPUT_REJECTED_CODE), true);
// 上游瞬时失败必须继续走退避重试，不能被误判成确定性拒收。
assert.equal(isDeterministicRejectionCode("AI_UPSTREAM_FAILED"), false);
assert.equal(isDeterministicRejectionCode("AI_RATE_LIMITED"), false);
assert.equal(isDeterministicRejectionCode("AI_AUTH_FAILED"), false);
assert.equal(isDeterministicRejectionCode(undefined), false);
assert.equal(isDeterministicRejectionCode(""), false);

console.log("AI upstream error mapping checks passed");
