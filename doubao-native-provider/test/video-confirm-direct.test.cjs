/**
 * 「参数确认卡片回复走直连」的回归测试。
 *
 * 背景（2026-09-16 用户要求）：豆包受理视频请求后有时会回一张
 * 「视频生成参数确认」卡片（「确认后我再开始生成」）。历史上我们是在
 * 输入框打字「确认」再点发送——但那条路会被「安全确认」弹窗的遮罩
 * （`DIV.fixed`）盖住，`submitOnce` 抛 `SUBMISSION_UNCERTAIN`，连试 3 次
 * 后任务卡死等待，直到超时才报错（日志里 05:07 那单就是这么废的）。
 *
 * 现在回复动作整体改为直连（`replyDirectText`：页面内自建 `/chat/completion`），
 * UI 打字+点发送只保留为最后兜底。这里用假 webContents 锁住几条底线：
 *   1) 直连奏效时，**绝不能**再碰 UI（`debugger.sendCommand` 零调用）；
 *   2) 直连失败/缺 conversationId 时不要瞎发请求，要快速给出可诊断的原因；
 *   3) 两个变体的请求体形状正确（纯文本回复 vs 带 chat_ability 的视频参数回复）。
 *
 * 假 webContents 的判定方式：
 * - 脚本含 `/chat/completion` → 是 `replyDirectText`；
 * - 脚本含「确认后我再开始生成」 → 是 `readVideoCardState`；
 * - 其余（`injectPrompt` / `submitOnce` / `confirmMaterialSafetyDialog`）一律视为
 *   **UI 路径**：默认直接抛错，这样一旦代码退回 UI 就会立刻暴露，而不是让测试
 *   在真实的 40 秒观察窗里空转。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { confirmVideoParameterCard, replyDirectText } = require("../src/doubao-adapter.cjs");

const CARD_STATE = /确认后我再开始生成/;

function stateReader(states) {
  let index = 0;
  return () => {
    const state = Array.isArray(states) ? states[Math.min(index++, states.length - 1)] : states;
    return { cardVisible: false, generating: false, quotaExhausted: false, subscriptionRequired: false, ...state };
  };
}

function fakeWebContents({ states, replyFor, uiCommands = [], allowUi = false }) {
  const nextState = stateReader(states);
  return {
    uiCommands,
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: async (method, payload) => {
        uiCommands.push({ method, payload });
        if (!allowUi) throw new Error("UI path must not be used");
        return {};
      },
    },
    executeJavaScript: async (script) => {
      const source = String(script);
      if (source.includes("/chat/completion")) {
        return typeof replyFor === "function" ? replyFor(source) : replyFor;
      }
      if (CARD_STATE.test(source)) return nextState();
      if (!allowUi) throw new Error(`UI path is not expected here: ${source.slice(0, 60)}`);
      return nextState();
    },
  };
}

test("confirmation card is answered over the direct channel without touching the UI", async () => {
  const uiCommands = [];
  const webContents = fakeWebContents({
    uiCommands,
    // 读 1（阶段一探测）看到卡片；读 2（快照）卡片还在但未生成 → 该走直连；
    // 读 3（直连后的观察窗）看到已开始生成。
    states: [
      { cardVisible: true, cardParams: { model: "Seedance 2.0 Fast", duration: "15秒", aspectRatio: "16:9" } },
      { cardVisible: true },
      { cardVisible: false, generating: true },
    ],
    replyFor: { ok: true, status: 200, text: 'data: {"conversation_id":"38441775637783042"}', length: 48, includeAbility: false },
  });

  const outcome = await confirmVideoParameterCard(webContents, 30_000, () => undefined, {
    conversationId: "38441775637783042",
    model: "seedance_v2.0_fast",
    duration: 15,
    ratio: "16:9",
  });

  assert.equal(outcome.confirmed, true);
  // 关键回归点：通过直连确认，而不是 `reply-uncertain` + 三次 UI 重试。
  assert.equal(outcome.via, "direct-text");
  assert.equal(outcome.cardParams.model, "Seedance 2.0 Fast");
  // 直连奏效时一次 UI 动作都不该发生。
  assert.deepEqual(uiCommands, []);
});

test("the direct reply is preferred even when the safety dialog mask is present", async () => {
  // 历史故障现场：安全弹窗遮罩存在 → UI 发送必然 SUBMISSION_UNCERTAIN；
  // 直连不受弹窗影响，必须由它把这一单推进下去。
  const uiCommands = [];
  const webContents = fakeWebContents({
    uiCommands,
    states: [{ cardVisible: true }, { cardVisible: true }, { cardVisible: false, generating: true }],
    replyFor: { ok: true, status: 200, text: 'data: {"conversation_id":"c2"}', length: 32 },
  });

  const outcome = await confirmVideoParameterCard(webContents, 30_000, () => undefined, {
    conversationId: "c2",
    model: "seedance_v2.0_fast",
    duration: 15,
    ratio: "16:9",
  });

  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.via, "direct-text");
  assert.deepEqual(uiCommands, [], "遮罩存在时更不能退回 UI 路径");
});

test("a failing direct reply never claims success", async () => {
  const events = [];
  const webContents = fakeWebContents({
    states: { cardVisible: true },
    // 直连请求本身失败（协议不符 / 网络异常）——不能当成已确认。
    replyFor: { error: "Failed to fetch" },
  });

  const outcome = await confirmVideoParameterCard(
    webContents,
    8_000,
    (name, details) => events.push({ name, details }),
    { conversationId: "c1", model: "seedance_v2.0_fast", duration: 15, ratio: "16:9" },
  );

  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.reason, "reply-not-confirmed");
  // 两个直连变体都试过（A 纯文本、B 带 ability）。
  const directAttempts = events.filter((event) => event.name === "video_confirm_reply_direct" && event.details?.via?.startsWith("direct-"));
  assert.deepEqual(directAttempts.map((event) => event.details.via), ["direct-text", "direct-ability"]);
});

test("a card without a conversation id fails fast instead of replying blindly", async () => {
  let directCalls = 0;
  const webContents = fakeWebContents({
    states: { cardVisible: true },
    replyFor: () => {
      directCalls += 1;
      return { ok: true, status: 200, text: "" };
    },
  });
  const events = [];
  const outcome = await confirmVideoParameterCard(webContents, 15_000, (name, details) => events.push({ name, details }), {
    conversationId: "",
  });

  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.reason, "no-conversation-id");
  assert.equal(directCalls, 0, "没有会话 id 时不能乱发请求");
  assert.equal(events[0].name, "video_confirm_reply_direct");
  assert.equal(events[0].details.via, "skipped");
});

test("quota exhaustion is reported immediately, not retried", async () => {
  let directCalls = 0;
  const webContents = fakeWebContents({
    states: { quotaExhausted: true },
    replyFor: () => {
      directCalls += 1;
      return { ok: true, status: 200, text: "" };
    },
  });
  const outcome = await confirmVideoParameterCard(webContents, 15_000, () => undefined, { conversationId: "c1" });

  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.reason, "quota-exhausted");
  assert.equal(directCalls, 0, "额度已耗尽时不该再发确认请求");
});

test("no card at all means nothing to confirm", async () => {
  // 这个用例会跑满 15 秒：`confirmVideoParameterCard` 的第一阶段必须先给豆包
  // 一段「卡片可能出现」的等待窗（`waitCardMs` 下限就是 15 秒），确认卡不会在
  // 受理后立刻出现。这里看着慢是设计使然，不是死等。
  const webContents = fakeWebContents({
    states: { cardVisible: false, generating: false },
    replyFor: { ok: true, status: 200, text: "" },
  });
  const outcome = await confirmVideoParameterCard(webContents, 15_000, () => undefined, { conversationId: "c1" });

  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.reason, "card-not-found");
});

test("an already-generating conversation needs no reply at all", async () => {
  const uiCommands = [];
  const webContents = fakeWebContents({
    uiCommands,
    states: { cardVisible: false, generating: true },
    replyFor: { ok: true, status: 200, text: "" },
  });
  const outcome = await confirmVideoParameterCard(webContents, 15_000, () => undefined, { conversationId: "c1" });

  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.via, "auto-generating");
  assert.deepEqual(uiCommands, []);
});

test("direct reply variants send the shapes the Doubao protocol expects", async () => {
  // `replyDirectText` 的脚本是纯计算 + 一次 `fetch`（不碰 DOM），所以放进 vm 里
  // 真跑一遍、拦下 `fetch` 的请求体——这样验的是**真正发出去的内容**，
  // 而不是对源码做字符串断言。（请求体是 JS 源码字面量、键不带引号，
  // 直接 JSON.parse 会抛错，并被上层的 `.catch` 吞掉。）
  const requests = [];
  const webContents = {
    executeJavaScript: async (script) => {
      const sandbox = {
        crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
        fetch: async (url, init) => {
          requests.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, text: async () => "" };
        },
      };
      return vm.runInNewContext(String(script), sandbox);
    },
  };

  // 变体 A：纯文本回复（卡片本质是「是/否」问答）。
  const textOnly = await replyDirectText(webContents, { conversationId: "c1", text: "确认", includeAbility: false });
  // 变体 B：带 chat_ability 的视频参数回复（保持视频模式上下文）。
  const withAbility = await replyDirectText(webContents, {
    conversationId: "c1",
    text: "确认",
    includeAbility: true,
    model: "seedance_v2.0_fast",
    duration: 15,
    ratio: "16:9",
  });

  assert.equal(requests.length, 2, "两个变体都应真的发出请求");
  assert.equal(requests[0].url, "/chat/completion?aid=497858&device_platform=web&doubao_dev=1");
  assert.equal(requests[0].body.client_meta.conversation_id, "c1");
  assert.equal(requests[0].body.client_meta.bot_id, "7338286299411103781");
  assert.equal(requests[0].body.messages[0].content_block[0].content.text_block.text, "确认");
  // 变体 A 不能带 chat_ability，否则等于重开一次视频生成。
  assert.equal("chat_ability" in requests[0].body, false);
  assert.equal("chat_ability" in requests[1].body, true);
  // 回复必须落在同一个会话里，不能新建会话。
  assert.equal(requests[0].body.option.need_create_conversation, false);
  assert.equal(requests[1].body.option.need_create_conversation, false);

  const ability = JSON.parse(requests[1].body.chat_ability.ability_param);
  assert.equal(ability.model, "seedance_v2.0_fast");
  assert.equal(ability.duration, 15);
  assert.equal(ability.ratio, "16:9");
  assert.equal(ability.camera_movement, "fixed");
  assert.equal(ability.input_box_content.user_input_content, "确认");

  assert.equal(textOnly.status, 200);
  assert.equal(withAbility.status, 200);
  assert.equal(withAbility.includeAbility, true);
});
