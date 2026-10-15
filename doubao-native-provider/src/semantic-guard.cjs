/**
 * 2026-09-16 语义守卫（用户决策：豆包提交过程中不确定因素多，用工作台已配置的
 * GLM 大模型判定"什么时候可以继续点、什么时候要回退停止"，不再盲目空转或误点）。
 *
 * 2026-09-17 重构（用户要求「严格检查语义守卫与提示词撰写，完善规则」）。
 * 起因：23:23 的任务被 `downgrade-notice` 误判停机——卡片写着「Seedance 2.0 Mini」
 * 却同时写着「15 秒」（Mini 上限只有 10 秒，自相矛盾），而请求是 Fast 15 秒。
 * 复盘发现三个结构性问题：
 *  1. **证据链自相矛盾**：第二道守卫 verifyGenerationAnnouncement 已在 09-16 晚因 4 个
 *     样本实证（宣布 Mini 实际出 15.05 秒）降级为纯遥测，第一道却仍拿同一信号硬停；
 *  2. **型号不可信**：直连提交只改 chat_ability.ability_param，从不改创作页模型选择器，
 *     页面上的「模型 Seedance …」是选择器回显，与真正提交的档位无关；
 *  3. **判定顺序倒置**：参数确认卡片本来是确定性可识别的「已知好状态」，却交给 GLM 判，
 *     于是被型号回显带偏。
 *
 * 现在的三层结构（确定性优先，GLM 只兜底）：
 *  1. analyzeVideoCardText —— 页面解析单一事实来源（卡片范围内取参 + 记录页面型号提示）；
 *  2. assessDowngradeEvidence —— 降档按**自洽性**判定（Mini+10 秒 vs 请求 15 秒才算证据）；
 *  3. classifySubmissionState —— 额度/订阅/授权/参数卡片/降档全部确定性短路，只有
 *     「不属于任何已知状态」才交给 GLM；GLM 的 downgrade 结论一律降级为 proceed+告警，
 *     真正的硬闸门留给成片实测时长（media-provider ±20% 自动拒收）。
 *
 * GLM 配置复用工作台 .env.local（AI_API_KEY / AI_ENDPOINT / AI_MODEL，兼容 ZAI_*
 * 旧前缀），密钥不落 Provider 自己的配置。GLM 不可用时 fail-open（沿用原有确定性
 * 流程），绝不因为守卫本身故障把主链路卡死。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_MODEL = "glm-4.7-flash";

function parseAiEnvFile(contents, kind = "text") {
  const vision = kind === "vision";
  const pick = (names) => {
    for (const name of names) {
      const line = String(contents || "")
        .split(/\r?\n/u)
        .find((item) => item.trimStart().startsWith(`${name}=`));
      if (!line) continue;
      let value = line.slice(line.indexOf("=") + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
    return "";
  };
  return {
    apiKey: pick(vision ? ["VISION_AI_API_KEY", "AI_API_KEY", "ZAI_API_KEY"] : ["AI_API_KEY", "ZAI_API_KEY"]),
    endpoint: pick(vision ? ["VISION_AI_ENDPOINT", "AI_ENDPOINT"] : ["AI_ENDPOINT"]) || DEFAULT_ENDPOINT,
    model: pick(vision ? ["VISION_AI_MODEL"] : ["AI_MODEL", "ZAI_MODEL"]) || (vision ? "glm-4.6v-flash" : DEFAULT_MODEL),
  };
}

function loadAiConfig(env = process.env, ownerEmail = "", kind = "text") {
  const vision = kind === "vision";
  let fromEnv = {
    apiKey: vision ? (env.VISION_AI_API_KEY || env.AI_API_KEY || env.ZAI_API_KEY || "") : (env.AI_API_KEY || env.ZAI_API_KEY || ""),
    endpoint: vision ? (env.VISION_AI_ENDPOINT || env.AI_ENDPOINT || DEFAULT_ENDPOINT) : (env.AI_ENDPOINT || DEFAULT_ENDPOINT),
    model: vision ? (env.VISION_AI_MODEL || "glm-4.6v-flash") : (env.AI_MODEL || env.ZAI_MODEL || DEFAULT_MODEL),
  };
  const normalizedEmail = String(ownerEmail || "").trim().toLowerCase();
  if (normalizedEmail) {
    const ownerKey = crypto.createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 24);
    const fileName = `ai-config-${ownerKey}-${kind}.json`;
    const storedCandidates = [
      path.join(__dirname, "..", "..", "publicity-video-ai-workbench", "data", fileName),
      path.join(__dirname, "..", "data", fileName),
    ];
    for (const filePath of storedCandidates) {
      try {
        const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (stored && stored.apiKey) {
          return {
            apiKey: String(stored.apiKey),
            endpoint: String(stored.endpoint || DEFAULT_ENDPOINT),
            model: String(stored.model || DEFAULT_MODEL),
            source: "user-file",
          };
        }
      } catch {
        // 用户配置不存在或损坏时继续走环境变量兼容回退。
      }
    }
  }
  if (fromEnv.apiKey) return { ...fromEnv, source: "env" };
  // Provider 目录的上级就是工作台根目录（.env.local 在 publicity-video-ai-workbench/ 下）。
  const candidates = [
    path.join(__dirname, "..", "..", "publicity-video-ai-workbench", ".env.local"),
    path.join(__dirname, "..", ".env.local"),
  ];
  for (const filePath of candidates) {
    try {
      const parsed = parseAiEnvFile(fs.readFileSync(filePath, "utf8"), kind);
      if (parsed.apiKey) return { ...parsed, source: filePath };
    } catch {
      // 文件不存在就试下一个
    }
  }
  return null;
}

/** 从模型回复里抠出第一个 JSON 对象（容忍 ```json 围栏和前后废话）。 */
function extractJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const source = fenced ? fenced[1] : raw;
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function chatJson({ config, system, user, timeoutMs = 25_000, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!config || !config.apiKey || !doFetch) return null;
  const response = await doFetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return content ? extractJson(content) : null;
}

