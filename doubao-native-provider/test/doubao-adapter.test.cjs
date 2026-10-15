const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ABILITY_VIDEO_MODELS,
  configureImageGenerationOptions,
  confirmSubmissionAccepted,
  resolveAbilityVideoModel,
  validateVideoRequest,
} = require("../src/doubao-adapter.cjs");

function stubWebContents() {
  return {
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: async () => undefined,
    },
  };
}

test("image controls can settle after the composer appears", async () => {
  let ratioChecks = 0;
  const dispatched = [];
  const webContents = {
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: async (method, payload) => dispatched.push({ method, payload }),
    },
  };
  const selectOption = async (_webContents, requested) => {
    if (String(requested).includes(":")) {
      ratioChecks += 1;
      return { selected: ratioChecks >= 2, reason: ratioChecks >= 2 ? "" : "control-not-found" };
    }
    return { selected: true, reason: "" };
  };
  const result = await configureImageGenerationOptions(
    webContents,
    { model: "seedream-4.5", aspect_ratio: "16:9" },
    selectOption,
    async () => undefined,
  );
  assert.equal(result.model.selected, true);
  assert.equal(result.aspectRatio.selected, true);
  assert.equal(ratioChecks, 2);
  assert.deepEqual(dispatched.map((item) => item.payload.type), ["keyDown", "keyUp"]);
});

test("video model ids map to Doubao ability params", () => {
  assert.deepEqual(Object.keys(ABILITY_VIDEO_MODELS).sort(), [
    "seedance-2.0",
    "seedance-2.0-fast",
    "seedance-2.0-mini",
  ]);
  assert.equal(resolveAbilityVideoModel("seedance-2.0").param, "seedance_v2.0");
  assert.equal(resolveAbilityVideoModel("seedance-2.0-fast").param, "seedance_v2.0_fast");
  assert.equal(resolveAbilityVideoModel("seedance-2.0-mini").param, "seedance_v2.0_mini");
  // 未知或空值一律回落到 Mini（成本最低、且 4–15 秒都支持）
  assert.equal(resolveAbilityVideoModel("").param, "seedance_v2.0_mini");
  assert.equal(resolveAbilityVideoModel("Seedance 2.5").param, "seedance_v2.0_mini");
});

test("standard Seedance 2.0 rejects durations beyond its 5 second tier", () => {
  // 2026-09-16 用户决策：标准 2.0 只支持 5 秒档，冲突时拦下让用户改模型或缩短对白，
  // 不做静默降级、也不把对白截断。
  const conflict = validateVideoRequest("seedance-2.0", 15);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "VIDEO_MODEL_DURATION_CONFLICT");
  assert.equal(conflict.duration, 15);
  assert.match(conflict.reason, /只支持 5 秒档/);

  const exact = validateVideoRequest("seedance-2.0", 5);
  assert.equal(exact.ok, true);
  assert.equal(exact.model.param, "seedance_v2.0");
  assert.equal(exact.duration, 5);
});

test("duration is clamped into the 4-15 second range for the ability request", () => {
  assert.equal(validateVideoRequest("seedance-2.0-fast", 0).duration, 5);
  assert.equal(validateVideoRequest("seedance-2.0-fast", 1).duration, 4);
  assert.equal(validateVideoRequest("seedance-2.0-fast", 99).duration, 15);
  assert.equal(validateVideoRequest("seedance-2.0-fast", "10").duration, 10);
  assert.equal(validateVideoRequest("seedance-2.0-fast", "10").ok, true);
});

test("Mini tops out at 10 seconds because Doubao gates 15s behind subscription", () => {
  // 2026-09-16 实测：账号 1 与账号 2 提交 seedance_v2.0_mini + 15 秒都被回
  // 「订阅标准套餐专属能力」；同一账号 mini + 10 秒正常；fast + 15 秒可以出片。
  const blocked = validateVideoRequest("seedance-2.0-mini", 15);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "VIDEO_MODEL_DURATION_CONFLICT");
  assert.equal(blocked.model.maxDuration, 10);
  assert.equal(validateVideoRequest("seedance-2.0-mini", 10).ok, true);
  assert.equal(validateVideoRequest("seedance-2.0-fast", 15).ok, true);
});

