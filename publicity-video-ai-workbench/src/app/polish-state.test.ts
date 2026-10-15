import assert from "node:assert/strict";
import { PolishState } from "./polish-state.ts";

const state = new PolishState();

const imageV1 = state.begin("image", "S1");
const videoV1 = state.begin("video", "S1");
assert.equal(state.isCurrent("image", "S1", imageV1), true);
assert.equal(state.isCurrent("video", "S1", videoV1), true);
assert.equal(state.isCurrent("image", "S1", videoV1 + 1), false);
const imageV2 = state.begin("image", "S1");
assert.equal(state.isCurrent("image", "S1", imageV1), false, "late image results must become stale");
assert.equal(state.isCurrent("image", "S1", imageV2), true);
assert.equal(state.isCurrent("video", "S1", videoV1), true, "image updates must not invalidate video work");
state.invalidate("image", "S1");
assert.equal(state.isCurrent("image", "S1", imageV2), false, "input changes must invalidate queued results");

const firstWaiter = state.waitFor("image", "S1");
const secondWaiter = state.waitFor("image", "S1");
assert.equal(state.hasWaiters("image", "S1"), true);
state.succeed("image", "S1");
assert.deepEqual(await firstWaiter, { ok: true });
assert.deepEqual(await secondWaiter, { ok: true });
assert.equal(state.hasWaiters("image", "S1"), false, "waiters must settle exactly once");
state.succeed("image", "S1");

assert.equal(state.recordRetry("video", "S1"), 1);
assert.equal(state.recordRetry("video", "S1"), 2);
assert.equal(state.hasRetry("video", "S1"), true);
const rejectedWaiter = state.waitFor("video", "S1");
state.exhaust("video", "S1", { ok: false, error: "AI_OUTPUT_REJECTED", rejected: true });
assert.deepEqual(await rejectedWaiter, { ok: false, error: "AI_OUTPUT_REJECTED", rejected: true });
assert.equal(state.hasRetry("video", "S1"), false, "rejected work must not remain scheduled for retry");
assert.equal(state.isExhausted("video", "S1"), true);
assert.equal(state.isExhausted("image", "S1"), false, "exhaustion is scoped by prompt kind");

state.reset("video", "S1");
assert.equal(state.isExhausted("video", "S1"), false, "manual retry resets exhaustion");
assert.equal(state.hasRetry("video", "S1"), false);

const projectSwitchImage = state.waitFor("image", "S2");
const projectSwitchVideo = state.waitFor("video", "S2");
state.clear();
state.settleAll({ ok: false, error: "已切换项目" });
assert.deepEqual(await projectSwitchImage, { ok: false, error: "已切换项目" });
assert.deepEqual(await projectSwitchVideo, { ok: false, error: "已切换项目" });

console.log("polish state checks passed");