async function chatVisionJson({ config, system, user, imageDataUrl, timeoutMs = 25_000, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!config || !config.apiKey || !doFetch || !imageDataUrl) return null;
  const response = await doFetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return content ? extractJson(content) : null;
}

const UI_LOCATOR_SYSTEM_PROMPT = `你是网页自动化的候选目标判断器。只从给出的候选元素中选择一个，不得创造新的坐标、选择器或按钮。
任务是找出能完成指定动作的候选元素。只输出 JSON：{"candidateId":"候选 id","confidence":0到1,"reason":"不超过50字"}。
如果没有足够证据，candidateId 输出空字符串，confidence 输出 0。优先考虑真实 button、data-testid、按钮文字和所在工具栏上下文。`;

async function chooseUiTarget({ action, candidates, pageText, screenshotDataUrl, ownerEmail, textConfig, visionConfig, timeoutMs = 8_000, fetchImpl } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((item) => item && item.id) : [];
  if (!list.length) return null;
  const user = `目标动作：${String(action || "")}
候选元素：${JSON.stringify(list).slice(0, 12_000)}
页面文字摘要：${String(pageText || "").replace(/\s+/gu, " ").slice(-3_000)}`;
  const resolvedTextConfig = textConfig || loadAiConfig(process.env, ownerEmail, "text");
  let verdict = null;
  try {
    verdict = await chatJson({ config: resolvedTextConfig, system: UI_LOCATOR_SYSTEM_PROMPT, user, timeoutMs, fetchImpl });
  } catch {
    verdict = null;
  }
  const accept = (candidate, method) => {
    const found = list.find((item) => item.id === candidate?.candidateId);
    const confidence = Number(candidate?.confidence);
    if (!found || !Number.isFinite(confidence) || confidence < 0.65) return null;
    return { ...found, method, confidence, reason: String(candidate.reason || "").slice(0, 120) };
  };
  const textChoice = accept(verdict, "text-model");
  if (textChoice) return textChoice;
  if (!screenshotDataUrl) return null;
  const resolvedVisionConfig = visionConfig || loadAiConfig(process.env, ownerEmail, "vision");
  try {
    verdict = await chatVisionJson({ config: resolvedVisionConfig, system: UI_LOCATOR_SYSTEM_PROMPT, user, imageDataUrl: screenshotDataUrl, timeoutMs, fetchImpl });
  } catch {
    verdict = null;
  }
  return accept(verdict, "vision-model");
}