test("a Doubao refusal is reported with its own wording instead of waiting", async () => {
  const refusing = {
    executeJavaScript: async () => ({
      generating: false,
      promptVisible: true,
      composerHoldsPrompt: false,
      refusal: "出了点问题",
    }),
  };
  const outcome = await confirmSubmissionAccepted(refusing, "【画面参考】测试提示词", {
    wait: async () => undefined,
    timeoutMs: 1_200,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.refusal, "出了点问题");
});

test("a submission that never reaches the conversation fails fast", async () => {
  const script = (state) => ({ executeJavaScript: async () => state });
  const prompt = "【画面参考】使用人工选定的参考图作为画面基础。";

  const rejected = await confirmSubmissionAccepted(script({ generating: false, promptVisible: false }), prompt, {
    wait: async () => undefined,
    timeoutMs: 1_200,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.promptVisible, false);

  // 2026-09-15 晚：豆包的确认文案措辞会变（「收到，正在为您生成视频…大约需要 1-3 分钟」，
  // 用的是“您”），只认固定措辞会把正在生成的任务误判成失败。因此“提示词已经落在对话区”
  // （已排除输入框与侧栏标题回显）也作为有效信号。
  const echoed = await confirmSubmissionAccepted(script({ generating: false, promptVisible: true }), prompt, {
    wait: async () => undefined,
    timeoutMs: 1_200,
  });
  assert.equal(echoed.accepted, true);
  assert.equal(echoed.promptVisible, true);

  // 豆包明确给出“我将为你生成 / 预计等待”这类确认文案才算接受。
  const acknowledged = await confirmSubmissionAccepted(
    script({ generating: false, promptVisible: true, acknowledged: true }),
    prompt,
    { wait: async () => undefined, timeoutMs: 1_200 },
  );
  assert.equal(acknowledged.accepted, true);

  // 豆包反问视频参数（时长/比例）：必须立刻失败并带上独立错误码语义。
  const asked = await confirmSubmissionAccepted(
    script({ generating: false, promptVisible: true, asksParams: true }),
    prompt,
    { wait: async () => undefined, timeoutMs: 1_200 },
  );
  assert.equal(asked.accepted, false);
  assert.equal(asked.askedParams, true);

  // 带参考图被豆包放弃时的形态：会话短暂出现（能看到提示词）随即被重置为空对话。
  // 只凭一次采样不能算受理，否则会白等到 60 分钟超时。
  let polls = 0;
  const flicker = {
    executeJavaScript: async () => {
      polls += 1;
      return { generating: false, promptVisible: polls === 1, composerHoldsPrompt: false };
    },
  };
  const abandoned = await confirmSubmissionAccepted(flicker, prompt, {
    wait: async () => undefined,
    timeoutMs: 900,
  });
  assert.equal(abandoned.accepted, false);

  const generating = await confirmSubmissionAccepted(script({ generating: true, promptVisible: false }), prompt, {
    wait: async () => undefined,
    timeoutMs: 1_200,
  });
  assert.equal(generating.accepted, true);

  // 空提示词不能让“空字符串总是出现在正文里”变成误判为已接受。
  const emptyPrompt = await confirmSubmissionAccepted(script({ generating: false, promptVisible: false }), "", {
    wait: async () => undefined,
    timeoutMs: 1_200,
  });
  assert.equal(emptyPrompt.accepted, false);

  // 读取页面失败时不能当作成功。
  const unreadable = await confirmSubmissionAccepted(
    { executeJavaScript: async () => { throw new Error("page gone"); } },
    prompt,
    { wait: async () => undefined, timeoutMs: 800 },
  );
  assert.equal(unreadable.accepted, false);
});
