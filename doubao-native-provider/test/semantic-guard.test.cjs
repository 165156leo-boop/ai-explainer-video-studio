"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseAiEnvFile,
  chatVisionJson,
  chooseUiTarget,
  extractJson,
  analyzeVideoCardText,
  assessDowngradeEvidence,
  auditRecoveryAction,
  classifySubmissionState,
  judgeRecoveryAction,
  verifyGenerationAnnouncement,
  parseAnnouncement,
  modelTierOf,
} = require("../src/semantic-guard.cjs");

const CONFIG = { apiKey: "test-key", endpoint: "https://example.test/v4/chat/completions", model: "glm-test" };

function glmResponder(payload) {
  const body = JSON.stringify({
    choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }],
  });
  return async () => ({ ok: true, status: 200, json: async () => JSON.parse(body) });
}

test("parseAiEnvFile 支持引号包裹、ZAI 旧前缀回退与默认值", () => {
  const parsed = parseAiEnvFile([
    "# comment",
    "ZAI_API_KEY=legacy-key",
    'AI_ENDPOINT="https://api.example.cn/v4/chat/completions"',
    "AI_MODEL=glm-x",
  ].join("\n"));
  assert.equal(parsed.apiKey, "legacy-key");
  assert.equal(parsed.endpoint, "https://api.example.cn/v4/chat/completions");
  assert.equal(parsed.model, "glm-x");

  const fallback = parseAiEnvFile("");
  assert.equal(fallback.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(fallback.model, "glm-4.7-flash");
  assert.equal(fallback.apiKey, "");
});

test("classifySubmissionState 的兜底读取当前用户的文本配置", async () => {
  const ownerEmail = `semantic-guard-${process.pid}@example.test`;
  const ownerKey = crypto.createHash("sha256").update(ownerEmail).digest("hex").slice(0, 24);
  const configPath = path.join(
    __dirname,
    "..",
    "..",
    "publicity-video-ai-workbench",
    "data",
    `ai-config-${ownerKey}-text.json`,
  );
  fs.writeFileSync(configPath, JSON.stringify({
    apiKey: "isolated-test-key",
    endpoint: "https://user-config.example.test/v4/chat/completions",
    model: "user-config-model",
  }));
  try {
    let request;
    const verdict = await classifySubmissionState({
      ownerEmail,
      pageText: "一段需要进入 GLM 兜底的未知文本",
      requestedModel: "Seedance 2.0 Fast",
      requestedDuration: 15,
      fetchImpl: async (_url, init) => {
        request = { url: _url, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({
          choices: [{ message: { content: '{"action":"proceed","label":"unknown","reason":"test"}' } }],
        }) };
      },
    });
    assert.equal(request.url, "https://user-config.example.test/v4/chat/completions");
    assert.match(request.body.model, /user-config-model/u);
    assert.equal(verdict.checked, "glm");
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

test("extractJson 容忍围栏、前后废话与字符串里的花括号", () => {
  assert.deepEqual(extractJson('```json\n{"action":"stop"}\n```'), { action: "stop" });
  assert.deepEqual(extractJson('结论如下：{"a":{"b":"含}花括号"},"c":1} 完毕'), { a: { b: "含}花括号" }, c: 1 });
  assert.equal(extractJson("没有任何 JSON"), null);
});

test("视觉模型请求使用截图，但只能返回候选元素", async () => {
  let payload;
  const result = await chatVisionJson({
    config: CONFIG,
    system: "只输出 JSON",
    user: "选择视频生成按钮",
    imageDataUrl: "data:image/png;base64,AA==",
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"candidateId":"video-entry-0","confidence":0.9}' } }] }) };
    },
  });
  assert.equal(result.candidateId, "video-entry-0");
  assert.equal(payload.messages[1].content[1].type, "image_url");
  assert.equal(payload.messages[1].content[1].image_url.url, "data:image/png;base64,AA==");
});

test("UI 定位优先用文本模型，且拒绝不在候选集里的坐标", async () => {
  let calls = 0;
  const result = await chooseUiTarget({
    action: "点击视频生成",
    pageText: "首页工具栏 视频生成",
    candidates: [
      { id: "video-entry-0", tag: "BUTTON", text: "视频生成", x: 10, y: 20 },
      { id: "video-entry-1", tag: "DIV", text: "视频生成", x: 30, y: 40 },
    ],
    textConfig: CONFIG,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"candidateId":"video-entry-0","confidence":0.92,"reason":"真实按钮"}' } }] }) };
    },
  });
  assert.equal(result.id, "video-entry-0");
  assert.equal(result.method, "text-model");
  assert.equal(calls, 1);
});