/** 各档位可用的最长时长（与 doubao-adapter.cjs 的 ABILITY_VIDEO_MODELS 保持一致）。 */
const TIER_MAX_DURATION = { mini: 10, fast: 15, standard: 5 };

/**
 * 会话页面文本 → 现场信号（**单一事实来源**）。
 *
 * 2026-09-17：本函数由 doubao-adapter 的 readVideoCardState 通过 `toString()` 注入渲染
 * 进程执行，所以**必须自包含**——不引用模块级常量、闭包变量或 require。正因如此，
 * 页面解析规则只有这一份，adapter 与单测不会各写一套 regex 而悄悄漂移。
 *
 * 关键改动：型号只在**卡片标题之后的窗口**里取。
 * 起因（2026-09-17 23:23 误判复盘）：卡片里写着「Seedance 2.0 Mini」却同时写着「15 秒」——
 * Mini 上限只有 10 秒，自相矛盾。原因是直连提交只改 chat_ability.ability_param，
 * **从不改创作页的模型选择器**，页面上的「模型 Seedance …」始终是选择器回显，
 * 与真正提交的档位无关。原来的全页首个匹配把它当成卡片参数读了出来。
 */
function analyzeVideoCardText(normalizedText) {
  var text = String(normalizedText || "").replace(/\s+/g, " ");
  var cardMarkers = ["视频生成参数确认", "确认后我再开始生成"];
  var cardIndex = -1;
  for (var i = 0; i < cardMarkers.length; i += 1) {
    var at = text.indexOf(cardMarkers[i]);
    if (at >= 0 && (cardIndex < 0 || at < cardIndex)) cardIndex = at;
  }
  var cardVisible = cardIndex >= 0;
  var modelRe = /Seedance\s*[0-9.]+(?:\s*(?:Fast|Mini))?/i;
  var pageModelHint = "";
  var pageModelMatch = text.match(modelRe);
  if (pageModelMatch) pageModelHint = pageModelMatch[0].replace(/\s+/g, " ").trim();
  var params = null;
  if (cardVisible) {
    var scope = text.slice(cardIndex, cardIndex + 800);
    var modelMatch = scope.match(modelRe);
    var durationMatch = scope.match(/(?:时长|视频时长)[:：]?\s*(\d{1,2}\s*(?:s|秒))/i);
    var ratioMatch = scope.match(/(?:比例|画面比例)[:：]?\s*(\d{1,2}:\d{1,2})/);
    var scoped = "card";
    if (!modelMatch && !durationMatch) {
      // 参数可能渲染在标题之前（布局不确定）：退化为全页读取并标记来源不精确。
      modelMatch = text.match(modelRe);
      durationMatch = text.match(/(?:时长|视频时长)[:：]?\s*(\d{1,2}\s*(?:s|秒))/i);
      ratioMatch = ratioMatch || text.match(/(?:比例|画面比例)[:：]?\s*(\d{1,2}:\d{1,2})/);
      scoped = "page";
    }
    params = {
      model: modelMatch ? modelMatch[0].replace(/\s+/g, " ").trim() : "",
      duration: durationMatch ? durationMatch[1].replace(/\s+/g, "") : "",
      aspectRatio: ratioMatch ? ratioMatch[1] : "",
      scope: scoped,
    };
  }
  return {
    cardVisible: cardVisible,
    cardParams: params,
    pageModelHint: pageModelHint,
    // 页面上的「本次使用 X 生成」宣布句（含时长）。与 parseAnnouncement 同口径，
    // 因为本函数要注入渲染进程、不能调用模块级函数，所以就地实现一份。
    pageAnnouncement: (function () {
      var match = text.match(/本次使用\s*([\s\S]{1,60}?)\s*生成/);
      if (!match) return null;
      var tail = text.slice(match.index, match.index + match[0].length + 120);
      var seconds = tail.match(/(\d{1,2})\s*秒/);
      return {
        modelText: match[1].replace(/\s+/g, " ").trim(),
        announcedDurationSeconds: seconds ? Number(seconds[1]) : 0,
      };
    })(),
    quotaExhausted: /免费次数用完|今日.{0,12}次数用完|今日.{0,12}额度|超出频率限制/.test(text),
    subscriptionRequired: /订阅标准套餐专属能力|开通标准套餐|订阅专属能力/.test(text),
    generating: /生成中|正在生成|排队中|预计等待|大约需要|收到，正在|本次使用\s*Seedance/.test(text),
    // 2026-09-25（P2 修复）：「已完成」也是正信号。实测（c6765c46 等三次）豆包用
    // Mini 快速生成时，约 1 分钟就「你的视频生成好了。」——观察窗若只认「生成中」，
    // 会先错过 generating、再错过完成态，把已成功的任务误报成
    // VIDEO_CONFIRM_NOT_TAKEN。completed 必须排在额度/生成判断**之前**使用
    // （adapter 侧），因为完成页可能同时含额度字样。
    completed: /视频生成好了/.test(text),
  };
}

