/**
 * 后台自动润色的结果汇总、重润判定与素材签名（polish-digest.ts）的回归测试。
 * 运行：npm run check:polish-digest
 *
 * 每一组都对应一个真实故障或真实约束（2026-10-08）：
 *  - 汇总：每镜各弹一条 2.6 秒 toast，后一条覆盖前一条，用户看到「一串不知道发生了
 *    什么的提示」；
 *  - 重润：签名只存在内存 Map 里，刷新即清空，于是每次登录都把全部可用镜头重润一遍；
 *  - 签名：必须包含参考图、必须在换图时变化、必须短到能落盘（真实数据单张图约 2 MB）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AutoPolishBatch,
  needsVideoPromptRepolish,
  summarizeAutoPolish,
  videoPromptSourceSignature,
  type VideoPromptSourceFields,
} from "./polish-digest.ts";

test("空结果不产生通知（没有结果就不该弹窗）", () => {
  assert.equal(summarizeAutoPolish([]), null);
});

test("全部拿到模型输出时为正常色，摘要写明镜数", () => {
  const digest = summarizeAutoPolish([
    { label: "S1-E1_01", source: "model", model: "glm-4.7-flash" },
    { label: "S1-E1_02", source: "model", model: "glm-4.7-flash" },
  ]);
  assert.ok(digest);
  assert.equal(digest.tone, "ok");
  assert.match(digest.message, /本次自动润色 2 镜/u);
  assert.match(digest.message, /模型 2 镜/u);
  assert.match(digest.message, /模板兜底 0 镜/u);
  assert.deepEqual(digest.detail, [
    "S1-E1_01 · glm-4.7-flash",
    "S1-E1_02 · glm-4.7-flash",
  ]);
});

test("有镜头走模板兜底时转为警告色，明细里点名是哪几镜", () => {
  const digest = summarizeAutoPolish([
    { label: "S2-E1_01", source: "fallback", model: "glm-4-flash-250414" },
    { label: "S2-E1_02", source: "model", model: "glm-4-flash-250414" },
    { label: "S3-E1_01", source: "fallback", model: "glm-4-flash-250414" },
  ]);
  assert.ok(digest);
  assert.equal(digest.tone, "warn");
  assert.match(digest.message, /模型 1 镜 · 模板兜底 2 镜/u);
  // 兜底镜不展示模型名——那一次的模型原文已被丢弃，写上去等于暗示是它写的。
  assert.equal(digest.detail[0], "S2-E1_01 · 模板兜底（未拿到模型输出）");
  assert.equal(digest.detail[1], "S2-E1_02 · glm-4-flash-250414");
  assert.equal(digest.detail[2], "S3-E1_01 · 模板兜底（未拿到模型输出）");
});

test("没有润色结果时必须重润", () => {
  assert.equal(
    needsVideoPromptRepolish({ hasPolished: false, currentSignature: "a" }),
    true,
  );
});

test("落盘签名与当前素材一致时跳过——这是跨会话不再重跑的判据", () => {
  assert.equal(
    needsVideoPromptRepolish({
      hasPolished: true,
      storedSignature: "a",
      currentSignature: "a",
    }),
    false,
  );
});

test("落盘签名落后于当前素材时必须重润", () => {
  assert.equal(
    needsVideoPromptRepolish({
      hasPolished: true,
      storedSignature: "a",
      currentSignature: "b",
    }),
    true,
  );
});

test("存量项目没有落盘签名时靠会话签名兜底，避免同一次会话内重复润色", () => {
  assert.equal(
    needsVideoPromptRepolish({
      hasPolished: true,
      sessionSignature: "a",
      currentSignature: "a",
    }),
    false,
  );
  assert.equal(
    needsVideoPromptRepolish({
      hasPolished: true,
      sessionSignature: "a",
      currentSignature: "b",
    }),
    true,
  );
  // 两路签名都没有（落盘字段是本次新增，存量项目必为空）→ 只能重润一次。
  assert.equal(
    needsVideoPromptRepolish({ hasPolished: true, currentSignature: "b" }),
    true,
  );
});

test("刷新后落盘签名仍在：即使内存签名已清空也不重跑", () => {
  // 这正是修复前「每次登录重跑一遍」的场景：内存 Map 随刷新清空。
  assert.equal(
    needsVideoPromptRepolish({
      hasPolished: true,
      storedSignature: "a",
      sessionSignature: undefined,
      currentSignature: "a",
    }),
    false,
  );
});

function shotFor(overrides: Partial<VideoPromptSourceFields> = {}): VideoPromptSourceFields {
  return {
    id: "S1-E1-01",
    title: "核查发现",
    location: "办公室",
    speaker: "小陈",
    dialogue: "小陈：“信息与实际对不上。”",
    action: ["小陈指向凭证"],
    prompt: {
      reference: "参考说明",
      action: "画面动作",
      dialogue: "表演说明",
      constraints: "约束",
    },
    continuity: "延续上一镜",
    image: "data:image/png;base64,AAAA",
    estimatedSeconds: 12,
    ...overrides,
  };
}

test("素材签名短且稳定：同一素材反复求值结果不变", () => {
  const shot = shotFor();
  const first = videoPromptSourceSignature(shot);
  assert.equal(videoPromptSourceSignature(shot), first);
  assert.equal(first.length, 24);
});

test("改任一素材字段签名都变化——否则会拿旧润色稿当新结果", () => {
  const base = videoPromptSourceSignature(shotFor());
  const changed = [
    shotFor({ title: "改了标题" }),
    shotFor({ location: "走廊" }),
    shotFor({ speaker: "王老师" }),
    shotFor({ dialogue: "小陈：“换了台词。”" }),
    shotFor({ action: ["小陈合上凭证"] }),
    shotFor({ continuity: "不延续上一镜" }),
    shotFor({ estimatedSeconds: 15 }),
    shotFor({ videoSecondsOverride: 10 }),
    shotFor({ prompt: { reference: "换了", action: "画面动作", dialogue: "表演说明", constraints: "约束" } }),
  ];
  for (const shot of changed) {
    assert.notEqual(videoPromptSourceSignature(shot), base);
  }
});

test("换参考图签名必须变化：参考图决定视觉身份匹配，也就决定润色结果", () => {
  const before = videoPromptSourceSignature(shotFor());
  const after = videoPromptSourceSignature(
    shotFor({ image: "data:image/png;base64,BBBB" }),
  );
  assert.notEqual(after, before);
  // 无参考图与有参考图同样要区分开。
  assert.notEqual(videoPromptSourceSignature(shotFor({ image: undefined })), before);
});

test("两 MB 的参考图不会让签名变长（它要能落盘进项目 JSON）", () => {
  const huge = `data:image/png;base64,${"A".repeat(2_000_000)}`;
  assert.equal(videoPromptSourceSignature(shotFor({ image: huge })).length, 24);
});

test("一轮润色收齐全部镜头后才结算，中途不给汇总", () => {
  const batch = new AutoPolishBatch();
  batch.expect(["S1-E1-01", "S1-E1-02", "S2-E1-01"]);
  assert.equal(batch.settled, false);
  assert.equal(batch.idle, false);
  batch.record("S1-E1-01", { label: "S1-E1_01", source: "model", model: "m" });
  batch.record("S1-E1-02", { label: "S1-E1_02", source: "fallback", model: "m" });
  assert.equal(batch.settled, false, "还有一镜没回来，不能提前结算");
  batch.record("S2-E1-01", { label: "S2-E1_01", source: "model", model: "m" });
  assert.equal(batch.settled, true);
  const digest = batch.take();
  assert.ok(digest);
  assert.match(digest.message, /本次自动润色 3 镜：模型 2 镜 · 模板兜底 1 镜/u);
  assert.equal(digest.tone, "warn");
});

test("失败/拒收的镜头从等待名单里摘掉，不会让汇总永远等下去", () => {
  const batch = new AutoPolishBatch();
  batch.expect(["S1-E1-01", "S1-E1-02"]);
  batch.record("S1-E1-01", { label: "S1-E1_01", source: "model", model: "m" });
  // 失败提示单独弹（它带着「下一步做什么」），但这一镜不再算在本轮等待里。
  batch.abandon("S1-E1-02");
  assert.equal(batch.settled, true);
  const digest = batch.take();
  assert.ok(digest);
  // 只汇总真正出结果的那一镜——不把失败算进「模型 N 镜」。
  assert.match(digest.message, /本次自动润色 1 镜：模型 1 镜 · 模板兜底 0 镜/u);
});

test("同一镜重试再次入队不会把批次放大", () => {
  const batch = new AutoPolishBatch();
  batch.expect(["S1-E1-01"]);
  batch.expect(["S1-E1-01"]);
  batch.record("S1-E1-01", { label: "S1-E1_01", source: "model", model: "m" });
  assert.equal(batch.settled, true);
  assert.equal(batch.take()?.detail.length, 1);
});

test("take 之后批次清空，下一轮从零开始", () => {
  const batch = new AutoPolishBatch();
  assert.equal(batch.idle, true);
  batch.expect(["S1-E1-01"]);
  batch.record("S1-E1-01", { label: "S1-E1_01", source: "model", model: "m" });
  assert.ok(batch.take());
  assert.equal(batch.idle, true);
  assert.equal(batch.take(), null, "本轮没有结果就不该再弹一次");
});

console.log("polish digest, repolish gate, source signature, and batch checks passed");