test("classifySubmissionState 命中已知授权文案时走确定性快路径，不调 GLM", async () => {
  let called = 0;
  const verdict = await classifySubmissionState({
    pageText: "你在本功能中上传、使用的素材，均已获充分授权，无侵权违法风险。确认生成",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { called += 1; throw new Error("should not call"); },
  });
  assert.equal(called, 0);
  assert.equal(verdict.action, "proceed");
  assert.equal(verdict.label, "authorization-confirm");
  assert.equal(verdict.checked, "deterministic");
});

test("classifySubmissionState GLM 判定违规内容时返回 stop", async () => {
  const verdict = await classifySubmissionState({
    pageText: "你的请求包含不符合规范的内容，无法生成。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: glmResponder({ action: "stop", label: "violation-risk", reason: "页面提示内容违规" }),
  });
  assert.equal(verdict.action, "stop");
  assert.equal(verdict.label, "violation-risk");
  assert.equal(verdict.checked, "glm");
});

test("classifySubmissionState GLM 不可用时 fail-open 放行", async () => {
  const verdict = await classifySubmissionState({
    pageText: "一段完全看不懂的文本",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(verdict.action, "proceed");
  assert.equal(verdict.label, "guard-unavailable");
});

test("verifyGenerationAnnouncement 只宣布 Mini 没有时长 → 不拦（型号常是选择器回显）", async () => {
  const verdict = await verifyGenerationAnnouncement({
    text: "本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟。视频生成好后，我会主动发送给你。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, true);
  assert.match(verdict.reason, /不足以判定降档|选择器回显/);
});

test("verifyGenerationAnnouncement 宣布 Mini 10 秒 vs 请求 Fast 15 秒 → 拦下（自洽的降档证据）", async () => {
  const verdict = await verifyGenerationAnnouncement({
    text: "本次使用 Seedance 2.0 Mini 生成，时长 10 秒。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /低于请求|自洽的降档证据/);
});

test("verifyGenerationAnnouncement 宣布时长低于请求 → 拦下", async () => {
  const verdict = await verifyGenerationAnnouncement({
    text: "本次使用 Seedance 2.0 Fast 生成，时长 10 秒。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /10 秒/);
});

test("verifyGenerationAnnouncement 宣布与请求一致 → 放行", async () => {
  const verdict = await verifyGenerationAnnouncement({
    text: "本次使用 Seedance 2.0 Fast 生成，预计等待 3 分钟。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, true);
});

test("verifyGenerationAnnouncement 没有宣布句 → 不拦截", async () => {
  const verdict = await verifyGenerationAnnouncement({
    text: "随便一段没有宣布参数的文本",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checked, false);
});

test("verifyGenerationAnnouncement 档位含糊且没给时长 → 不拦、不调 GLM（型号单独不成证据）", async () => {
  let called = 0;
  const verdict = await verifyGenerationAnnouncement({
    text: "本次使用 Seedance 2.0 生成，预计等待 5 分钟。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { called += 1; throw new Error("should not call"); },
  });
  assert.equal(called, 0);
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /不构成降档证据|没有档位词/);
});

test("parseAnnouncement 提取模型文本与宣布时长", () => {
  const withDuration = parseAnnouncement("前文。本次使用 Seedance 2.0 Fast 生成，时长 10 秒。后文。");
  assert.match(withDuration.modelText, /Fast/u);
  assert.equal(withDuration.announcedDurationSeconds, 10);
  // “预计等待 5 分钟”是等待时长不是成片时长，不应被当成秒数
  const minutesOnly = parseAnnouncement("本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟。");
  assert.match(minutesOnly.modelText, /Mini/u);
  assert.equal(minutesOnly.announcedDurationSeconds, null);
  assert.equal(parseAnnouncement("没有宣布句"), null);
});

test("modelTierOf 识别 Mini/Fast，无档位词视为含糊", () => {
  assert.equal(modelTierOf("Seedance 2.0 Mini"), "mini");
  assert.equal(modelTierOf("seedance 2.0 fast"), "fast");
  assert.equal(modelTierOf("Seedance 2.0"), "");
  assert.equal(modelTierOf("看不懂的模型名"), "");
});

// ---------- 2026-09-17：23:23 误判复盘后的新增覆盖 ----------

/** 复刻 23:23 那次的真实页面文本：输入框芯片写 Mini（选择器回显），卡片写 15 秒。 */
const PAGE_WITH_CARD_AND_CHIP =
  "视频生成 模型 Seedance 2.0 Mini 升级 视频生成参数确认 模型：Seedance 2.0 Mini " +
  "时长：15秒 画面比例：16:9 确认后我再开始生成视频";

test("analyzeVideoCardText 型号只在卡片标题之后取，输入框芯片另记为 pageModelHint", () => {
  const signal = analyzeVideoCardText(PAGE_WITH_CARD_AND_CHIP);
  assert.equal(signal.cardVisible, true);
  assert.equal(signal.cardParams.duration, "15秒");
  assert.equal(signal.cardParams.aspectRatio, "16:9");
  assert.equal(signal.cardParams.scope, "card");
  // 芯片文案「模型 Seedance 2.0 Mini」在卡片标题之前，只能出现在 pageModelHint 里。
  assert.match(signal.pageModelHint, /Seedance 2\.0 Mini/u);
  assert.equal(signal.generating, false);
});

test("analyzeVideoCardText 卡片上的参数渲染在标题之前时退化为全页读取并标记来源", () => {
  const signal = analyzeVideoCardText("时长：10秒 画面比例：16:9 视频生成参数确认");
  assert.equal(signal.cardVisible, true);
  assert.equal(signal.cardParams.scope, "page");
  assert.equal(signal.cardParams.duration, "10秒");
});

test("analyzeVideoCardText 识别额度、订阅与生成中信号", () => {
  assert.equal(analyzeVideoCardText("今日免费次数用完了").quotaExhausted, true);
  assert.equal(analyzeVideoCardText("该能力为订阅标准套餐专属能力").subscriptionRequired, true);
  assert.equal(analyzeVideoCardText("正在生成，预计等待 3 分钟").generating, true);
});

test("analyzeVideoCardText 识别「已完成」（你的视频生成好了）为正信号", () => {
  // 2026-09-25 P2 修复：Mini 快速生成会在观察窗内直接做完，只认「生成中」
  // 会把成功任务误报成 VIDEO_CONFIRM_NOT_TAKEN（c6765c46 等三次实证）。
  const done = analyzeVideoCardText("今天 03:11 你的视频生成好了。");
  assert.equal(done.completed, true);
  // 完成页可能同时带额度字样，completed 语义不受污染。
  const doneWithQuota = analyzeVideoCardText("你的视频生成好了。本次生成将消耗每日免费额度。");
  assert.equal(doneWithQuota.completed, true);
  assert.equal(analyzeVideoCardText("已开始生成 15 秒视频").completed, false);
});

test("analyzeVideoCardText 可被注入渲染进程执行（toString 注入无二次转义问题）", () => {
  // Provider 的 readVideoCardState 就是这样注入的：源码拼接 + 在渲染进程里 eval。
  const script =
    "(() => { var analyze = " +
    analyzeVideoCardText.toString() +
    "; var raw = document.body ? (document.body.innerText || '') : '';" +
    " return analyze(raw); })()";
  const run = new Function("document", `return ${script};`);
  const result = run({ body: { innerText: PAGE_WITH_CARD_AND_CHIP } });
  assert.equal(result.cardVisible, true);
  assert.equal(result.cardParams.duration, "15秒");
  assert.match(result.pageModelHint, /Seedance/u);
});

test("assessDowngradeEvidence：页面写 Mini 却给 15 秒（超上限）→ 型号不可信，不判降档", () => {
  const verdict = assessDowngradeEvidence({
    announcedModel: "Seedance 2.0 Mini",
    announcedDurationSeconds: 15,
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
  });
  assert.equal(verdict.isDowngrade, false);
  assert.equal(verdict.checkable, true);
  assert.match(verdict.reason, /超过该档上限/u);
});

test("assessDowngradeEvidence：Mini + 10 秒 vs 请求 Fast 15 秒 → 自洽，判降档", () => {
  const verdict = assessDowngradeEvidence({
    announcedModel: "Seedance 2.0 Mini",
    announcedDurationSeconds: 10,
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
  });
  assert.equal(verdict.isDowngrade, true);
  assert.match(verdict.reason, /自洽的降档证据/u);
});

test("assessDowngradeEvidence：档位一致 / 缺时长 → 不判降档", () => {
  assert.equal(
    assessDowngradeEvidence({
      announcedModel: "Seedance 2.0 Fast",
      announcedDurationSeconds: 15,
      requestedModel: "Seedance 2.0 Fast",
      requestedDuration: 15,
    }).isDowngrade,
    false,
  );
  const noDuration = assessDowngradeEvidence({
    announcedModel: "Seedance 2.0 Mini",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
  });
  assert.equal(noDuration.isDowngrade, false);
  assert.equal(noDuration.checkable, false);
});

test("classifySubmissionState 参数确认卡片 + 型号回显 → 确定性 proceed，不调 GLM", async () => {
  let called = 0;
  const verdict = await classifySubmissionState({
    pageText: PAGE_WITH_CARD_AND_CHIP,
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    conversationId: "38442080807012610",
    config: CONFIG,
    fetchImpl: () => { called += 1; throw new Error("should not call"); },
  });
  assert.equal(called, 0);
  assert.equal(verdict.action, "proceed");
  assert.equal(verdict.label, "params-card");
  assert.equal(verdict.checked, "deterministic");
  assert.equal(verdict.cardParams.duration, "15秒");
  assert.equal(verdict.conversationId, "38442080807012610");
  assert.ok(verdict.textSample.length > 0, "应把被判定的文本样本带进遥测");
});

test("classifySubmissionState 额度与订阅文案走确定性 stop，不调 GLM", async () => {
  let called = 0;
  const noCall = () => { called += 1; throw new Error("should not call"); };
  const quota = await classifySubmissionState({
    pageText: "今日视频生成免费次数用完了，明天再来吧",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: noCall,
  });
  assert.equal(quota.action, "stop");
  assert.equal(quota.label, "quota-limit");
  const subscription = await classifySubmissionState({
    pageText: "该生成组合属于订阅标准套餐专属能力",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: noCall,
  });
  assert.equal(subscription.action, "stop");
  assert.equal(subscription.label, "subscription-required");
  assert.equal(called, 0);
});

test("classifySubmissionState 真降档证据 → 确定性 stop", async () => {
  const verdict = await classifySubmissionState({
    pageText: "本次使用 Seedance 2.0 Mini 生成，时长 10 秒。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: () => { throw new Error("should not call"); },
  });
  assert.equal(verdict.action, "stop");
  assert.equal(verdict.label, "downgrade-notice");
  assert.equal(verdict.downgradeEvidence, true);
});

test("classifySubmissionState GLM 判 downgrade → 降级为 proceed + warning，不阻断", async () => {
  const verdict = await classifySubmissionState({
    pageText: "已为你改用 Seedance 2.0 Mini 生成",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: glmResponder({ action: "stop", label: "downgrade-notice", reason: "型号不一致" }),
  });
  assert.equal(verdict.action, "proceed");
  assert.equal(verdict.label, "downgrade-notice");
  assert.equal(verdict.warning, true);
  assert.equal(verdict.checked, "glm");
});

test("classifySubmissionState GLM 判违规仍然 stop", async () => {
  const verdict = await classifySubmissionState({
    pageText: "你的请求包含不符合规范的内容，无法生成。",
    requestedModel: "Seedance 2.0 Fast",
    requestedDuration: 15,
    config: CONFIG,
    fetchImpl: glmResponder({ action: "stop", label: "violation-risk", reason: "内容违规" }),
  });
  assert.equal(verdict.action, "stop");
  assert.equal(verdict.label, "violation-risk");
});

test("恢复动作：已受理但没有生成信号时，规则覆盖模型的 retry-safe 建议", () => {
  const verdict = auditRecoveryAction({
    modelAction: "retry-safe",
    evidence: {
      conversationId: "38444205499326210",
      submitAccepted: true,
      replyAcked: true,
      cardVisible: true,
      confirmationAttempts: 5,
    },
  });
  assert.equal(verdict.action, "check-history");
  assert.equal(verdict.modelAction, "retry-safe");
  assert.equal(verdict.overridden, true);
  assert.match(verdict.reason, /先核对会话与作品库/u);
});

test("恢复动作：未提交且仍有确认卡片时允许一次 recover-confirm", () => {
  const verdict = auditRecoveryAction({
    modelAction: "check-history",
    evidence: { cardVisible: true, confirmationAttempts: 0 },
  });
  assert.equal(verdict.action, "recover-confirm");
  assert.equal(verdict.overridden, true);
});

test("恢复动作：模型判断不能绕过额度硬阻断", () => {
  const verdict = auditRecoveryAction({
    modelAction: "retry-safe",
    evidence: { quotaExhausted: true },
  });
  assert.equal(verdict.action, "stop");
  assert.equal(verdict.overridden, true);
});

test("恢复动作模型只接受白名单动作，异常输出回退到规则安全动作", async () => {
  const verdict = await judgeRecoveryAction({
    config: CONFIG,
    evidence: { pageText: "视频生成参数确认", cardVisible: true },
    fetchImpl: glmResponder({ action: "click-random-coordinate", reason: "不可信" }),
  });
  assert.equal(verdict.modelAction, "unavailable");
  assert.equal(verdict.checked, "unavailable");
});