/** "15秒" / "15s" → 15；取不到返回 0。 */
function parseDurationSeconds(value) {
  const match = String(value || "").match(/(\d{1,2})/u);
  return match ? Number(match[1]) : 0;
}

/**
 * 「静默降档」证据判定（确定性优先，不再交给 GLM 猜）。
 *
 * 实证链（2026-09-16 四样本 + 2026-09-17 复核）：
 *  - 宣布句「本次使用 Seedance 2.0 Mini 生成」常常只是创作页选择器回显——默认账号 2 例、
 *    账号 3 正常路径 1 例都宣布 Mini，实测却出 15.05 秒成片（ability_param 被尊重）；
 *  - 唯一真降档是账号 3 的授权确认分支：点「确认生成」后重新规划，宣布 Mini **且**只出 10.05 秒
 *    ——正好卡在 Mini 的 10 秒上限，自洽。
 *
 * 所以判定规则不是「型号不符即降档」，而是**自洽性**：
 *  - 宣布档位与请求一致 → 不降档；
 *  - 宣布档位低于请求，且宣布时长未超该档上限、且 < 请求时长 → 自洽的降档证据（真降档）；
 *  - 宣布 Mini 却给 15 秒（超过 Mini 上限 10 秒）→ 自相矛盾，型号只是选择器回显，不构成证据；
 *  - 只见型号不见时长 → 不足以判定。
 *
 * 真正的硬闸门仍在成片侧：media-provider 下载后实测 mp4 时长，偏差 > 20% 自动拒收。
 */
function assessDowngradeEvidence({
  announcedModel,
  announcedDurationSeconds,
  requestedModel,
  requestedDuration,
} = {}) {
  const announcedTier = modelTierOf(announcedModel);
  const requestedTier = modelTierOf(requestedModel);
  const announcedSeconds = Number(announcedDurationSeconds) || 0;
  const requestedSeconds = Number(requestedDuration) || 0;
  if (!announcedTier) {
    return {
      isDowngrade: false,
      checkable: false,
      reason: `页面型号「${announcedModel || "未出现"}」没有档位词（Mini/Fast），不构成降档证据`,
    };
  }
  if (announcedTier === requestedTier) {
    return {
      isDowngrade: false,
      checkable: true,
      reason: `页面档位与请求一致（${announcedModel}）`,
    };
  }
  const maxDuration = TIER_MAX_DURATION[announcedTier] || 0;
  if (announcedSeconds > 0 && maxDuration > 0 && announcedSeconds > maxDuration) {
    return {
      isDowngrade: false,
      checkable: true,
      reason: `页面写「${announcedModel}」却同时写 ${announcedSeconds} 秒，超过该档上限 ${maxDuration} 秒——型号是创作页选择器回显，不作为降档依据`,
    };
  }
  if (announcedSeconds > 0 && requestedSeconds > 0 && announcedSeconds < requestedSeconds) {
    return {
      isDowngrade: true,
      checkable: true,
      reason: `豆包宣布 ${announcedModel} ${announcedSeconds} 秒，低于请求的 ${requestedSeconds} 秒，且未超过该档上限 ${maxDuration} 秒——属自洽的降档证据`,
    };
  }
  if (announcedSeconds > 0) {
    return {
      isDowngrade: false,
      checkable: true,
      reason: `宣布时长 ${announcedSeconds} 秒不低于请求时长，不构成降档`,
    };
  }
  return {
    isDowngrade: false,
    checkable: false,
    reason: `只见型号「${announcedModel}」未见时长，不足以判定降档（型号常为选择器回显）`,
  };
}

const CLASSIFY_SYSTEM_PROMPT = `你是"AI 科普动画生产工作台"的豆包提交现场守卫。工作台刚向豆包提交了一个视频生成请求，但提交后的会话现场不是已知的正常状态，需要你判断现在是什么情况。

只输出一个 JSON 对象，格式：
{"action":"proceed|stop","label":"authorization-confirm|params-card|generating-ok|quota-limit|subscription-required|violation-risk|downgrade-notice|unclear","reason":"不超过 60 字的中文依据"}

先记住三条事实，避免误判：
1. 系统**已经用确定性规则**判定过额度、订阅、素材授权确认、参数确认卡片、降档自洽性。走到你这里说明现场不属于以上任何一种已知状态。
2. 页面上出现的「模型 Seedance …」是**创作页模型选择器的回显**，与实际提交的能力参数无关（提交走接口，不改选择器）。**不得**因为页面写着 Mini 而请求写着 Fast 就判降档。
3. 页面文本可能包含**历史消息**，不一定是本次提交的现场结果。

判定规则：
- authorization-confirm：豆包要求确认"素材均已获充分授权"之类承诺并出现「确认生成」按钮 → proceed（系统会去点它）。
- params-card：豆包回"视频生成参数确认"卡片（出现「确认后我再开始生成」），等待回复参数 → proceed。
- generating-ok：已在生成，或已明确开始排队 → proceed。
- quota-limit：免费次数/今日额度用完、频率限制 → stop。
- subscription-required：提示该组合属于订阅套餐专属 → stop。
- violation-risk：内容违规、审核拒绝、要求修改内容 → stop。
- downgrade-notice：**只有当页面出现明确的"替换/改用"动作措辞**（如「已为你改用」「替换为」「改为使用 …生成」）且该档位低于请求档位时才判。仅出现型号名称不算，一律不判。
- unclear：页面文本看不出以上任何一种 → stop。
互斥时优先级：violation-risk > quota-limit / subscription-required > params-card / authorization-confirm > 其他。即：只要现场像"等待确认的参数卡片"，就判 params-card，不要因为型号名称判 downgrade-notice。`;

const RECOVERY_SYSTEM_PROMPT = `你是“AI 科普动画生产工作台”的提交故障分流器。你只能从给定证据中选择下一步动作，不能发明页面按钮、坐标或接口。

只输出 JSON：
{"action":"recover-confirm|check-history|retry-safe|stop","confidence":0到1,"reason":"不超过80字的中文依据"}

动作含义：
- recover-confirm：页面明确还停在确认卡片，且没有证据表明确认消息已经被豆包受理；可以再做一次确认恢复。
- check-history：请求或确认消息已经被豆包受理，但当前页面没有生成信号；先查会话和作品库，禁止盲目重提交。
- retry-safe：没有提交受理、没有确认受理、没有额度/订阅/违规阻断证据，允许重新提交。
- stop：额度、订阅、违规或明确拒绝，停止并交给用户处理。

注意：HTTP 200、SSE_ACK、消息出现在会话里，都只代表“消息被接收”，不代表视频已经开始生成。`;

const RECOVERY_ACTIONS = new Set(["recover-confirm", "check-history", "retry-safe", "stop"]);

function normalizeRecoveryAction(value) {
  const action = String(value || "").trim();
  return RECOVERY_ACTIONS.has(action) ? action : "";
}

/**
 * 规则审核模型建议。模型只能提供建议，不能绕过额度、订阅或“已提交但状态不明”的保护。
 */
function auditRecoveryAction({ modelAction, evidence = {} } = {}) {
  const suggested = normalizeRecoveryAction(modelAction) || "check-history";
  const hardStop = Boolean(
    evidence.quotaExhausted || evidence.subscriptionRequired || evidence.violationRisk,
  );
  const accepted = Boolean(
    evidence.submitAccepted || evidence.replyAcked || evidence.conversationId,
  );
  const confirmationAlreadyTried = Number(evidence.confirmationAttempts || 0) > 0;
  let action = suggested;
  let reason = "沿用模型建议";

  if (hardStop) {
    action = "stop";
    reason = "确定性规则发现额度、订阅或违规阻断，不允许继续提交";
  } else if (accepted) {
    action = "check-history";
    reason = "豆包已受理提交或确认，但当前没有生成信号，必须先核对会话与作品库";
  } else if (evidence.cardVisible && !confirmationAlreadyTried) {
    action = "recover-confirm";
    reason = "仍有确认卡片且尚未尝试确认，可执行一次恢复确认";
  } else if (suggested === "recover-confirm" && confirmationAlreadyTried) {
    action = "check-history";
    reason = "确认动作已经尝试过，禁止重复点击导致重复提交";
  } else if (suggested === "retry-safe" && (evidence.cardVisible || evidence.pageHasGenerationText)) {
    action = "check-history";
    reason = "页面仍有生成现场证据，不能直接重提交";
  }

  return {
    action,
    modelAction: suggested,
    overridden: action !== suggested,
    reason,
  };
}

async function judgeRecoveryAction({ evidence = {}, ownerEmail = "", config, fetchImpl } = {}) {
  const resolvedConfig = config || loadAiConfig(process.env, ownerEmail, "text");
  const user = `故障证据：${JSON.stringify({
    conversationId: String(evidence.conversationId || "").slice(0, 80),
    cardVisible: Boolean(evidence.cardVisible),
    cardParams: evidence.cardParams || null,
    submitAccepted: Boolean(evidence.submitAccepted),
    replyAcked: Boolean(evidence.replyAcked),
    confirmationAttempts: Number(evidence.confirmationAttempts || 0),
    generating: Boolean(evidence.generating),
    completed: Boolean(evidence.completed),
    quotaExhausted: Boolean(evidence.quotaExhausted),
    subscriptionRequired: Boolean(evidence.subscriptionRequired),
    violationRisk: Boolean(evidence.violationRisk),
    pageText: String(evidence.pageText || "").replace(/\s+/gu, " ").slice(-2400),
  })}`;
  let verdict = null;
  try {
    verdict = await chatJson({
      config: resolvedConfig,
      system: RECOVERY_SYSTEM_PROMPT,
      user,
      timeoutMs: 12_000,
      fetchImpl,
    });
  } catch {
    verdict = null;
  }
  const modelAction = normalizeRecoveryAction(verdict?.action);
  return {
    modelAction: modelAction || "unavailable",
    confidence: Number.isFinite(Number(verdict?.confidence)) ? Number(verdict.confidence) : 0,
    reason: String(verdict?.reason || "模型未返回可用建议").slice(0, 160),
    checked: modelAction ? "glm" : "unavailable",
  };
}

async function classifySubmissionState({
  pageText,
  requestedModel,
  requestedDuration,
  cardSignal,
  conversationId,
  ownerEmail,
  config,
  fetchImpl,
} = {}) {
  const text = String(pageText || "").slice(-3500);
  const signal =
    cardSignal && typeof cardSignal === "object"
      ? cardSignal
      : analyzeVideoCardText(text);
  const base = {
    textSample: text.replace(/\s+/gu, " ").trim().slice(-300),
    cardVisible: Boolean(signal.cardVisible),
    cardParams: signal.cardParams || null,
    pageModelHint: signal.pageModelHint || "",
    conversationId: conversationId || "",
  };

  // ---- 确定性层（不调 GLM）：这些都是可判定的现场事实，不该交给模型猜 ----
  if (signal.quotaExhausted) {
    return {
      ...base,
      action: "stop",
      label: "quota-limit",
      reason: "页面出现「免费次数用完 / 今日额度受限 / 超出频率限制」文案",
      checked: "deterministic",
    };
  }
  if (signal.subscriptionRequired) {
    return {
      ...base,
      action: "stop",
      label: "subscription-required",
      reason: "页面提示该生成组合属于订阅套餐专属能力",
      checked: "deterministic",
    };
  }
  // 已知文案快路径：素材授权确认是固定话术，不必等 GLM。
  if (/均已获充分授权/u.test(text)) {
    return {
      ...base,
      action: "proceed",
      label: "authorization-confirm",
      reason: "命中已知素材授权确认文案",
      checked: "deterministic",
    };
  }
  // 降档改用「自洽性」判定，取代原来的「型号不符即停机」——详见 assessDowngradeEvidence。
  // 型号/时长优先取卡片范围，其次取页面宣布句，最后退回页面型号提示。
  const announced = signal.cardParams || {};
  const pageAnnouncement = signal.pageAnnouncement || {};
  const downgrade = assessDowngradeEvidence({
    announcedModel: announced.model || pageAnnouncement.modelText || signal.pageModelHint || "",
    announcedDurationSeconds:
      parseDurationSeconds(announced.duration) ||
      Number(pageAnnouncement.announcedDurationSeconds) ||
      0,
    requestedModel,
    requestedDuration,
  });
  if (downgrade.isDowngrade) {
    return {
      ...base,
      action: "stop",
      label: "downgrade-notice",
      reason: downgrade.reason,
      checked: "deterministic",
      downgradeEvidence: true,
    };
  }
  // 参数确认卡片是**已知好状态**：豆包在等回复「确认」，不是异常。
  if (signal.cardVisible) {
    return {
      ...base,
      action: "proceed",
      label: "params-card",
      reason: `现场是「视频生成参数确认」卡片，等待回复确认（${downgrade.reason}）`,
      checked: "deterministic",
      // 型号核对不可信时留个告警标记，供遥测区分「已核对通过」与「无法核对」。
      warning: !downgrade.checkable,
    };
  }

  // ---- 兜底层：只有现场不属于上面任何一种已知状态，才交给 GLM ----
  if (!config) config = loadAiConfig(process.env, ownerEmail, "text");
  let verdict = null;
  try {
    verdict = await chatJson({
      config,
      fetchImpl,
      system: CLASSIFY_SYSTEM_PROMPT,
      user: `请求参数：模型 ${requestedModel || "未指定"}，时长 ${requestedDuration || "?"} 秒。\n\n会话页面文本（截取尾部）：\n${text}`,
    });
  } catch {
    verdict = null;
  }
  if (
    verdict &&
    (verdict.action === "proceed" || verdict.action === "stop") &&
    typeof verdict.label === "string" &&
    verdict.label
  ) {
    // GLM 判出的 downgrade-notice 一律降级为 proceed + 告警：
    // 它没有时长自洽性依据，而型号常是选择器回显；真正的降档由成片实测时长兜底拒收。
    if (verdict.action === "stop" && verdict.label === "downgrade-notice") {
      return {
        ...base,
        action: "proceed",
        label: "downgrade-notice",
        reason: `GLM 报告型号/时长可能不符，但页面型号常为选择器回显、且成片时长会实测校验，故不阻断；理由：${verdict.reason || "未给出依据"}`,
        checked: "glm",
        warning: true,
      };
    }
    return { ...base, ...verdict, checked: "glm" };
  }
  // GLM 不可用/输出不合规：fail-open，沿用原有确定性流程，不卡死主链路。
  return {
    ...base,
    action: "proceed",
    label: "guard-unavailable",
    reason: "GLM 判定不可用，沿用原有确定性流程",
    checked: "unavailable",
  };
}

/** 从宣布句里提取模型名与时长，例如“本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟。” */
function parseAnnouncement(text) {
  const raw = String(text || "");
  const match = raw.match(/本次使用\s*([\s\S]{1,60}?)生成/u);
  if (!match) return null;
  const modelText = match[1].replace(/\s+/gu, " ").trim();
  // 时长在宣布句起点后的一个小窗口里找（“时长 10 秒”）；“预计等待 5 分钟”里的
  // 分钟是等待时长、单位不带“秒”，天然不会误配。
  const window = raw.slice(match.index, match.index + match[0].length + 120);
  const duration = (window.match(/(\d{1,2})\s*秒/u) || [])[1];
  return {
    sentence: match[0].replace(/\s+/gu, " ").trim(),
    modelText,
    announcedDurationSeconds: duration ? Number(duration) : null,
  };
}

function modelTierOf(label) {
  const value = String(label || "").toLowerCase();
  // 只认显式档位词：Mini / Fast。不带档位词（如“Seedance 2.0”）视为含糊，
  // 交给 GLM 复核——豆包有时用家族名泛指，直接判降档会误杀。
  if (/mini/u.test(value)) return "mini";
  if (/fast/u.test(value)) return "fast";
  return "";
}

/**
 * 核对宣布句（**纯确定性**，不调 GLM）。返回 { ok, checked, reason?, announcement? }：
 * checked=false 表示页面里根本没有宣布句。
 *
 * 2026-09-17：去掉了这里的 GLM 复核。
 * 理由：宣布句核对本身已降级为纯遥测（见 doubao-adapter 的调用点注释），而 GLM 能看到的
 * 证据与确定性判定完全相同——只有型号名称、没有时长自洽性时，问它也只是换一个没有依据
 * 的猜测，还要多花一次调用与一次超时窗口。现在「型号名称单独出现」一律判为非证据，
 * 结论稳定可复现，日志也不会再随 GLM 的措辞漂移。
 */
async function verifyGenerationAnnouncement({ text, requestedModel, requestedDuration } = {}) {
  const announcement = parseAnnouncement(text);
  if (!announcement) return { ok: true, checked: false };
  // 时长是独立轴：无论档位是否一致，宣布时长明显低于请求都是硬事实。
  if (
    announcement.announcedDurationSeconds != null &&
    Number(requestedDuration) > 0 &&
    announcement.announcedDurationSeconds < Number(requestedDuration) - 1
  ) {
    return {
      ok: false,
      checked: true,
      announcement: announcement.sentence,
      reason: `豆包宣布时长 ${announcement.announcedDurationSeconds} 秒，低于请求的 ${requestedDuration} 秒`,
    };
  }
  // 档位轴交给 assessDowngradeEvidence：只有「自洽」才算降档证据（2026-09-17 统一口径）。
  const evidence = assessDowngradeEvidence({
    announcedModel: announcement.modelText,
    announcedDurationSeconds: announcement.announcedDurationSeconds,
    requestedModel,
    requestedDuration,
  });
  return {
    ok: !evidence.isDowngrade,
    checked: true,
    announcement: announcement.sentence,
    reason: evidence.reason,
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  TIER_MAX_DURATION,
  parseAiEnvFile,
  loadAiConfig,
  extractJson,
  chatJson,
  chatVisionJson,
  chooseUiTarget,
  analyzeVideoCardText,
  parseDurationSeconds,
  assessDowngradeEvidence,
  classifySubmissionState,
  normalizeRecoveryAction,
  auditRecoveryAction,
  judgeRecoveryAction,
  verifyGenerationAnnouncement,
  parseAnnouncement,
  modelTierOf,
};
