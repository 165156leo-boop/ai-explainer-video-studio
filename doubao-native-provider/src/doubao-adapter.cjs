const { mkdir, open, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  buildUnwatermarkedVideoApi,
  decodeVideoMainUrl,
  extractArtifactUrls,
  extractPreferredArtifacts,
  isReadyArtifactCandidate,
  selectBestVideoArtifact,
} = require("./provider-core.cjs");
const {
  analyzeVideoCardText,
  auditRecoveryAction,
  classifySubmissionState,
  chooseUiTarget,
  judgeRecoveryAction,
  verifyGenerationAnnouncement,
} = require("./semantic-guard.cjs");

const TRUSTED_NAVIGATION = /(^|\.)doubao\.com$/i;
const IMAGE_PAGE = "https://www.doubao.com/chat/create-image";
const VIDEO_PAGE = "https://www.doubao.com/chat/create-video";
const HOME_PAGE = "https://www.doubao.com/";
const PARKED_X = -30_000;
const PARKED_Y = 0;
const STANDARD_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function protocolClick(webContents, target) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
  await debuggerClient.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await wait(45);
  await debuggerClient.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
}

class UserActionRequiredError extends Error {
  constructor(message, code = "DOUBAO_LOGIN_REQUIRED") {
    super(message);
    this.status = 401;
    this.code = code;
  }
}

function isTrustedNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && TRUSTED_NAVIGATION.test(url.hostname);
  } catch {
    return false;
  }
}

function visibleElementScript() {
  return `function visible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }`;
}

async function inspectSession(webContents) {
  const pageUrl = webContents.getURL();
  if (!isTrustedNavigation(pageUrl)) {
    return { loggedIn: false, verificationRequired: false, reason: "尚未进入豆包页面", pageUrl };
  }
  const result = await webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var bodyText = (document.body && document.body.innerText || '').slice(0, 30000);
    var verification = /安全验证|完成验证|拖动滑块|机器人验证|验证码/.test(bodyText);
    var composer = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).find(visible);
    var loginControl = Array.from(document.querySelectorAll('button,a,[role="button"]')).find(function(el) {
      var text = (el.innerText || el.textContent || '').trim();
      return visible(el) && /^(登录|立即登录|扫码登录)$/.test(text);
    });
    var authenticatedShell = /新对话/.test(bodyText) && /最近|项目/.test(bodyText) && bodyText.length > 120;
    var href = location.href.toLowerCase();
    var loggedOutByUrl = href.indexOf('from_logout=1') >= 0 || href.indexOf('/login') >= 0 || href.indexOf('passport') >= 0;
    var loggedIn = !verification && !loginControl && !loggedOutByUrl && (Boolean(composer) || authenticatedShell);
    return {
      loggedIn: loggedIn,
      hasComposer: Boolean(composer),
      loggedOut: Boolean(loginControl) || loggedOutByUrl,
      verificationRequired: verification,
      reason: verification ? '豆包要求人工验证' : (loggedIn ? (composer ? '网页登录有效' : '登录有效，创作区仍在加载') : '尚未登录豆包'),
    };
  })()`, true).catch(() => ({ loggedIn: false, verificationRequired: false, reason: "页面状态读取失败" }));
  return { ...result, pageUrl };
}

async function waitForComposer(webContents, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastState;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await inspectSession(webContents);
    lastState = state;
    if (state.verificationRequired) {
      throw new UserActionRequiredError("豆包要求人工验证，已打开对应账号窗口。", "DOUBAO_VERIFICATION_REQUIRED");
    }
    if (state.loggedIn && state.hasComposer) return state;
    if (state.loggedOut) {
      throw new UserActionRequiredError("豆包账号尚未登录，已打开对应账号窗口。");
    }
    await wait(750);
  }
  if (lastState?.loggedIn) {
    const error = new Error("豆包登录有效，但 AI 创作区没有完成加载；任务没有发送");
    error.status = 502;
    error.code = "CREATION_SURFACE_NOT_READY";
    throw error;
  }
  throw new UserActionRequiredError("豆包账号尚未登录，已打开对应账号窗口。");
}

async function collectArtifacts(webContents, mediaType) {
  return webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    function httpUrl(value) { return /^https?:\/\//i.test(value || ''); }
    var values = [];
    function add(value, kind, width, height) {
      if (!httpUrl(value)) return;
      if (/avatar|emoji|icon|logo|favicon|badge/i.test(value)) return;
      if (kind === 'image' && width && height && (width < 180 || height < 180)) return;
      if (!values.some(function(item) { return item.url === value; })) {
        values.push({ url: value, kind: kind, width: width || 0, height: height || 0 });
      }
    }
    if (${JSON.stringify(mediaType)} === 'image') {
      Array.from(document.querySelectorAll('img')).forEach(function(img) {
        if (!visible(img)) return;
        add(img.currentSrc || img.src, 'image', img.naturalWidth || img.width, img.naturalHeight || img.height);
      });
    } else {
      Array.from(document.querySelectorAll('video')).forEach(function(video) {
        add(video.currentSrc || video.src, 'video', video.videoWidth, video.videoHeight);
        Array.from(video.querySelectorAll('source')).forEach(function(source) { add(source.src, 'video', 0, 0); });
      });
      Array.from(document.querySelectorAll('a[href]')).forEach(function(link) {
        if (/\.mp4(?:\?|$)|video|play_addr/i.test(link.href || '')) add(link.href, 'video', 0, 0);
      });
    }
    return values;
  })()`, true).catch(() => []);
}

function safeNetworkLocation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`.slice(0, 400);
  } catch {
    return "invalid";
  }
}

async function startNetworkCapture(webContents, mediaType, onEvent) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Network.enable");
  const candidates = new Map();
  const preferredCandidates = new Map();
  const responseBodies = new Map();
  // 2026-09-15：请求被拒时只有状态码看不出原因，这里把 4xx/5xx 的响应正文也带回日志。
  const errorResponses = new Map();
  function addPayload(value, channel, sourceUrl = "") {
    for (const artifact of extractPreferredArtifacts(value, mediaType)) {
      const identity = artifact.identity || artifact.url;
      preferredCandidates.set(identity, { ...artifact, channel, sourceUrl });
    }
    for (const url of extractArtifactUrls(value, mediaType)) {
      candidates.set(url, { url, kind: mediaType, width: 0, height: 0, priority: 10, channel, sourceUrl });
    }
  }
  function onMessage(_event, method, params) {
    if (method === "Network.responseReceived") {
      const mimeType = String(params.response?.mimeType || "").toLowerCase();
      const resourceType = String(params.type || "");
      const status = Number(params.response?.status || 0);
      if (["Fetch", "XHR"].includes(resourceType) && status >= 400) {
        onEvent("doubao_network_error", {
          status,
          resourceType,
          url: safeNetworkLocation(params.response?.url || ""),
        });
        errorResponses.set(params.requestId, {
          status,
          url: safeNetworkLocation(params.response?.url || ""),
        });
      }
      if (["Fetch", "XHR"].includes(resourceType) && /json|text|octet-stream/u.test(mimeType)) {
        responseBodies.set(params.requestId, {
          size: Number(params.response?.encodedDataLength || 0),
          sourceUrl: String(params.response?.url || ""),
        });
      }
      return;
    }
    if (method === "Network.loadingFinished" && errorResponses.has(params.requestId)) {
      const failed = errorResponses.get(params.requestId);
      errorResponses.delete(params.requestId);
      void debuggerClient.sendCommand("Network.getResponseBody", { requestId: params.requestId }).then((result) => {
        const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
        onEvent("doubao_error_body", {
          status: failed.status,
          url: failed.url,
          body: String(body || "").replace(/\s+/g, " ").slice(0, 600),
        });
      }).catch(() => undefined);
      return;
    }
    if (method === "Network.loadingFinished" && responseBodies.has(params.requestId)) {
      const response = responseBodies.get(params.requestId);
      const size = Number(params.encodedDataLength || response?.size || 0);
      responseBodies.delete(params.requestId);
      if (size > 12 * 1024 * 1024) return;
      void debuggerClient.sendCommand("Network.getResponseBody", { requestId: params.requestId }).then((result) => {
        const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
        addPayload(body, "response-body", response?.sourceUrl);
      }).catch(() => undefined);
      return;
    }
    if (method === "Network.webSocketFrameReceived") {
      const frame = String(params.response?.payloadData || "");
      addPayload(frame, "websocket");
      // 2026-09-15：提交被拒时服务端常常只在 WebSocket 里回一句提示，
      // HTTP 层看不到任何 4xx，光看状态码会误判成“网络正常”。
      if (/error|错误|失败|违规|额度|invalid|not_allow|reject/u.test(frame)) {
        onEvent("doubao_ws_notice", { body: frame.replace(/\s+/g, " ").slice(0, 400) });
      }
      return;
    }
    if (method === "Network.eventSourceMessageReceived") {
      addPayload(params.data || "", "event-source");
      return;
    }
    if (method === "Network.loadingFailed" && ["Fetch", "XHR"].includes(String(params.type || ""))) {
      onEvent("doubao_network_failed", {
        resourceType: String(params.type || ""),
        canceled: Boolean(params.canceled),
        errorText: String(params.errorText || "").slice(0, 200),
      });
    }
  }
  debuggerClient.on("message", onMessage);
  return {
    reset: () => {
      candidates.clear();
      preferredCandidates.clear();
    },
    snapshot: () => {
      const preferred = [...preferredCandidates.values()];
      return preferred.length ? preferred : [...candidates.values()];
    },
    stop: () => debuggerClient.removeListener("message", onMessage),
  };
}

async function selectVisibleOption(webContents, requested, aliases = []) {
  const terms = [requested, ...aliases].map((value) => String(value || "").trim()).filter(Boolean);
  if (!terms.length) return { selected: false, reason: "no-request" };
  const controlLabel = terms.some((term) => term.includes(":"))
    ? "比例"
    : terms.some((term) => /秒$/u.test(term))
      ? "时长"
      : terms.some((term) => /seed/iu.test(term))
        ? "模型"
        : "";
  const trigger = await webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var terms = ${JSON.stringify(terms)};
    var controlLabel = ${JSON.stringify(controlLabel)};
    function label(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function normalized(value) { return value.toLowerCase().replace(/[\\s_-]+/g, '').replace(/：/g, ':'); }
    function matches(text) {
      var value = normalized(text);
      return terms.some(function(term) {
        var expected = normalized(term);
        return value === expected || value.indexOf(expected) >= 0;
      });
    }
    var compact = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup="listbox"],[aria-haspopup="menu"]'))
      .filter(function(el) { var text = label(el); return visible(el) && text.length > 0 && text.length < 80 && matches(text); });
    var trigger = compact.sort(function(a, b) { return label(a).length - label(b).length; })[0];
    if (trigger) return { alreadySelected: true, value: label(trigger) };
    if (!trigger) {
      trigger = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup="listbox"],[aria-haspopup="menu"]')).find(function(el) {
        var text = label(el);
        var looksLikeCurrentValue = controlLabel === '模型'
          ? /seedream|图片\s*[45](?:\.|\s)/i.test(text)
          : controlLabel === '比例'
            ? /\d+\s*[:：]\s*\d+/.test(text)
            : false;
        return controlLabel && visible(el) && text.length < 80 && (text.indexOf(controlLabel) >= 0 || looksLikeCurrentValue);
      });
    }
    if (!trigger) return null;
    var rect = trigger.getBoundingClientRect();
    return { id: trigger.id || '', x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`, true).catch(() => null);
  if (trigger?.alreadySelected) return { selected: true, value: trigger.value, alreadySelected: true };
  if (!trigger) return { selected: false, reason: "control-not-found" };
  await protocolClick(webContents, trigger);
  await wait(350);
  const option = await webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var terms = ${JSON.stringify(terms)};
    function label(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function normalized(value) { return value.toLowerCase().replace(/[\\s_-]+/g, '').replace(/：/g, ':'); }
    function matches(text) {
      var value = normalized(text);
      return terms.some(function(term) {
        var expected = normalized(term);
        return value === expected || value.indexOf(expected) >= 0;
      });
    }
    var options = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,button,[role="button"]')).filter(function(el) {
      var value = label(el);
      return visible(el) && value.length > 0 && value.length < 100 && matches(value);
    });
    var option = options.sort(function(a, b) { return label(a).length - label(b).length; })[0];
    if (!option) return null;
    var rect = option.getBoundingClientRect();
    return { value: label(option), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`, true).catch(() => null);
  if (!option) return { selected: false, reason: "option-not-found" };
  await protocolClick(webContents, option);
  await wait(400);
  const verified = await webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var terms = ${JSON.stringify(terms)};
    function label(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function normalized(value) { return value.toLowerCase().replace(/[\\s_-]+/g, '').replace(/：/g, ':'); }
    function matches(text) {
      var value = normalized(text);
      return terms.some(function(term) {
        var expected = normalized(term);
        return value === expected || value.indexOf(expected) >= 0;
      });
    }
    var controls = Array.from(document.querySelectorAll('button,[role="button"],[aria-haspopup="listbox"],[aria-haspopup="menu"]')).filter(function(el) {
      var value = label(el);
      return visible(el) && value.length > 0 && value.length < 80 && matches(value);
    });
    return controls.length > 0;
  })()`, true).catch(() => false);
  return { selected: verified, value: option.value, reason: verified ? "" : "selection-not-confirmed" };
}

async function dismissOpenMenu(webContents) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await debuggerClient.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
}

async function configureImageGenerationOptions(
  webContents,
  request,
  selectOption = selectVisibleOption,
  pause = wait,
) {
  let model = { selected: false, reason: "not-checked" };
  let aspectRatio = { selected: false, reason: "not-checked" };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    model = await selectOption(webContents, request.model || "Seedream 4.5", [
      "Seedream 4.5",
      "Seedream4.5",
      "图片 4.5",
    ]);
    aspectRatio = await selectOption(webContents, request.aspect_ratio || "16:9", [
      "16:9",
      "16：9",
      "横版 16:9",
    ]);
    if (model.selected && aspectRatio.selected) return { model, aspectRatio };
    await dismissOpenMenu(webContents).catch(() => undefined);
    await pause(700);
  }
  return { model, aspectRatio };
}


/**
 * 2026-09-15：参考图注入走“真实文件选择器”路径。
 *
 * 排查结论：带图提交失败不是上传问题（prepare_upload → TOS → CommitImageUpload
 * 全部 200），而是 create-video 落地页发出的请求体里附件残缺（file:{}），
 * 服务端回 SSE 710020702；首页「视频生成」路径附件完整、可正常受理。
 * 这里保持最接近人工操作的两级策略：
 *   1) 可信点击“上传图片/添加照片”（或首页视频模式的 “+” 图标按钮），
 *      等系统文件选择框被拦截后写入真实文件路径；
 *   2) 兜底：直接把真实文件路径写给页面里的 `input[type=file]`。
 */
async function attachReferenceViaFileChooser(webContents, filePaths) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Page.enable");
  await debuggerClient.sendCommand("DOM.enable");
  await debuggerClient.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
  let chooser = null;
  const onMessage = (_event, method, params) => {
    if (method === "Page.fileChooserOpened") chooser = params;
  };
  debuggerClient.on("message", onMessage);
  try {
    const trigger = await webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      var composer = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible)
        .sort(function (a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
      var composerTop = composer ? composer.getBoundingClientRect().top : 700;
      var el = Array.from(document.querySelectorAll('button,[role="button"],label,div,span'))
        .filter(visible)
        .find(function (node) {
          var text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          return text === '上传图片' || text === '添加照片' || /^上传图片|^添加照片/.test(text);
        });
      if (!el) {
        // 首页视频模式的 “+” 图标按钮：无文字，靠 aria-label/图标 + 位置识别
        el = Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(visible)
          .find(function (node) {
            var r = node.getBoundingClientRect();
            var label = node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title')) || '';
            var inComposerRow = r.top > composerTop - 60 && r.top < composerTop + 160;
            return r.width > 12 && r.width < 48 && r.height > 12 && r.height < 48 && inComposerRow
              && (/上传|添加|附件|图片|plus|image/i.test(label) || Boolean(node.querySelector('svg')));
          });
      }
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true).catch(() => null);
    if (trigger) {
      await protocolClick(webContents, trigger);
      for (let attempt = 0; attempt < 25 && !chooser; attempt += 1) await wait(200);
    }
    if (chooser?.backendNodeId) {
      await debuggerClient.sendCommand("DOM.setFileInputFiles", {
        files: filePaths,
        backendNodeId: chooser.backendNodeId,
      });
      return { ok: true, count: filePaths.length, mode: "file-chooser" };
    }
    return { ok: false, error: "没有等到豆包的文件选择框" };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    debuggerClient.removeListener("message", onMessage);
    await debuggerClient.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }
}

/**
 * 兜底路径：直接把真实本地文件写给页面里的 `input[type=file]`。
 * Playwright 的 set_input_files 用的就是这条 CDP 调用。
 */
async function attachReferenceViaFileInput(webContents, filePaths) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("DOM.enable");
  const document = await debuggerClient.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await debuggerClient.sendCommand("DOM.querySelectorAll", {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  });
  const inputs = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [];
  if (!inputs.length) return { ok: false, error: "豆包页面没有找到参考图上传入口" };
  let target = inputs[0];
  for (const nodeId of inputs) {
    try {
      const { attributes } = await debuggerClient.sendCommand("DOM.getAttributes", { nodeId });
      const acceptIndex = attributes.indexOf("accept");
      const accept = acceptIndex >= 0 ? String(attributes[acceptIndex + 1] || "") : "";
      if (!accept || /image|\.png|\.jpe?g|\.webp/iu.test(accept)) {
        target = nodeId;
        break;
      }
    } catch {
      // 读不到属性就用默认 input
    }
  }
  await debuggerClient.sendCommand("DOM.setFileInputFiles", { files: filePaths, nodeId: target });
  return { ok: true, count: filePaths.length, mode: "file-input" };
}

async function injectReferenceFiles(webContents, filePaths) {
  // 模型下拉常常还开着，会盖住输入区，先关掉再挂图。
  await dismissOpenMenu(webContents).catch(() => undefined);
  await wait(400);
  const viaChooser = await attachReferenceViaFileChooser(webContents, filePaths);
  if (viaChooser.ok) return viaChooser;
  const viaInput = await attachReferenceViaFileInput(webContents, filePaths);
  return viaInput.ok ? viaInput : { ...viaInput, chooserError: viaChooser.error };
}

/** 等待上传动画停下；返回 false 表示超时。 */
async function waitForReferenceSettle(webContents, timeoutMs = 180_000) {
  let stable = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await wait(900);
    const pending = await webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      return Array.from(document.querySelectorAll('[aria-busy="true"],[class*="uploading"],[class*="progress"],[class*="loading"]')).some(visible);
    })()`, true).catch(() => true);
    stable = pending ? 0 : stable + 1;
    if (stable >= 3) return true;
  }
  return false;
}

/** 参考图是否真的挂在输入区：出现 blob 预览或附件卡片。 */
async function hasAttachedReference(webContents) {
  return webContents.executeJavaScript(`(() => {
    var blob = Array.from(document.querySelectorAll('img')).some(function (img) {
      return String(img.currentSrc || img.src || '').indexOf('blob:') === 0;
    });
    var cards = document.querySelectorAll('[data-kind="image"],[aria-label$=".png"],[aria-label$=".jpg"],[aria-label$=".jpeg"],[aria-label$=".webp"]').length;
    return blob || cards > 0;
  })()`, true).catch(() => false);
}

/**
 * 2026-09-15 晚：带参考图的视频任务改走用户人工路径。
 * /chat/create-video 落地页提交带图请求时，请求体附件是残缺的 file:{}，
 * 服务端一律回 SSE {code:710020702,"system error"}，客户端随即重置会话；
 * 而首页输入工具栏「视频生成」chip 切出的同页视频模式，挂图后附件携带完整
 * uri/尺寸/上传状态，实测服务端正常受理（SSE_ACK + 真实 conversation_id）。
 * 因此这里复刻人工路径：首页 → 点「视频生成」→ 等视频模式生效。
 */
async function enterVideoModeFromHome(webContents, { ownerEmail = "", onModelFallback = () => undefined } = {}) {
  const readCandidates = () => webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var out = [];
    var seen = new Set();
    Array.from(document.querySelectorAll('button,[role="button"],div,span')).filter(visible).forEach(function (el) {
      var t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t !== '视频生成' || el.children.length > 3) return;
      // The label is often a nested DIV inside the real skill button. Clicking
      // the smallest matching node is layout-dependent and can miss the button.
      var target = el.closest('button,[role="button"]') || el;
      if (!visible(target)) return;
      var r = target.getBoundingClientRect();
      var testid = target.getAttribute('data-testid') || '';
      var key = testid + ':' + Math.round(r.left) + ':' + Math.round(r.top) + ':' + Math.round(r.width) + ':' + Math.round(r.height);
      if (seen.has(key)) return;
      seen.add(key);
      var priority = testid === 'skill_bar_button_17' ? 0 : target.tagName === 'BUTTON' ? 1 : target.getAttribute('role') === 'button' ? 2 : 3;
      out.push({
        id: 'video-entry-' + out.length,
        text: t,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        area: Math.round(r.width * r.height),
        priority: priority,
        tag: target.tagName,
        role: target.getAttribute('role') || '',
        testid: testid,
      });
    });
    out.sort(function (a, b) { return a.priority - b.priority || a.area - b.area; });
    return { selected: out[0] || null, candidates: out, pageText: (document.body && document.body.innerText || '').slice(-3500) };
  })()`, true).catch(() => null);
  const readChip = async () => (await readCandidates())?.selected || null;
  const dispatchDomClick = (chip) => {
    if (!chip?.testid) return Promise.resolve(false);
    return webContents.executeJavaScript(`(() => {
      var el = document.querySelector('[data-testid=' + ${JSON.stringify(chip.testid)} + ']');
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); el.click(); return true; } catch { return false; }
    })()`, true).catch(() => false);
  };
  const videoModeActive = () => webContents.executeJavaScript(`(() => {
    var t = document.body ? (document.body.innerText || '') : '';
    return /模型\\s*Seedance/.test(t) && /视频生成/.test(t);
  })()`, true).catch(() => false);

  if (await videoModeActive()) return { ok: true, alreadyActive: true };
  let lastChip = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const chip = await readChip();
    if (!chip) {
      await wait(1_500);
      continue;
    }
    lastChip = chip;
    await protocolClick(webContents, chip);
    for (let i = 0; i < 20; i += 1) {
      await wait(500);
      if (i === 2 && chip.testid === "skill_bar_button_17") await dispatchDomClick(chip);
      if (await videoModeActive()) return { ok: true, entry: chip };
    }
  }
  if (ownerEmail) {
    const snapshot = await readCandidates();
    const modelCandidates = (snapshot?.candidates || []).filter((candidate) => candidate.testid !== "skill_input_exit_button");
    if (modelCandidates.length) {
      let screenshotDataUrl = "";
      try {
        screenshotDataUrl = webContents.capturePage ? (await webContents.capturePage()).toDataURL() : "";
      } catch {
        screenshotDataUrl = "";
      }
      const choice = await chooseUiTarget({
        action: "点击豆包首页输入工具栏中的视频生成按钮，切换到视频生成模式",
        candidates: modelCandidates,
        pageText: snapshot.pageText,
        screenshotDataUrl,
        ownerEmail,
      });
      if (choice) {
        await onModelFallback({ method: choice.method, candidateId: choice.id, confidence: choice.confidence, reason: choice.reason });
        await protocolClick(webContents, choice);
        for (let i = 0; i < 20; i += 1) {
          await wait(500);
          if (i === 2) await dispatchDomClick(choice);
          if (await videoModeActive()) return { ok: true, entry: choice, modelFallback: true };
        }
      } else {
        await onModelFallback({
          method: "none",
          candidateCount: modelCandidates.length,
          reason: "文本模型与视觉模型均未返回置信度足够的候选按钮",
        });
      }
    } else {
      await onModelFallback({ method: "none", candidateCount: 0, reason: "页面没有可交给模型判断的候选按钮" });
    }
  }
  return { ok: false, error: "首页没有切出视频生成模式（未出现模型控件）", entry: lastChip };
}

async function uploadReferenceImages(webContents, files) {
  if (!files.length) return;
  let totalBytes = 0;
  for (const filePath of files) {
    const info = await stat(filePath);
    totalBytes += info.size;
    // 单张 20MB 是硬约束；总量上限随张数放宽（至少留原来 80MB 的口径），
    // 免得「多带几张参考图」反过来被一个固定总量卡死。
    if (info.size > 20 * 1024 * 1024 || totalBytes > Math.max(80, 20 * files.length) * 1024 * 1024) {
      const error = new Error(`参考图片过大：单张不超过 20MB，总计不超过 ${Math.max(80, 20 * files.length)}MB`);
      error.status = 400;
      error.code = "REFERENCE_TOO_LARGE";
      throw error;
    }
  }
  // 2026-09-15：只等“不忙”不够。切过模型或页面重渲染后注入可能被丢掉，
  // 而豆包只会回一句“你上传参考图后，我会…”，任务就白等了。
  // 现在必须看到附件卡片或 blob 预览才算挂上，否则重试注入。
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await injectReferenceFiles(webContents, files);
    if (!result?.ok || result.count < files.length) {
      lastError = result?.error || "参考图没有完整进入豆包输入区";
      await wait(1_200);
      continue;
    }
    if (!(await waitForReferenceSettle(webContents))) {
      const error = new Error("参考图上传超过 3 分钟仍未稳定，任务尚未发送");
      error.status = 504;
      error.code = "REFERENCE_UPLOAD_TIMEOUT";
      throw error;
    }
    if (await hasAttachedReference(webContents)) return result;
    await wait(1_800);
  }
  const error = new Error(
    `参考图没有挂到豆包输入区（已重试 3 次）${lastError ? `：${lastError}` : ""}；任务没有发送`,
  );
  error.status = 502;
  error.code = "REFERENCE_NOT_ATTACHED";
  throw error;
}

async function injectPrompt(webContents, prompt) {
  const focusComposer = `(() => {
    ${visibleElementScript()}
    var candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
    var input = candidates.sort(function(a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
    if (!input) return { ok: false };
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      if (setter && setter.set) setter.set.call(input, ''); else input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete');
    }
    return { ok: true };
  })()`;
  // 2026-10-08：豆包更新后，参考图上传完成会抢走输入框焦点，单次注入
  // 「focus → insertText」经常落空（ready 检查处输入框为空）。现在每次
  // 注入前都重新 focus，ready 未达标就整轮重试，最多 3 次；等待时间放宽。
  let lastReady = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await wait(1_200);
    const focusResult = await webContents.executeJavaScript(focusComposer, true);
    if (!focusResult?.ok) {
      continue;
    }
    webContents.insertText(prompt);
    await wait(600);
    lastReady = await webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      var candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
      var input = candidates.sort(function(a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
      var active = document.activeElement === input ? document.activeElement : input;
      if (!active) return false;
      var value = active.value !== undefined ? active.value : (active.innerText || active.textContent || '');
      return value.trim().length >= ${Math.min(Math.max(prompt.trim().length - 3, 1), 40)};
    })()`, true).catch(() => false);
    if (lastReady) return;
  }
  if (lastReady === false) {
    // 先做一次「只 focus 不注入」的探测，区分输入框消失（COMPOSER_NOT_READY）
    // 与注入被丢（PROMPT_INJECTION_FAILED），避免误报。
    const probe = await webContents
      .executeJavaScript(focusComposer, true)
      .catch(() => null);
    if (!probe?.ok) {
      const error = new Error("豆包输入框尚未准备好，任务没有发送");
      error.status = 502;
      error.code = "COMPOSER_NOT_READY";
      throw error;
    }
  }
  const error = new Error("提示词没有稳定写入豆包，任务没有发送（已重试 3 次）");
  error.status = 502;
  error.code = "PROMPT_INJECTION_FAILED";
  throw error;
}

/**
 * 提交被拒时抓现场：新对话 URL、弹窗/提示文字、页面尾部文本。
 * 2026-09-15：豆包对视频请求的拒绝（额度、限流、内容审核等）不会进入对话内容，
 * 只靠“看不到提示词”无法判断原因，所以把当时的页面证据一起带回日志与错误信息。
 */
async function captureRejectionEvidence(webContents) {
  return webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    function label(el) {
      return ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))
        .replace(/\\s+/g, ' ').trim().slice(0, 120);
    }
    var notices = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="alert"],[class*="toast"],[class*="error"],[class*="warning"]'))
      .filter(function (el) { return visible(el) && label(el); })
      .map(label);
    var tail = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(-600);
    var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]'));
    var composerText = composers.map(function (el) {
      return String(el.value !== undefined ? el.value : (el.innerText || el.textContent || ''));
    }).join('').replace(/\\s+/g, '');
    return {
      url: location.href,
      stillOnCreatePage: location.href.indexOf('create-video') >= 0,
      composerStillHoldsText: composerText.length > 0,
      composerTextLength: composerText.length,
      notices: notices.slice(0, 6),
      tail: tail
    };
  })()`, true).catch(() => null);
}

/**
 * 2026-09-16（用户要求）：参数确认卡片的回复改成**直连**——按我们已在用的
 * `/chat/completion` 协议，往同一个会话发一条文本「确认」，不再走
 * 「输入框打字 + 点发送按钮」。
 *
 * 为什么必须改：UI 路径下发送按钮会被「安全确认」弹窗的遮罩（`DIV.fixed`）盖住，
 * `submitOnce` 抛 `SUBMISSION_UNCERTAIN`；连试 3 次仍失败后任务就卡在那里——
 * 豆包一直在等确认、没有开始生成，最终 25 分钟超时才报错。直连没有遮罩问题，
 * 也不需要等输入框/按钮就绪。
 *
 * 接口形状没有现成的抓包样本（此前那几次确认都是手工打的），所以按协议推断做两个
 * 变体依次尝试，并把 SSE 原文写进事件日志便于以后收敛：
 *   A. 纯文本回复（不带 chat_ability）——卡片本质是「是/否」问答，最像正常回复；
 *   B. 带 chat_ability 的视频参数回复——保持视频模式上下文。
 */
/**
 * 运镜参数（`ability_param.camera_movement`）。
 *
 * 2026-09-18 去硬编码：这条通道一直固定发 `'fixed'`，而 ability_param 是**整支视频一个值**
 * （不分镜头）。于是「机位锁死」被写进了参数层，提示词里任何「走进／进入／走到桌边」的
 * 动作都在与它打架——S2-E1-01 那支「敲门却没进门」的成片，机位在 3.5 秒后完全冻结，
 * 与这个参数的表现一致。
 *
 * 但这是**相关性不是因果**：同一支成片的提示词里本来也同时写着「固定机位」和首帧锁定，
 * 两个原因都能单独解释现象。所以这里只做去硬编码——默认值保持 `'fixed'`（不冒险改动
 * 已验证过的路径），需要验证时可以显式传别的值（例如 `'auto'` 或空串）跑一条对比。
 *
 * 首次提交与确认回复两处必须用同一个值：否则确认分支会把运镜改回默认，参数又会打架。
 */
const DEFAULT_CAMERA_MOVEMENT = "fixed";

function resolveCameraMovement(requested) {
  const value = String(requested ?? "").trim();
  return value || DEFAULT_CAMERA_MOVEMENT;
}

async function replyDirectText(webContents, params) {
  const payload = {
    conversationId: String(params.conversationId || ""),
    text: String(params.text || ""),
    includeAbility: Boolean(params.includeAbility),
    model: String(params.model || ""),
    duration: Number(params.duration) || 5,
    ratio: String(params.ratio || "16:9"),
    cameraMovement: resolveCameraMovement(params.cameraMovement),
  };
  return webContents
    .executeJavaScript(
      `(async () => {
    const payload = ${JSON.stringify(payload)};
    const now = Date.now();
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2));
    const body = {
      client_meta: {
        local_conversation_id: 'local_' + now,
        conversation_id: payload.conversationId,
        bot_id: '7338286299411103781',
        last_section_id: '',
        last_message_index: null,
        local_permissions: [
          { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
          { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
          { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
        ],
      },
      messages: [
        {
          local_message_id: uuid(),
          content_block: [
            {
              block_type: 10000,
              content: {
                text_block: { text: payload.text, icon_url: '', icon_url_dark: '', summary: '' },
                pc_event_block: '',
              },
              block_id: uuid(),
              parent_id: '',
              meta_info: [],
              append_fields: [],
            },
          ],
          message_status: 0,
        },
      ],
      option: {
        send_message_scene: '',
        create_time_ms: now,
        collect_id: uuid(),
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: 0,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuid(),
        start_seq: 0,
        need_create_conversation: false,
        conversation_init_option: { need_ack_conversation: false },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        is_ai_playground: false,
        is_old_user: true,
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
        message_storage_type: 0,
        related_deleted_message_ids: {},
        connector_info_list: [],
        model_config: { model_item_key: '', model_extra_params: {} },
        aggregate_params: {
          mention_skill_list: '[]',
          mention_plugin_list: '[]',
          mention_ext: '[{}]',
          conversation_mode: '1',
          mode_id: '',
          model_item_key: '',
          agent_mode: '',
          reasoning_effort: '',
          provider_id: '',
        },
      },
      user_context: [],
      ext: {
        answer_with_suggest: '0',
        sub_conv_firstmet_type: '1',
        collection_id: uuid(),
        is_finish: '1',
        conversation_init_option: JSON.stringify({ need_ack_conversation: false }),
        commerce_credit_config_enable: '0',
      },
    };
    if (payload.includeAbility) {
      body.chat_ability = {
        ability_type: 17,
        ability_param: JSON.stringify({
          ratio: payload.ratio,
          model: payload.model,
          duration: payload.duration,
          camera_movement: payload.cameraMovement,
          input_box_content: {
            user_input_content: payload.text,
            reply_message_format: '生成视频：%s',
          },
        }),
      };
    }
    const started = Date.now();
    try {
      const response = await fetch('/chat/completion?aid=497858&device_platform=web&doubao_dev=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, elapsedMs: Date.now() - started, text: text.slice(0, 20000), length: text.length, includeAbility: payload.includeAbility };
    } catch (error) {
      return { error: String((error && error.message) || error), includeAbility: payload.includeAbility };
    }
  })()`,
      true,
    )
    .catch((error) => ({ error: String(error.message) }));
}

/** 读一次会话页状态：卡片是否还在、是否已开始生成、是否撞到权益/额度门槛。 */
/**
 * 读取视频会话页现场的确定性信号（是否停在参数确认卡片、卡片上的参数、额度/订阅/生成状态）。
 *
 * 2026-09-17：页面解析规则统一收进 semantic-guard 的 analyzeVideoCardText，这里用
 * `toString()` 把函数源码注入渲染进程执行——规则只有一份，不会与守卫各写一套 regex
 * 悄悄漂移；也顺带避开了在模板字符串里对正则做二次转义。
 */
async function readVideoCardState(webContents) {
  const script =
    "(() => { var analyze = " +
    analyzeVideoCardText.toString() +
    "; var raw = document.body ? (document.body.innerText || '') : '';" +
    " return analyze(raw); })()";
  return webContents.executeJavaScript(script, true).catch(() => null);
}

/** 轮询等待「已开始生成」信号；期间撞到权益门槛直接返回原因。
 * 2026-09-25（P2 修复）：「已完成」（你的视频生成好了。）同样是正信号——
 * Mini 快速生成会在观察窗内直接做完，只认「生成中」会把成功误报成超时。
 * completed 必须先于额度判断：完成页可能同时带额度字样。 */
async function waitForGeneratingSignal(webContents, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await wait(2_000);
    const state = await readVideoCardState(webContents);
    if (state?.completed) return { generating: true, completed: true };
    if (state?.quotaExhausted) return { generating: false, reason: "quota-exhausted" };
    if (state?.subscriptionRequired) return { generating: false, reason: "subscription-required" };
    if (state?.generating) return { generating: true };
  }
  return { generating: false, reason: "timeout" };
}

/**
 * 2026-09-15 晚：首页「视频生成」路径的提交被受理后，豆包会先回一张
 * 「视频生成参数确认」卡片（「确认后我再开始生成视频」）。实测卡片上没有
 * 可点按钮，确认方式是在输入框回复「确认」并发送——即人工路径多出来的那步。
 * 2026-09-16：对照 dorakoo/doubao-studio 的实现补充两点——把卡片里的
 * 模型/时长/比例提取进事件便于审计（它只分类不确认，fail-closed 转人工；
 * 本产品按用户明确要求自动化，回复确认），以及识别额度耗尽文案立即失败。
 * 2026-09-16 晚（用户要求）：回复动作**整体改为直连**（replyDirectText），
 * UI 打字+点发送只保留为最后的兜底，且仅在直连两个变体都拿不到生成信号时才用。
 */
async function confirmVideoParameterCard(webContents, timeoutMs = 90_000, onEvent, options = {}) {
  const startedAt = Date.now();
  const conversationId = String(options.conversationId || "");
  let cardParams = null;

  // 阶段 1：先确认现场——可能已经自动开始生成、可能根本没有卡片、也可能先撞到权益门槛。
  const waitCardMs = Math.min(Math.max(Math.floor(timeoutMs / 2), 15_000), 45_000);
  while (Date.now() - startedAt < waitCardMs) {
    const state = await readVideoCardState(webContents);
    if (state?.completed) return { confirmed: true, via: "already-completed", cardParams };
    if (state?.quotaExhausted) return { confirmed: false, reason: "quota-exhausted", cardParams };
    if (state?.cardParams && !cardParams) cardParams = state.cardParams;
    if (state?.generating) return { confirmed: true, via: "auto-generating", cardParams };
    if (state?.cardVisible) break;
    await wait(1_500);
  }
  const snapshot = await readVideoCardState(webContents);
  if (snapshot?.completed) return { confirmed: true, via: "already-completed", cardParams };
  if (snapshot?.quotaExhausted) return { confirmed: false, reason: "quota-exhausted", cardParams };
  if (snapshot?.generating) return { confirmed: true, via: "auto-generating", cardParams };
  if (!snapshot?.cardVisible) return { confirmed: false, reason: "card-not-found", cardParams };
  if (snapshot.cardParams && !cardParams) cardParams = snapshot.cardParams;

  if (!conversationId) {
    onEvent?.("video_confirm_reply_direct", { via: "skipped", reason: "no-conversation-id" });
    return { confirmed: false, reason: "no-conversation-id", cardParams };
  }

  // 阶段 2：直连回复「确认」。两个变体依次尝试，每个之后都给 40 秒观察窗。
  for (const includeAbility of [false, true]) {
    const variant = includeAbility ? "direct-ability" : "direct-text";
    const reply = await replyDirectText(webContents, {
      conversationId,
      text: "确认",
      includeAbility,
      model: options.model || "",
      duration: options.duration || 5,
      ratio: options.ratio || "16:9",
      // 确认回复必须沿用本次任务的运镜值，否则会把参数改回默认、和提示词又打架。
      cameraMovement: options.cameraMovement,
    });
    onEvent?.("video_confirm_reply_direct", {
      via: variant,
      httpStatus: reply?.status ?? null,
      error: reply?.error || "",
      acked: /SSE_ACK|"conversation_id"/u.test(String(reply?.text || "")),
      sample: String(reply?.text || "").replace(/\s+/gu, " ").slice(0, 240),
    });
    if (reply?.error) continue;
    const outcome = await waitForGeneratingSignal(webContents, 40_000);
    if (outcome.generating) return { confirmed: true, via: variant, cardParams };
    if (outcome.reason === "quota-exhausted") return { confirmed: false, reason: "quota-exhausted", cardParams };
    if (outcome.reason === "subscription-required") return { confirmed: false, reason: "subscription-required", cardParams };
  }

  // 阶段 3（最后的兜底）：直连都没换来生成信号，才退回 UI 打字+发送。
  // 只在能确认「没有挡住的弹窗」时才做，避免历史上那种被遮罩吞掉的重试。
  onEvent?.("video_confirm_reply_direct", { via: "fallback-ui-start" });
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs && attempts < 3) {
    await confirmMaterialSafetyDialog(webContents).catch(() => undefined);
    try {
      await injectPrompt(webContents, "确认");
      await submitOnce(webContents);
    } catch (error) {
      attempts += 1;
      // 注意：本函数是模块级函数，onEvent 由调用方显式传入（闭包里拿不到）。
      onEvent?.("video_confirm_reply_failed", {
        code: error?.code || "",
        message: String(error?.message || error).slice(0, 160),
        attempts,
      });
      await wait(2_000);
      continue;
    }
    const outcome = await waitForGeneratingSignal(webContents, 30_000);
    if (outcome.generating) return { confirmed: true, via: "ui-fallback", cardParams };
    if (outcome.reason === "quota-exhausted") return { confirmed: false, reason: "quota-exhausted", cardParams };
    if (outcome.reason === "subscription-required") return { confirmed: false, reason: "subscription-required", cardParams };
    attempts += 1;
  }
  return { confirmed: false, reason: "reply-not-confirmed", cardParams };
}

/**
 * 读取会话页当前生成状态（供确认按钮点击后观察用）。
 */
async function readGenerationConfirmState(webContents) {
  return webContents.executeJavaScript(`(() => {
    var tail = (document.body && document.body.innerText || '').slice(-2500);
    var stillThere = Array.from(document.querySelectorAll('button,[role="button"]'))
      .some(function (el) {
        var r = el.getBoundingClientRect();
        var s = window.getComputedStyle(el);
        var onScreen = r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
        return onScreen && (el.innerText || '').indexOf('确认生成') >= 0;
      });
    return {
      generating: /生成中|正在生成|排队中|预计等待|停止生成|取消生成/.test(tail),
      acknowledged: /我将为你生成视频|收到，正在|大约需要/.test(tail),
      confirmStillThere: stillThere,
    };
  })()`, true).catch(() => ({ error: "state-read-failed" }));
}

/** 读取会话页尾部文本，供语义守卫判定（失败返回空串，不阻塞主流程）。 */
async function readPageTail(webContents, chars = 3500) {
  return webContents
    .executeJavaScript(`(document.body && document.body.innerText || '').slice(-${Number(chars) || 3500})`, true)
    .catch(() => "");
}

/**
 * 2026-09-16：新账号首次视频生成时，豆包不回「视频生成参数确认」卡片，而是在
 * 会话里回一条素材授权确认消息（正文大意“上传、使用的素材，均已获充分授权…”，
 * 带一个「确认生成」按钮）。无人点击它就永远不会开始生成，任务会空转到
 * GENERATION_TIMEOUT。与提交前的 confirmMaterialSafetyDialog（遮罩弹窗）不同，
 * 这是会话消息里的按钮。
 * 行为：在 timeoutMs 内轮询该按钮；按钮常在长会话的折叠线以下，先
 * scrollIntoView 滚进视口再读坐标，protocolClick（CDP 可信事件）点击，验证
 * 不消失则用 el.click() 兜底再验证。若任务已正常开始生成，页面上不会有该
 * 按钮，本函数会空转超时并返回 { clicked: false }——调用方可放心无条件调用。
 */
async function clickGenerationConfirmButton(webContents, timeoutMs = 30_000) {
  const startedAt = Date.now();
  // 全元素扫描 + 最小面积优先：不管「确认生成」是 button/[role=button] 还是
  // 带 onClick 的 div/span，都能定位到最内层的可点击叶子。
  const findButton = `(() => {
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    }
    var all = document.querySelectorAll('button,[role="button"],a,div,span');
    var matches = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var text = (el.innerText || '').replace(/\\s+/g, '');
      if (text.indexOf('确认生成') < 0) continue;
      var r = el.getBoundingClientRect();
      matches.push({ el: el, area: r.width * r.height });
    }
    var viewport = { w: window.innerWidth, h: window.innerHeight };
    if (!matches.length) return { found: false, viewport: viewport };
    matches.sort(function (a, b) { return a.area - b.area; });
    var m = matches[0];
    var info = {
      tag: m.el.tagName,
      text: (m.el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      area: Math.round(m.area),
      candidateCount: matches.length,
      viewport: viewport,
    };
    m.el.scrollIntoView({ block: 'center' });
    var r2 = m.el.getBoundingClientRect();
    info.x = Math.round(r2.left + r2.width / 2);
    info.y = Math.round(r2.top + r2.height / 2);
    info.inViewport = info.y >= 0 && info.y <= window.innerHeight && info.x >= 0 && info.x <= window.innerWidth;
    return Object.assign({ found: true }, info);
  })()`;
  while (Date.now() - startedAt < timeoutMs) {
    const target = await webContents.executeJavaScript(findButton, true).catch(() => ({ found: false }));
    if (target?.found) {
      await protocolClick(webContents, target);
      await wait(3_000);
      let after = await readGenerationConfirmState(webContents);
      if (after?.confirmStillThere) {
        // 可信点击没生效：JS click 兜底（React 合成事件监听在根节点，能收到）。
        const jsClicked = await webContents.executeJavaScript(`(() => {
          function visible(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            var s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
          }
          var all = document.querySelectorAll('button,[role="button"],a,div,span');
          var matches = [];
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (!visible(el)) continue;
            if ((el.innerText || '').replace(/\\s+/g, '').indexOf('确认生成') < 0) continue;
            var r = el.getBoundingClientRect();
            matches.push({ el: el, area: r.width * r.height });
          }
          if (!matches.length) return { clicked: false, reason: 'not-found' };
          matches.sort(function (a, b) { return a.area - b.area; });
          matches[0].el.scrollIntoView({ block: 'center' });
          matches[0].el.click();
          return { clicked: true, tag: matches[0].el.tagName };
        })()`, true).catch(() => ({ clicked: false, reason: "exec-failed" }));
        await wait(3_000);
        after = await readGenerationConfirmState(webContents);
        return { clicked: true, tag: target.tag, text: target.text, via: "js-click-fallback", jsClicked, after };
      }
      return { clicked: true, tag: target.tag, text: target.text, via: "protocol-click", after };
    }
    await wait(1_500);
  }
  return { clicked: false };
}

async function confirmSubmissionAccepted(webContents, prompt, options = {}) {
  const delay = options.wait || wait;
  const timeoutMs = Number(options.timeoutMs || 90_000);
  const stripped = String(prompt || "").replace(/\s+/gu, "");
  const marker = stripped.slice(0, 12);
  // 2026-09-15 第三轮：检测“豆包反问参数”必须在提示词结束之后的区域里做。
  // 早先用提示词开头定位回复区域，结果侧栏会话标题回显了提示词开头、
  // 后面跟着的正是提示词自身“不要要求确认或补充任何参数”的措辞，被误判成豆包提问。
  const endMarker = stripped.slice(-16);
  const startedAt = Date.now();
  let evidence = { generating: false, promptVisible: false, composerHoldsPrompt: false, acknowledged: false, asksParams: false };
  // “提示词落在对话区”必须连续可见若干次才算数：带参考图被豆包放弃时，
  // 会话会短暂出现（能看到提示词）再被重置，只凭一次采样会误判成提交成功。
  let visibleStreak = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await delay(2_000);
    const current = await webContents.executeJavaScript(`(() => {
      var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]'));
      var composerText = composers.map(function (el) {
        return String(el.value !== undefined ? el.value : (el.innerText || el.textContent || '')).replace(/\\s+/g, '');
      }).join('');
      var marker = ${JSON.stringify(marker)};
      var inComposer = composers.length > 0 && marker.length > 0 && composerText.indexOf(marker) >= 0;
      // 关键：提示词必须出现在“输入框之外”的文本节点里才算真发出去。
      // 2026-09-15：早先直接搜整页 innerText，把“还留在输入框里”误判成已提交。
      // 2026-09-15 晚：侧栏会话标题会回显提示词开头，所以还要排除会话列表区域——
      // 否则页面上一条旧会话就能把它变成“已提交”。判据：祖先里有会话列表语义，
      // 或承载元素明显比对话区窄（侧栏条目通常只有窗口宽度的两成左右）。
      var promptVisible = false;
      if (marker.length > 0) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
          if (String(node.nodeValue || '').indexOf(marker) < 0) continue;
          var parent = node.parentElement;
          var inside = composers.some(function (c) { return c === parent || (c.contains && parent && c.contains(parent)); });
          if (inside) continue;
          var cursor = parent;
          var blocked = false;
          var width = 0;
          for (var depth = 0; depth < 8 && cursor; depth += 1) {
            var signature = [
              cursor.tagName,
              cursor.id || '',
              typeof cursor.className === 'string' ? cursor.className : '',
              cursor.getAttribute ? (cursor.getAttribute('role') || '') : '',
            ].join(' ');
            if (/\\b(nav|aside)\\b|sidebar|sider|history|session|conversation-list|conv-list|chat-list/i.test(signature)) {
              blocked = true;
              break;
            }
            if (!width) {
              var rect = cursor.getBoundingClientRect();
              if (rect.width) width = rect.width;
            }
            cursor = cursor.parentElement;
          }
          if (blocked) continue;
          if (width && width < window.innerWidth * 0.35) continue;
          promptVisible = true;
          break;
        }
      }
      var tail = (document.body.innerText || '').slice(-20000);
      var endMarker = ${JSON.stringify(endMarker)};
      // 2026-09-15：提示词只是“出现在对话里”不代表豆包开始生成——
      // 豆包也可能把它当成提问、回复一段确认参数的话（侧栏标题会变成“确定视频参数”）。
      // 2026-09-15 晚：豆包的确认文案实测是「收到，正在为您生成视频…大约需要 1-3 分钟」，
      // 用的是“您”，早先只写“你”导致把正在生成的任务误判成失败。这里统一放宽。
      var acknowledged = /(我将|正在|开始)?为(你|您)生成|收到[，,]?\\s*正在|为我生成|已收到|已提交|加入队列|预计等待|正在排队|排队中|大约需要/.test(tail);
      var generating = /生成中|正在生成|正在为(你|您)生成|为(你|您)生成视频|排队中|停止生成|取消生成|预计等待|大约需要/.test(tail);
      // 只在提示词结束之后（豆包的回复区域）检测“反问参数”。
      // 找不到提示词结尾时宁可不算反问，也不能把提示词自身的措辞当提问。
      var asksParams = false;
      if (endMarker.length >= 6) {
        var endIdx = tail.lastIndexOf(endMarker);
        var replyRegion = endIdx >= 0 ? tail.slice(endIdx + endMarker.length) : '';
        asksParams = replyRegion.length > 0 && /(请|需要|想要)[^。\\n]{0,8}(确认|选择|补充|提供)|请告诉我|时长[^。\\n]{0,8}(还是|或者)|比例[^。\\n]{0,8}(还是|或者)|(确认|选择)[^。\\n]{0,8}(视频)?(参数|时长|比例)/.test(replyRegion);
      }
      return {
        acknowledged: acknowledged,
        generating: generating,
        promptVisible: promptVisible,
        composerHoldsPrompt: inComposer,
        asksParams: asksParams,
        refusal: (function () {
          var match = tail.match(/(出了点问题[^。\\n]{0,20}|请稍后重试|生成失败|无法生成|暂时不可用|内容不符合|涉嫌违规|额度已用完|次数已用完|今日次数)/);
          return match ? match[0].slice(0, 40) : '';
        })(),
      };
    })()`, true).catch(() => null);
    if (current) evidence = current;
    visibleStreak = evidence.promptVisible ? visibleStreak + 1 : 0;
    // 豆包已经明确回绝：立刻失败并带回它的原话，不再空等。
    if (evidence.refusal) {
      return { ...evidence, accepted: false, refused: true, elapsedMs: Date.now() - startedAt };
    }
    // 豆包在反问参数而不是生成：提示词虽已进对话，但生成永远不会开始。
    if (evidence.asksParams && !evidence.acknowledged && !evidence.generating) {
      return { ...evidence, accepted: false, askedParams: true, elapsedMs: Date.now() - startedAt };
    }
    // 确认文案或生成中状态立即算受理。
    if (evidence.acknowledged || evidence.generating) {
      return { ...evidence, accepted: true, elapsedMs: Date.now() - startedAt };
    }
    // 兜底：提示词在对话区连续可见（≈6 秒）也算受理——用来兜住豆包确认文案的措辞漂移。
    if (visibleStreak >= 3) {
      return { ...evidence, accepted: true, elapsedMs: Date.now() - startedAt };
    }
  }
  return { ...evidence, accepted: false, elapsedMs: Date.now() - startedAt };
}

async function findSendTarget(webContents) {
  return webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var candidates = Array.from(document.querySelectorAll('#flow-end-msg-send,[data-testid="chat_input_send_button"],button[type="submit"],button[aria-label*="发送"],[data-testid*="send"]'));
    var matches = candidates.filter(function(el) {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      var text = [(el.innerText || ''), el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.id || ''].join(' ');
      return !/重新|停止|下载|保存/i.test(text);
    });
    if (!matches.length) {
      var composer = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible).sort(function(a, b) {
        return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      })[0];
      var root = composer;
      for (var depth = 0; depth < 5 && root && root.parentElement; depth += 1) root = root.parentElement;
      matches = Array.from((root || document).querySelectorAll('button,[role="button"]')).filter(function(el) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        var rect = el.getBoundingClientRect();
        var text = [(el.innerText || ''), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
        return rect.width <= 72 && rect.height <= 72 && (/发送|send/i.test(text) || rect.left > window.innerWidth * 0.72);
      });
    }
    var target = matches.sort(function(a, b) {
      return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
    })[0];
    if (!target) return null;
    var rect = target.getBoundingClientRect();
    // 记录“到底点到了谁”：带参考图时若点错控件，症状与“消息消失”完全一样。
    var label = [
      target.tagName,
      target.id ? '#' + target.id : '',
      target.getAttribute('aria-label') || '',
      target.getAttribute('data-testid') || '',
      (target.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
    ].filter(Boolean).join(' | ');
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      label: label,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  })()`, true).catch(() => null);
}

/**
 * 2026-09-16 直连通道：ability_param.model 的取值映射与校验。
 *
 * 各档位的时长上限（2026-09-16 实测校正）：
 * - **Mini 上限 10 秒**：账号 1、账号 2 提交 `seedance_v2.0_mini` + 15 秒，豆包都回
 *   「这是豆包订阅标准套餐专属能力」；同一账号 mini + 10 秒则正常走到参数确认卡片。
 * - **Fast 可到 15 秒**：run1（请求 fast + 15s）、run2（请求 v2.0 + 15s 被降级）都真的出过
 *   15 秒成片。权益校验看的是**请求里的 model 参数**，不是豆包最终执行的模型
 *   （run1 请求 fast、豆包实际跑 Mini，依然放行）。
 * - 标准 2.0 只支持 5 秒档。
 *
 * 「模型 + 时长」冲突一律按用户决策**拦下**，不做静默降级。
 */
const ABILITY_VIDEO_MODELS = {
  "seedance-2.0-mini": { param: "seedance_v2.0_mini", label: "Seedance 2.0 Mini", maxDuration: 10 },
  "seedance-2.0-fast": { param: "seedance_v2.0_fast", label: "Seedance 2.0 Fast", maxDuration: 15 },
  "seedance-2.0": { param: "seedance_v2.0", label: "Seedance 2.0", maxDuration: 5 },
};

function resolveAbilityVideoModel(requested) {
  const key = String(requested || "").trim().toLowerCase();
  return ABILITY_VIDEO_MODELS[key] || ABILITY_VIDEO_MODELS["seedance-2.0-mini"];
}

/**
 * 模型 + 时长的提交前校验（用户 2026-09-16 决策：冲突就拦下、不静默降级）。
 * 上限见 ABILITY_VIDEO_MODELS：mini 10 秒、fast 15 秒、标准 2.0 5 秒。
 */
function validateVideoRequest(modelKey, durationSeconds) {
  const model = resolveAbilityVideoModel(modelKey);
  const duration = Math.min(Math.max(Math.round(Number(durationSeconds) || 0) || 5, 4), 15);
  if (duration > model.maxDuration) {
    return {
      ok: false,
      code: "VIDEO_MODEL_DURATION_CONFLICT",
      model,
      duration,
      reason: `${model.label} 只支持 ${model.maxDuration} 秒档，当前对白估算需要 ${duration} 秒；请改选 Seedance 2.0 Fast（可到 15 秒），或缩短该镜头对白`,
    };
  }
  return { ok: true, model, duration };
}

/** 参考图元数据兜底：解析失败时退回既有取值（等于修复前的行为，不制造新风险）。 */
const DEFAULT_IMAGE_ORI = { width: 2848, height: 1600, format: "png" };
/**
 * 单次任务可携带的参考图上限（全链路单一来源，main.cjs 直接复用）。
 * 豆包图片侧参考图官方最多 9 张，这里取 10 留一张余量；超限由 main.cjs 显式报错，
 * 不截断——截断就是静默丢素材。
 */
const MAX_REFERENCE_IMAGES = 10;
/** SOF 段可能被 EXIF/内嵌缩略图推到较后位置，头部分析给 1MB 足够。 */
const IMAGE_HEADER_MAX_BYTES = 1024 * 1024;
const REFERENCE_URI_PATTERN = /tos-cn-i-[a-z0-9]+\/[A-Za-z0-9._-]+/u;

/** 只读文件前缀——图片头解析不需要整文件进内存。 */
async function readFilePrefix(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 从图片二进制头读出真实宽高与格式（PNG / JPEG / WebP / GIF），纯函数、可单测。
 * 解析不出来返回 null，由调用方回退。
 */
function parseImageBufferInfo(buffer) {
  // 最小有效头：GIF 头 10 字节；PNG 要读到 offset 20 才知道宽高，各自再判。
  if (!buffer || buffer.length < 10) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width && height ? { width, height, format: "png" } : null;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // 无长度字段的标记：SOI / TEM / RSTn
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      // SOF0—SOF15，排除 DHT/JPG/DAC
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return width && height ? { width, height, format: "jpeg" } : null;
      }
      offset += 2 + length;
    }
    return null;
  }
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = buffer.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X" && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return width && height ? { width, height, format: "webp" } : null;
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return width && height ? { width, height, format: "webp" } : null;
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return width && height ? { width, height, format: "webp" } : null;
    }
    return null;
  }
  if (buffer.subarray(0, 3).toString("latin1") === "GIF" && buffer.length >= 10) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return width && height ? { width, height, format: "gif" } : null;
  }
  return null;
}

/**
 * 逐张描述本地参考图的真实元数据。
 *
 * 2026-09-18：直连通道原先给 `image_ori` 写死 2848×1600，恰好等于工作台分镜图的尺寸
 * （已核对：`ref-S2-E1-01.png` 正是 2848×1600），所以一直没暴露。换成视频抽帧、用户手动
 * 上传或任何非 16:9 素材，元数据就对不上——豆包按元数据排版/出缩略图时会错乱。
 * 现在读真实文件头；解析失败才回退，并用 `dimensionsSource` 留痕，不再静默。
 */
async function describeReferenceImages(filePaths) {
  const infos = [];
  for (const filePath of filePaths) {
    let parsed = null;
    try {
      parsed = parseImageBufferInfo(await readFilePrefix(filePath, IMAGE_HEADER_MAX_BYTES));
    } catch {
      parsed = null;
    }
    infos.push(
      parsed
        ? {
          fileName: path.basename(filePath),
          width: parsed.width,
          height: parsed.height,
          format: parsed.format,
          dimensionsSource: "file-header",
        }
        : { fileName: path.basename(filePath), ...DEFAULT_IMAGE_ORI, dimensionsSource: "fallback" },
    );
  }
  return infos;
}

/** 从请求体/响应体里找出可能的原始文件名，用于把 uri 与本地文件精确配对。 */
function extractFileNameHints(text) {
  const hints = [];
  for (const match of String(text || "").matchAll(/"(?:file_name|filename|name|file_name_origin)"\s*:\s*"([^"]{1,200})"/gu)) {
    hints.push(match[1]);
  }
  for (const match of String(text || "").matchAll(/[A-Za-z0-9_\u4e00-\u9fff-]{1,80}\.(?:png|jpe?g|webp|gif)/giu)) {
    hints.push(match[0]);
  }
  return hints;
}

/**
 * 从 CommitImageUpload 的请求体里直接取出 uri。
 *
 * 2026-09-18 实测（只读探针 `tmp/probe-reference-upload.json`）：豆包是**每张图一个
 * CommitImageUpload 请求**，请求体形如 `{"SessionKey":"<base64>"}`，base64 解出来是
 * `{"StoreInfos":"[{\"StoreUri\":\"tos-cn-i-…/xxx.png\"…}]","uri":"tos-cn-i-…/xxx.png",…}`。
 * 也就是说 **uri 在请求侧就能拿到**，不必等响应体——这比「等 loadingFinished 再取响应体」
 * 更快也更少依赖调试器权限。响应体那条路保留为兜底。
 *
 * 注意：TOS key 是哈希名（`13f16f75…png`），豆包**不回报原始文件名**，所以按文件名
 * 配对是做不到的——配对只能按请求/到达顺序，这点在 `pairCapturedUris` 里写明。
 */
function extractUrisFromCommitRequest(postData) {
  const uris = [];
  for (const match of String(postData || "").matchAll(/"SessionKey"\s*:\s*"([A-Za-z0-9+/=]{16,})"/gu)) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const uri = decoded.match(REFERENCE_URI_PATTERN);
      if (uri) uris.push(uri[0]);
    } catch { /* 解码失败就走响应体兜底 */ }
  }
  return uris;
}

/** 读回输入区已挂参考图卡片的文件名（DOM 顺序 = 展示顺序），用于核对配对是否与本地顺序一致。 */
async function readAttachedReferenceLabels(webContents) {
  return webContents.executeJavaScript(`(() => {
    var names = [];
    Array.from(document.querySelectorAll('[aria-label],[alt],[title]')).forEach(function (el) {
      var value = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
      if (!/\\.(png|jpe?g|webp|gif)$/i.test(value)) return;
      if (names.indexOf(value) < 0) names.push(value);
    });
    return names.slice(0, 20);
  })()`, true).catch(() => []);
}

/**
 * 把捕获到的 uri 与本地文件配对。
 *
 * 优先按文件名精确匹配——只有当**每张本地文件都唯一命中**时才采信文件名配对；
 * 否则退回到达顺序。理由：把 uri 配错图会让提示词里的「参考图1/2」分工指错对象，
 * 宁可退化成顺序对应（并在遥测里写明配对来源），也不要一个看起来更聪明但会指错人的结果。
 */
function pairCapturedUris(filePaths, captured) {
  if (captured.length === filePaths.length && filePaths.length > 0) {
    const used = new Set();
    const assigned = [];
    let matched = 0;
    for (const filePath of filePaths) {
      const basename = path.basename(filePath).toLowerCase();
      const hit = captured.findIndex((item, position) => (
        !used.has(position)
        && (item.fileNameHints || []).some((hint) => String(hint).toLowerCase().endsWith(basename))
      ));
      if (hit < 0) break;
      used.add(hit);
      assigned.push(hit);
      matched += 1;
    }
    if (matched === filePaths.length) {
      return { uris: assigned.map((position) => captured[position].uri), pairing: "file-name" };
    }
  }
  return { uris: captured.map((item) => item.uri), pairing: "arrival-order" };
}

/**
 * 挂参考图并取回豆包侧的文件 uri（**全部**，不只是第一张）。
 *
 * 走界面的真实上传链（prepare_upload → 对象存储 → CommitImageUpload），同时监听网络
 * 把 CommitImageUpload 里的 uri 抓回来；直连请求要用这些 uri 自己构造附件块，
 * 所以不能只依赖「界面上出现了缩略图」。
 *
 * 2026-09-18 修复：原实现是单个 `capturedUri` 变量 + `if (match && !capturedUri)`，
 * 只留第一张，第 2..N 张被**静默丢弃且零警告**（工作台侧明明支持最多 10 张）。
 * 现在按张收集，并尽量用请求/响应体里的文件名做精确配对。
 */
async function attachReferenceAndCaptureUri(webContents, filePaths) {
  const debuggerClient = webContents.debugger;
  if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
  await debuggerClient.sendCommand("Network.enable").catch(() => undefined);
  const requestHints = new Map();
  const watched = new Map();
  const captured = [];
  const pushCaptured = (uri, hints) => {
    if (!uri || captured.some((item) => item.uri === uri)) return;
    captured.push({ uri, fileNameHints: hints || [] });
  };
  const onMessage = async (_event, method, params) => {
    try {
      if (method === "Network.requestWillBeSent") {
        const url = String(params.request?.url || "");
        const postData = String(params.request?.postData || "");
        if (/CommitImageUpload/iu.test(url)) {
          requestHints.set(params.requestId, extractFileNameHints(postData));
          // 主路径：uri 就在请求体的 SessionKey 里，按请求发出顺序收集。
          for (const uri of extractUrisFromCommitRequest(postData)) {
            pushCaptured(uri, requestHints.get(params.requestId));
          }
        }
        return;
      }
      if (method === "Network.responseReceived") {
        const url = String(params.response?.url || "");
        if (/CommitImageUpload/iu.test(url)) watched.set(params.requestId, url);
        return;
      }
      if (method === "Network.loadingFinished" && watched.has(params.requestId)) {
        // 兜底：请求体解析不出 uri 时，再从响应体里捞一次。
        watched.delete(params.requestId);
        const body = await debuggerClient.sendCommand("Network.getResponseBody", { requestId: params.requestId }).catch(() => null);
        if (!body) return;
        const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body.body || "");
        const match = text.match(REFERENCE_URI_PATTERN);
        if (!match) return;
        pushCaptured(match[0], [
          ...(requestHints.get(params.requestId) || []),
          ...extractFileNameHints(text),
          path.basename(match[0]),
        ]);
      }
    } catch { /* 监听器不能影响主流程 */ }
  };
  debuggerClient.on("message", onMessage);
  try {
    const attachResult = await uploadReferenceImages(webContents, filePaths);
    // 逐张上传：等到 uri 全部到齐，或超时（每张最多 12 秒，总上限 120 秒）。
    const deadline = Math.min(120_000, filePaths.length * 12_000 + 20_000);
    const startedAt = Date.now();
    while (captured.length < filePaths.length && Date.now() - startedAt < deadline) await wait(500);
    const paired = pairCapturedUris(filePaths, captured);
    // DOM 上挂着的卡片文件名（展示顺序）：用于核对「uri 顺序 == 本地文件顺序」，
    // 配错了至少在遥测里留痕，而不是无声地按错顺序组装。
    const pageLabels = await readAttachedReferenceLabels(webContents);
    return {
      attach: attachResult,
      captured,
      pageLabels,
      orderConfirmed: pageLabels.length === filePaths.length
        && pageLabels.every((label, index) => path.basename(filePaths[index]).toLowerCase() === String(label).toLowerCase()),
      ...paired,
    };
  } finally {
    debuggerClient.removeListener("message", onMessage);
  }
}

/**
 * 直连通道：在已登录页面内自己构造 /chat/completion 请求。
 * 参数全部走 chat_ability.ability_param（model/duration/ratio/camera_movement），
 * 附件走 attachment_block（需要事先拿到 uri）。返回服务端 SSE 原文供判定。
 *
 * 2026-09-18：附件从「写死的单张 reference-1.png + 写死 2848×1600」改成
 * 按 `images[]` 逐张构造——每张一个独立 identifier、真实文件名、真实宽高。
 * 单张时 `local_message_id` 仍等于该附件的 identifier，与修复前的报文完全一致，
 * 不改变已验证过的单图路径。豆包网页/桌面端只提供参考图（无首尾帧位），
 * 多张参考图就是这条通道唯一能表达「多图控制」的形式。
 */
async function submitDirectVideoRequest(webContents, params) {
  const payload = {
    prompt: String(params.prompt || ""),
    model: String(params.model || ""),
    duration: Number(params.duration) || 5,
    ratio: String(params.ratio || "16:9"),
    images: (Array.isArray(params.images) ? params.images : [])
      .map((item) => ({
        uri: String(item?.uri || ""),
        name: String(item?.name || "reference.png"),
        width: Math.max(0, Math.round(Number(item?.width) || 0)),
        height: Math.max(0, Math.round(Number(item?.height) || 0)),
        format: String(item?.format || "png"),
      }))
      .filter((item) => item.uri),
    cameraMovement: resolveCameraMovement(params.cameraMovement),
  };
  return webContents.executeJavaScript(`(async () => {
    const payload = ${JSON.stringify(payload)};
    const now = Date.now();
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2));
    const messages = [];
    if (payload.images.length) {
      const attachments = payload.images.map(function (image) {
        const identifier = uuid();
        return {
          type: 1,
          identifier: identifier,
          image: {
            name: image.name,
            uri: image.uri,
            image_ori: {
              url: '',
              width: image.width,
              height: image.height,
              format: image.format,
              url_formats: {},
            },
          },
          parse_state: 0,
          review_state: 1,
          upload_status: 1,
          progress: 100,
          src: '',
        };
      });
      messages.push({
        local_message_id: attachments[0].identifier,
        content_block: [
          {
            block_type: 10052,
            content: {
              attachment_block: { attachments: attachments },
              pc_event_block: '',
            },
            block_id: uuid(),
            parent_id: '',
            meta_info: [],
            append_fields: [],
          },
        ],
        message_status: 0,
      });
    }
    messages.push({
      local_message_id: uuid(),
      content_block: [
        {
          block_type: 10000,
          content: {
            text_block: { text: '生成视频：' + payload.prompt, icon_url: '', icon_url_dark: '', summary: '' },
            pc_event_block: '',
          },
          block_id: uuid(),
          parent_id: '',
          meta_info: [],
          append_fields: [],
        },
      ],
      message_status: 0,
    });
    const body = {
      client_meta: {
        local_conversation_id: 'local_' + now,
        conversation_id: '',
        bot_id: '7338286299411103781',
        last_section_id: '',
        last_message_index: null,
        local_permissions: [
          { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
          { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
          { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
        ],
      },
      messages: messages,
      option: {
        send_message_scene: '',
        create_time_ms: now,
        collect_id: uuid(),
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: 0,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuid(),
        start_seq: 0,
        need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        is_ai_playground: false,
        is_old_user: true,
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
        message_storage_type: 0,
        related_deleted_message_ids: {},
        connector_info_list: [],
        model_config: { model_item_key: '', model_extra_params: {} },
        aggregate_params: {
          mention_skill_list: '[]',
          mention_plugin_list: '[]',
          mention_ext: '[{}]',
          conversation_mode: '1',
          mode_id: '',
          model_item_key: '',
          agent_mode: '',
          reasoning_effort: '',
          provider_id: '',
        },
        conversation_mode: 1,
      },
      chat_ability: {
        ability_type: 17,
        ability_param: JSON.stringify({
          ratio: payload.ratio,
          model: payload.model,
          duration: payload.duration,
          camera_movement: payload.cameraMovement,
          input_box_content: {
            user_input_content: payload.prompt,
            reply_message_format: '生成视频：%s',
          },
        }),
      },
      user_context: [],
      ext: {
        answer_with_suggest: '0',
        sub_conv_firstmet_type: '1',
        collection_id: uuid(),
        is_finish: '1',
        conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
        commerce_credit_config_enable: '0',
      },
    };
    const started = Date.now();
    try {
      const response = await fetch('/chat/completion?aid=497858&device_platform=web&doubao_dev=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, elapsedMs: Date.now() - started, text: text.slice(0, 20000), length: text.length };
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  })()`, true).catch((error) => ({ error: String(error.message) }));
}

/**
 * 2026-09-16：账号首次上传素材时豆包会弹「安全确认」授权弹窗
 * （「你在本功能中上传、使用的素材，均已获充分授权……取消 / 确认」），
 * 弹窗遮罩（DIV.fixed）会盖住发送按钮，导致提交点击落空、输入框不清空。
 * 这是账号级一次性条款确认（默认账号早已点过），自动点「确认」放行；
 * 与 dorakoo/doubao-studio 的 materialAuthorization 模块对应（它严格匹配
 * 标题+正文+动作后才允许自动确认，这里同样只认这一个弹窗，别的弹窗不点）。
 */
async function confirmMaterialSafetyDialog(webContents) {
  const target = await webContents.executeJavaScript(`(() => {
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
    }
    var body = document.body ? (document.body.innerText || '') : '';
    if (body.indexOf('安全确认') < 0 || body.indexOf('上传、使用的素材') < 0 || body.indexOf('充分授权') < 0) return null;
    var btn = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).find(function (el) {
      return (el.innerText || '').replace(/\\s+/g, '').trim() === '确认';
    });
    if (!btn) return { dialogVisible: true, confirmFound: false };
    var r = btn.getBoundingClientRect();
    return { dialogVisible: true, confirmFound: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, true).catch(() => null);
  if (!target) return { handled: false };
  if (!target.confirmFound) return { handled: false, reason: "confirm-button-not-found" };
  await protocolClick(webContents, target);
  await wait(1_000);
  return { handled: true };
}

async function submitOnce(webContents) {
  const target = await findSendTarget(webContents);
  if (!target) {
    const error = new Error("没有找到可用的豆包发送按钮，任务没有发送");
    error.status = 502;
    error.code = "SEND_CONTROL_NOT_READY";
    throw error;
  }
  // 点击前先读控件状态：参考图还在上传时发送键可能是 disabled，点了等于没点。
  const before = await webContents.executeJavaScript(`(() => {
    var el = document.querySelector('#flow-end-msg-send,[data-testid="chat_input_send_button"]');
    var body = (document.body && document.body.innerText || '').slice(-4000);
    return {
      sendDisabledBefore: el ? Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true') : null,
      uploading: /上传中|正在上传|处理中/.test(body),
    };
  })()`, true).catch(() => ({ sendDisabledBefore: null, uploading: null }));
  await protocolClick(webContents, target);
  let evidence = { inputCleared: false, generating: false, sendDisabled: false };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(500);
    evidence = await webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
      var composer = composers.sort(function(a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
      var value = composer && composer.value !== undefined ? composer.value : (composer && (composer.innerText || composer.textContent) || '');
      var send = document.querySelector('#flow-end-msg-send,[data-testid="chat_input_send_button"],button[type="submit"],button[aria-label*="发送"]');
      var tail = (document.body && document.body.innerText || '').slice(-8000);
      return {
        inputCleared: !String(value || '').trim(),
        generating: /生成中|正在生成|排队中|停止生成|取消生成/.test(tail),
        sendDisabled: Boolean(send && (send.disabled || send.getAttribute('aria-disabled') === 'true')),
      };
    })()`, true).catch(() => ({ inputCleared: false, generating: false, sendDisabled: false }));
    if (evidence.inputCleared || evidence.generating || evidence.sendDisabled) return { ...target, ...before, ...evidence };
  }
  // 2026-10-08：豆包前端改版后，挂参考图时点发送按钮不再产生任何可观察证据
  // （输入框不清空、无生成提示、按钮不禁用），怀疑点击落在错误控件上。
  // 回退到对输入框发真实回车键——不依赖发送按钮 DOM，对改版免疫。
  await webContents.executeJavaScript(`(() => {
    ${visibleElementScript()}
    var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
    var composer = composers.sort(function(a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
    if (composer) composer.focus();
    return Boolean(composer);
  })()`, true).catch(() => false);
  webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  webContents.sendInputEvent({ type: "char", keyCode: "Return" });
  webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(500);
    evidence = await webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
      var composer = composers.sort(function(a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
      var value = composer && composer.value !== undefined ? composer.value : (composer && (composer.innerText || composer.textContent) || '');
      var send = document.querySelector('#flow-end-msg-send,[data-testid="chat_input_send_button"],button[type="submit"],button[aria-label*="发送"]');
      var tail = (document.body && document.body.innerText || '').slice(-8000);
      return {
        inputCleared: !String(value || '').trim(),
        generating: /生成中|正在生成|排队中|停止生成|取消生成/.test(tail),
        sendDisabled: Boolean(send && (send.disabled || send.getAttribute('aria-disabled') === 'true')),
      };
    })()`, true).catch(() => ({ inputCleared: false, generating: false, sendDisabled: false }));
    if (evidence.inputCleared || evidence.generating || evidence.sendDisabled) {
      return { ...target, ...before, ...evidence, viaKey: true };
    }
  }
  if (!evidence.inputCleared && !evidence.generating && !evidence.sendDisabled) {
    const error = new Error("发送动作结果不确定，请在已打开的豆包账号中核对；系统不会自动重复发送");
    error.status = 409;
    error.code = "SUBMISSION_UNCERTAIN";
    throw error;
  }
  return { ...target, ...before, ...evidence };
}

async function waitForNewArtifacts(webContents, mediaType, baselineUrls, timeoutMs, networkCapture) {
  const baseline = new Set(baselineUrls);
  const startedAt = Date.now();
  let stableCount = 0;
  let lastSignature = "";
  let lastCandidates = [];
  while (Date.now() - startedAt < timeoutMs) {
    await wait(2_500);
    const state = await inspectSession(webContents);
    if (!state.loggedIn) {
      throw new UserActionRequiredError(
        state.verificationRequired ? "豆包要求人工验证，已打开对应账号窗口。" : "豆包登录已失效，已打开对应账号窗口。",
        state.verificationRequired ? "DOUBAO_VERIFICATION_REQUIRED" : "DOUBAO_LOGIN_REQUIRED",
      );
    }
    const all = [...(networkCapture?.snapshot() || []), ...await collectArtifacts(webContents, mediaType)];
    const unique = new Map();
    for (const item of all) {
      const identity = item.identity || item.url;
      if (!identity || (item.url && baseline.has(item.url))) continue;
      const current = unique.get(identity);
      if (!current || Number(item.priority || 0) > Number(current.priority || 0)) unique.set(identity, item);
    }
    const candidates = [...unique.values()]
      .filter((item) => isReadyArtifactCandidate(item, mediaType))
      .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
    const signature = candidates.map((item) => item.identity || item.url).sort().join("\n");
    if (signature && signature === lastSignature) stableCount += 1;
    else stableCount = 0;
    lastSignature = signature;
    lastCandidates = candidates;
    if (lastCandidates.length && stableCount >= 2) return lastCandidates;
  }
  const error = new Error(`${mediaType === "video" ? "视频" : "图片"}生成超时；请到豆包历史记录核对，系统不会自动重复发送`);
  error.status = 504;
  error.code = "GENERATION_TIMEOUT";
  throw error;
}

function createDoubaoAdapter({ BrowserWindow, session, onEvent = () => undefined }) {
  const windows = new Map();
  const taskWindows = new Set();

  function parkWindow(win) {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    win.setSkipTaskbar(true);
    win.setBounds({ x: PARKED_X, y: PARKED_Y, width: 1280, height: 900 }, false);
    if (!win.isVisible()) win.showInactive();
  }

  function showWindowForUser(win, accountId) {
    win.setSkipTaskbar(false);
    win.center();
    win.setAlwaysOnTop(true, "floating");
    win.show();
    win.focus();
    win.moveTop();
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 1_500);
    onEvent("account_window_shown", {
      accountId,
      visible: win.isVisible(),
      bounds: win.getBounds(),
    });
  }

  function createWindow(account, title) {
    const partition = `persist:doubao-native-${account.account_id}`;
    session.fromPartition(partition).setUserAgent(STANDARD_USER_AGENT);
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      x: PARKED_X,
      y: PARKED_Y,
      show: true,
      skipTaskbar: true,
      title,
      backgroundColor: "#ffffff",
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    // 豆包网页即使停在后台/移到屏幕外，也可能播放播报音频；隐藏窗口不等于静音。
    // 生成图片和视频不依赖页面音频，因此对 Provider 管理的所有豆包窗口统一静音。
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(({ url }) => {
      // 2026-09-15：带参考图提交时豆包可能把生成中的对话打开在新标签页/新窗口。
      // 这里只如实记录请求，先看清豆包的真实意图，再决定是否放行。
      onEvent("window_open_requested", {
        url: String(url || "").slice(0, 200),
        trusted: isTrustedNavigation(url),
      });
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedNavigation(url)) {
        onEvent("navigation_blocked", { url: String(url || "").slice(0, 200) });
        event.preventDefault();
      }
    });
    win.webContents.on("did-navigate", (_event, url) => {
      onEvent("navigated", { url: String(url || "").slice(0, 200) });
    });
    return win;
  }

  function getWindow(account) {
    const current = windows.get(account.account_id);
    if (current && !current.isDestroyed()) return current;
    const win = createWindow(account, `豆包登录 · ${account.display_name}`);
    win.on("closed", () => {
      if (windows.get(account.account_id) === win) windows.delete(account.account_id);
    });
    windows.set(account.account_id, win);
    return win;
  }

  async function createTaskWindow(account, targetUrl) {
    const win = createWindow(account, `豆包生成 · ${account.display_name}`);
    taskWindows.add(win);
    win.on("closed", () => taskWindows.delete(win));
    parkWindow(win);
    await win.loadURL(targetUrl);
    return win;
  }

  async function navigate(account, targetUrl, visible = false) {
    const win = getWindow(account);
    if (visible) {
      showWindowForUser(win, account.account_id);
    } else parkWindow(win);
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.startsWith(targetUrl)) {
      await win.loadURL(targetUrl);
    }
    return win;
  }

  async function check(account) {
    const win = await navigate(account, IMAGE_PAGE, false);
    const startedAt = Date.now();
    let state = await inspectSession(win.webContents);
    while (
      !state.loggedIn &&
      !state.loggedOut &&
      !state.verificationRequired &&
      Date.now() - startedAt < 15_000
    ) {
      await wait(500);
      state = await inspectSession(win.webContents);
    }
    return state;
  }

  async function login(account, timeoutMs) {
    let win = await navigate(account, IMAGE_PAGE, true);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (win.isDestroyed()) {
        return { loggedIn: false, verificationRequired: false, reason: "登录窗口已关闭", pageUrl: "" };
      }
      const state = await inspectSession(win.webContents);
      if (state.loggedIn) {
        parkWindow(win);
        return state;
      }
      await wait(1_000);
    }
    return { loggedIn: false, verificationRequired: false, reason: "等待登录超时", pageUrl: win.webContents.getURL() };
  }

  function findNested(value, predicate, depth = 0) {
    if (value == null || depth > 24) return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findNested(child, predicate, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = findNested(child, predicate, depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function requestDoubaoJson(account, rawUrl, options = {}) {
    const accountSession = session.fromPartition(`persist:doubao-native-${account.account_id}`);
    const response = await accountSession.fetch(rawUrl, {
      credentials: "include",
      ...options,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": STANDARD_USER_AGENT,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new UserActionRequiredError("豆包登录已失效，已打开对应账号窗口。");
    }
    if (!response.ok) throw new Error(`豆包媒体接口返回 HTTP ${response.status}`);
    return response.json();
  }

  async function resolveVideoFromLibrary(account, vid, state) {
    if (!vid) return null;
    const origin = "https://www.doubao.com";
    const post = (route, body) => requestDoubaoJson(account, `${origin}/samantha/aispace/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Referer: `${origin}/chat/create-video`,
      },
      body: JSON.stringify(body),
    });
    if (!state.creationNodeId) {
      const homepage = await post("homepage", {});
      state.creationNodeId = findNested(homepage?.data || homepage, (item) => item.name === "我的创作")?.id || "";
    }
    if (!state.creationNodeId) return null;
    if (!state.assetNodeId) {
      const nodeInfo = await post("node_info?aid=582478", { node_id: state.creationNodeId });
      state.assetNodeId = findNested(nodeInfo?.data || nodeInfo, (item) => String(item.key || "") === String(vid))?.id || "";
    }
    if (!state.assetNodeId) return null;
    const downloadInfo = await post("get_download_info?aid=582478", { requests: [{ node_id: state.assetNodeId }] });
    const info = findNested(downloadInfo?.data || downloadInfo, (item) => Boolean(item.main_url));
    if (!info) return null;
    const url = decodeVideoMainUrl(
      info.main_url,
      info.key_seed || downloadInfo?.data?.key_seed || downloadInfo?.key_seed || "",
    );
    if (!url) return null;
    const meta = info.meta || info.video_info || {};
    return {
      url,
      vid,
      kind: "video",
      width: Number(meta.width || info.width || 0),
      height: Number(meta.height || info.height || 0),
      priority: 100,
      source: "aispace_download_info",
    };
  }

  async function resolveVideoFromFallback(account, fallbackApi) {
    if (!fallbackApi) return null;
    const url = buildUnwatermarkedVideoApi(fallbackApi);
    const payload = await requestDoubaoJson(account, url, {
      headers: { Referer: "https://www.doubao.com/chat/create-video" },
    });
    return selectBestVideoArtifact(payload, fallbackApi);
  }

  async function resolveVideoArtifact(account, reference, timeoutMs = 60 * 60_000) {
    const startedAt = Date.now();
    const state = { creationNodeId: "", assetNodeId: "" };
    let lastError;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        // 2026-09-16：成片刚出现在「我的创作」时，下载地址往往还没就绪，
        // resolveVideoFromLibrary 会返回一个 url 为空的半成品。过去直接采信它，
        // 导致上层 fetch(undefined) 报 "Failed to parse URL from undefined"、
        // 任务以 ARTIFACT_NOT_AVAILABLE 失败（视频其实已经生成好）。
        // 现在必须拿到真正的下载地址才算成功，否则继续轮询。
        const fromLibrary = await resolveVideoFromLibrary(account, reference.vid, state);
        if (fromLibrary?.url) return fromLibrary;
        const fromFallback = await resolveVideoFromFallback(account, reference.fallbackApi);
        if (fromFallback?.url) return fromFallback;
      } catch (error) {
        if (error instanceof UserActionRequiredError) throw error;
        lastError = error;
      }
      await wait(5_000);
    }
    const error = new Error(lastError?.message || "豆包视频已经生成，但原始下载地址仍未准备好");
    error.status = 504;
    error.code = "VIDEO_DOWNLOAD_NOT_READY";
    throw error;
  }

  /** 「我的创作」作品清单（debugLibrary 与直连取片共用同一份解析）。 */
  async function libraryRows(account) {
    const origin = "https://www.doubao.com";
    const post = (route, body) => requestDoubaoJson(account, `${origin}/samantha/aispace/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Referer: `${origin}/chat/create-video`,
      },
      body: JSON.stringify(body),
    });
    const homepage = await post("homepage", {});
    const creation = findNested(homepage?.data || homepage, (item) => item.name === "我的创作");
    if (!creation?.id) throw new Error("没有找到「我的创作」节点");
    const nodeInfo = await post("node_info?aid=582478", { node_id: creation.id });
    const rows = [];
    const walk = (value, depth = 0) => {
      if (value == null || depth > 12) return;
      if (Array.isArray(value)) {
        for (const child of value) walk(child, depth + 1);
        return;
      }
      if (typeof value !== "object") return;
      if (value.name || value.key) {
        rows.push({
          name: String(value.name || "").slice(0, 60),
          key: String(value.key || "").slice(0, 40),
          type: String(value.type || value.node_type || value.content_type || ""),
          createTime: value.create_time || value.created_at || value.update_time || "",
        });
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    walk(nodeInfo);
    return { creationNodeId: creation.id, rows };
  }

  /**
   * 会话里出现豆包的「拒绝 / 权益门槛」文案时，翻成可读错误码立即失败。
   *
   * 2026-09-16 实测：账号 2 提交后只收到「这是豆包订阅标准套餐专属能力，开通标准套餐，我就能继续
   * 为你服务」，豆包并未开始生成；旧实现拿到 SSE_ACK 后傻等 15 分钟才报超时，用户完全看不出原因。
   * 这些短语足够特异，不会和正常会话内容混淆。
   */
  async function detectGenerationBlocker(webContents) {
    return webContents
      .executeJavaScript(
        `(() => {
          var text = document.body ? document.body.innerText || "" : "";
          var rules = [
            { code: "DOUBAO_SUBSCRIPTION_REQUIRED", re: /订阅标准套餐专属能力|开通标准套餐|订阅专属能力/ },
            { code: "DOUBAO_QUOTA_EXHAUSTED", re: /免费次数用完|免费额度已用完|今日视频生成免费次数/ },
            { code: "DOUBAO_REFUSED", re: /抱歉.{0,10}(无法|不能)|内容不符合|生成失败，请重试/ },
          ];
          for (var i = 0; i < rules.length; i += 1) {
            if (rules[i].re.test(text)) {
              return { code: rules[i].code, excerpt: text.slice(-300) };
            }
          }
          return null;
        })()`,
        true,
      )
      .catch(() => null);
  }

  /**
   * 轮询作品库，等这次提交之后新出现的视频，返回它的 vid。
   * 直连通道的成片只走这条路取回（比 DOM 检测可靠）。
   * 每轮顺带检查会话里是否出现权益/拒绝文案——出现就立刻失败，绝不空等。
   */
  async function waitForNewLibraryVideo(account, sinceMs, webContents, timeoutMs = 25 * 60_000) {
    const sinceSec = Math.floor(sinceMs / 1000) - 5;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await wait(20_000);
      const rows = await libraryRows(account).then((result) => result.rows).catch(() => null);
      if (rows) {
        const fresh = rows
          .filter((row) => String(row.type) === "6" && Number(row.createTime || 0) >= sinceSec)
          .sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0));
        if (fresh.length) return fresh[0].key;
      }
      if (webContents && !webContents.isDestroyed()) {
        const blocker = await detectGenerationBlocker(webContents);
        if (blocker) {
          onEvent("video_generation_blocked", {
            accountId: account.account_id,
            code: blocker.code,
            excerpt: blocker.excerpt,
          });
          const reasons = {
            DOUBAO_SUBSCRIPTION_REQUIRED:
              "豆包提示该能力属于「订阅标准套餐」专属：这个账号当前档位需要订阅后才能生成；请换用其他账号，或降低档位要求后重试",
            DOUBAO_QUOTA_EXHAUSTED:
              "豆包提示该账号今日免费视频额度已用完（按 5 秒单位发放、每天约 50 秒）；请换一个有额度的账号，或等次日额度重置",
            DOUBAO_REFUSED: "豆包拒绝了这次生成请求；请打开对应账号的豆包会话查看提示后调整内容重试",
          };
          const error = new Error(reasons[blocker.code] || "豆包没有开始生成这次视频");
          error.status = blocker.code === "DOUBAO_QUOTA_EXHAUSTED" ? 429 : 409;
          error.code = blocker.code;
          throw error;
        }
      }
    }
    return "";
  }

  /**
   * 2026-09-16 新视频通道（直连，替换旧的界面点选+发送通道）：
   *   进视频模式（为拿到素材上传入口）→ 挂参考图并抓回豆包侧 uri →
   *   自建 /chat/completion（ability_param 带 model/duration/ratio/camera_movement）→
   *   需要时自动回复「确认」→ 轮询作品库按 vid 取回成片。
   */
  async function generateVideoDirect(account, request) {
    const validation = validateVideoRequest(request.model, request.duration);
    if (!validation.ok) {
      onEvent("video_request_rejected", {
        accountId: account.account_id,
        code: validation.code,
        model: validation.model.label,
        duration: validation.duration,
      });
      const error = new Error(validation.reason);
      error.status = 409;
      error.code = validation.code;
      throw error;
    }
    const references = Array.isArray(request.referenceFiles) ? request.referenceFiles : [];
    const ratio = String(request.aspect_ratio || "16:9").trim() || "16:9";
    // 首次提交与确认回复共用同一个运镜值（默认 'fixed'，保持已验证路径不变）。
    const cameraMovement = resolveCameraMovement(request.cameraMovement);
    const win = await createTaskWindow(account, HOME_PAGE);
    const submittedAtMs = Date.now();
    try {
      try {
        await waitForComposer(win.webContents);
      } catch (error) {
        if (error?.code !== "CREATION_SURFACE_NOT_READY") throw error;
        onEvent("creation_surface_reload", { accountId: account.account_id, mediaType: "video" });
        await win.loadURL(HOME_PAGE);
        await waitForComposer(win.webContents);
      }
      const entryOptions = {
        ownerEmail: request.ownerEmail || "",
        onModelFallback: (detail) => onEvent("video_mode_model_fallback", {
          accountId: account.account_id,
          mediaType: "video",
          ...detail,
        }),
      };
      let entered = await enterVideoModeFromHome(win.webContents, entryOptions);
      // 2026-09-26：SPA 偶发只渲染出输入框、不渲染「视频生成」chip（00:41 账号 3
      // 实测 VIDEO_MODE_NOT_ENTERED）。同页重试救不了坏渲染——重载首页再切一次，
      // 仍失败才报错（与上方 CREATION_SURFACE_NOT_READY 的重载自愈同构）。
      if (!entered.ok) {
        onEvent("video_mode_reload_retry", { accountId: account.account_id });
        await win.loadURL(HOME_PAGE);
        try {
          await waitForComposer(win.webContents);
        } catch (reloadError) {
          if (reloadError?.code !== "CREATION_SURFACE_NOT_READY") throw reloadError;
        }
        entered = await enterVideoModeFromHome(win.webContents, entryOptions);
      }
      onEvent("video_mode_entered", { accountId: account.account_id, mediaType: "video", entered: entered.ok, detail: entered });
      if (!entered.ok) {
        const error = new Error(`豆包首页没有切出视频生成模式：${entered.error}`);
        error.status = 502;
        error.code = "VIDEO_MODE_NOT_ENTERED";
        throw error;
      }

      let attachedImages = [];
      if (references.length) {
        const attach = await attachReferenceAndCaptureUri(win.webContents, references);
        const infos = await describeReferenceImages(references);
        const uris = attach.uris || [];
        // 第 N 张 uri 对第 N 张本地文件：uri 数与文件数一致时按配对结果逐张组装，
        // 不一致时只组装有 uri 的，并在遥测里写明缺了几张——绝不静默丢弃。
        attachedImages = uris.map((uri, index) => ({
          uri,
          name: infos[index]?.fileName || `reference-${index + 1}.png`,
          width: infos[index]?.width ?? DEFAULT_IMAGE_ORI.width,
          height: infos[index]?.height ?? DEFAULT_IMAGE_ORI.height,
          format: infos[index]?.format || DEFAULT_IMAGE_ORI.format,
        }));
        onEvent("reference_attached", {
          accountId: account.account_id,
          mediaType: "video",
          count: references.length,
          mode: attach.attach?.mode || "unknown",
          urisCaptured: attachedImages.length,
          expected: references.length,
          pairing: attach.pairing || "arrival-order",
          pageLabels: attach.pageLabels || [],
          orderConfirmed: Boolean(attach.orderConfirmed),
          dimensions: infos.map((info) => ({
            fileName: info.fileName,
            width: info.width,
            height: info.height,
            source: info.dimensionsSource,
          })),
        });
        if (!attachedImages.length) {
          const error = new Error("参考图已上传但没拿到豆包侧文件 uri，任务没有提交");
          error.status = 502;
          error.code = "REFERENCE_URI_NOT_CAPTURED";
          throw error;
        }
        if (attachedImages.length < references.length) {
          const error = new Error(
            `参考图只拿到 ${attachedImages.length}/${references.length} 张的豆包侧文件 uri，`
              + "为避免用残缺素材出片，任务没有提交；请重试，或减少本镜参考图数量。",
          );
          error.status = 502;
          error.code = "REFERENCE_URI_INCOMPLETE";
          throw error;
        }
      }

      const submit = await submitDirectVideoRequest(win.webContents, {
        prompt: request.prompt,
        model: validation.model.param,
        duration: validation.duration,
        ratio,
        cameraMovement,
        images: attachedImages,
      });
      const submitText = String(submit?.text || "");
      const quotaExhausted = /免费次数用完|今日.{0,12}(?:次数|额度)|开通豆包订阅|超出频率限制/u.test(`${submitText} ${submit?.error || ""}`);
      onEvent("video_direct_submitted", {
        accountId: account.account_id,
        model: validation.model.label,
        duration: validation.duration,
        ratio,
        referenceCount: attachedImages.length,
        hasReference: attachedImages.length > 0,
        httpStatus: submit?.status ?? null,
        accepted: /SSE_ACK/u.test(submitText),
        error: submit?.error || "",
      });
      if (submit?.error) {
        const error = new Error(`直连提交失败：${submit.error}`);
        error.status = 502;
        error.code = "VIDEO_DIRECT_REQUEST_FAILED";
        throw error;
      }
      if (quotaExhausted) {
        const error = new Error(
          "豆包该账号今日免费视频额度已用完（额度按 5 秒为单位发放，每天约 50 秒：10 条 5 秒 / 5 条 10 秒 / 3 条 15 秒 + 剩 5 秒）；请换一个有额度的账号，或等次日额度重置。",
        );
        error.status = 429;
        error.code = "DOUBAO_QUOTA_EXHAUSTED";
        throw error;
      }
      if (!/SSE_ACK/u.test(submitText)) {
        const sample = submitText.replace(/\s+/gu, " ").slice(0, 200);
        const error = new Error(`豆包没有受理这次直连提交：${sample || `HTTP ${submit?.status}`}`);
        error.status = 409;
        error.code = "SUBMISSION_NOT_ACCEPTED";
        throw error;
      }
      const conversationId = (submitText.match(/"conversation_id":"(\d+)"/u) || [])[1] || "";
      onEvent("video_direct_accepted", { accountId: account.account_id, conversationId });

      // 部分模型/时长组合会先回「视频生成参数确认」卡片，需要回复「确认」才开始生成。
      if (conversationId) {
        await win.loadURL(`https://www.doubao.com/chat/${conversationId}`).catch(() => undefined);
        await wait(4_000);
        const safety = await confirmMaterialSafetyDialog(win.webContents);
        if (safety.handled) {
          onEvent("material_safety_confirmed", { accountId: account.account_id, mediaType: "video", stage: "before-confirm" });
        }
        const confirmResult = await confirmVideoParameterCard(win.webContents, 180_000, onEvent, {
          conversationId,
          model: validation.model.param,
          duration: validation.duration,
          ratio,
          cameraMovement: cameraMovement,
        });
        onEvent("video_params_confirmed", { accountId: account.account_id, ...confirmResult });
        if (confirmResult.reason === "quota-exhausted") {
          const error = new Error("豆包该账号今日免费视频生成次数已用完，请换账号或等次日额度重置后再试");
          error.status = 429;
          error.code = "DOUBAO_QUOTA_EXHAUSTED";
          throw error;
        }
        if (confirmResult.reason === "subscription-required") {
          const error = new Error(
            "豆包提示该生成组合属于「订阅标准套餐」专属能力（免费额度不覆盖）；请换用其他账号，或把时长降到 10 秒以内改用 Mini 档。",
          );
          error.status = 409;
          error.code = "DOUBAO_SUBSCRIPTION_REQUIRED";
          throw error;
        }
        // 2026-09-16：新账号首次视频生成时，豆包不回参数卡片，而是回「素材授权确认」
        // 消息（带「确认生成」按钮）。无人点击就永远不会开始生成，任务会空转到
        // GENERATION_TIMEOUT（账号 3 实证）。
        //
        // 2026-09-17 重构（23:23 误判复盘）：原实现把现场直接丢给 GLM 分类，结果被
        // 「卡片写着 Mini、请求写着 Fast」带偏，判成 downgrade-notice 停机——而卡片
        // 同时写着 15 秒（Mini 上限只有 10 秒），型号显然是创作页选择器回显。
        // 现在改为：① 先读**确定性**现场信号（是否停在参数卡片、卡片参数、额度/订阅）；
        // ② 守卫按「自洽性」判定降档（见 semantic-guard.assessDowngradeEvidence）；
        // ③ 若现场仍是「等确认的参数卡片」，直连**补发一次「确认」**——此前两次直连 +
        //    三次 UI 兜底都没换来生成信号，那才是真实卡点，不该伪装成降档。
        if (!confirmResult.confirmed) {
          const cardState = await readVideoCardState(win.webContents).catch(() => null);
          const cardSignal = cardState || {
            cardVisible: false,
            cardParams: null,
            pageModelHint: "",
          };
          if (!cardSignal.cardParams && confirmResult.cardParams) {
            cardSignal.cardParams = confirmResult.cardParams;
          }
          const pageText = await readPageTail(win.webContents, 3500);
          const verdict = await classifySubmissionState({
            pageText,
            cardSignal,
            conversationId,
            ownerEmail: request.ownerEmail || "",
            requestedModel: validation.model.label,
            requestedDuration: validation.duration,
          });
          onEvent("semantic_guard_verdict", {
            accountId: account.account_id,
            stage: "post-submit",
            action: verdict.action,
            label: verdict.label,
            reason: verdict.reason || "",
            checked: verdict.checked || "",
            // 2026-09-17 增补：把「判什么」的证据一起落日志，避免下次还要靠反推。
            cardVisible: verdict.cardVisible ?? null,
            cardParams: verdict.cardParams || null,
            pageModelHint: verdict.pageModelHint || "",
            confirmReason: confirmResult.reason || "",
            textSample: verdict.textSample || "",
          });
          if (verdict.warning) {
            onEvent("semantic_guard_warning", {
              accountId: account.account_id,
              stage: "post-submit",
              label: verdict.label,
              reason: verdict.reason || "",
            });
          }
          if (verdict.action === "stop") {
            const conversationHint = conversationId
              ? `豆包会话 ${conversationId}`
              : "豆包会话";
            const error = new Error(
              `语义守卫拦下本次任务（${verdict.label}）：${verdict.reason}。` +
                `本次确认状态：${confirmResult.reason || "unknown"}。` +
                `请在${conversationHint}核对后重试或更换账号。`,
            );
            error.status = 409;
            error.code = "DOUBAO_GUARD_STOPPED";
            throw error;
          }
          let generatingNow = false;
          if (verdict.label === "params-card" && conversationId) {
            const retryReply = await replyDirectText(win.webContents, {
              conversationId,
              text: "确认",
              includeAbility: true,
              model: validation.model.param,
              duration: validation.duration,
              ratio,
              cameraMovement,
            });
            onEvent("video_confirm_retry_direct", {
              accountId: account.account_id,
              httpStatus: retryReply?.status ?? null,
              error: retryReply?.error || "",
              acked: /SSE_ACK|"conversation_id"/u.test(String(retryReply?.text || "")),
            });
            if (!retryReply?.error) {
              const outcome = await waitForGeneratingSignal(win.webContents, 60_000);
              onEvent("video_confirm_retry_outcome", {
                accountId: account.account_id,
                generating: Boolean(outcome.generating),
                reason: outcome.reason || "",
              });
              generatingNow = Boolean(outcome.generating);
            }
            if (!generatingNow) {
              // 2026-09-25（P2 最终防误报）：补发观察窗经常在「已完成」落地前就过期
              // （确认→生成→完成实际要 2 分钟以上，各窗口合计约 90 秒）。抛错前
              // 再给 60 秒宽限扫描——只要页面出现「生成中」或「已完成」就绝不能报
              // 「任务没有开始生成」。
              const grace = await waitForGeneratingSignal(win.webContents, 60_000);
              onEvent("video_confirm_grace_outcome", {
                accountId: account.account_id,
                generating: Boolean(grace.generating),
                completed: Boolean(grace.completed),
                reason: grace.reason || "",
              });
              if (grace.generating || grace.completed) generatingNow = true;
            }
            if (!generatingNow) {
              // 2026-09-27：确认消息可能返回 SSE_ACK，但豆包仍停在卡片上。
              // 这不是“可以放心重试”的普通失败，而是“已受理、结果不明”；
              // 让模型给出分流建议，再由确定性规则审核，禁止模型自行放行重提交。
              const recoveryEvidence = {
                conversationId,
                cardVisible: Boolean(cardSignal.cardVisible),
                cardParams: cardSignal.cardParams || confirmResult.cardParams || null,
                pageText,
                submitAccepted: true,
                replyAcked: true,
                confirmationAttempts: 5,
                generating: false,
                completed: false,
                quotaExhausted: Boolean(cardSignal.quotaExhausted),
                subscriptionRequired: Boolean(cardSignal.subscriptionRequired),
              };
              const modelRecovery = await judgeRecoveryAction({
                evidence: recoveryEvidence,
                ownerEmail: request.ownerEmail || "",
              });
              const recovery = auditRecoveryAction({
                modelAction: modelRecovery.modelAction,
                evidence: recoveryEvidence,
              });
              onEvent("submission_recovery_decision", {
                accountId: account.account_id,
                conversationId,
                modelAction: modelRecovery.modelAction,
                modelConfidence: modelRecovery.confidence,
                modelReason: modelRecovery.reason,
                auditedAction: recovery.action,
                overridden: recovery.overridden,
                auditReason: recovery.reason,
                checked: modelRecovery.checked,
              });
              const error = new Error(
                `豆包已收到提交和确认消息，但没有出现生成信号（${recovery.action}）。` +
                  `请先核对豆包会话 ${conversationId} 与作品库，再决定是否重试；` +
                  `模型建议：${modelRecovery.reason}。规则审核：${recovery.reason}。`,
              );
              error.status = 409;
              error.code = "SUBMISSION_UNCERTAIN";
              error.conversationId = conversationId;
              throw error;
            }
          }
          if (!generatingNow) {
            const genConfirm = await clickGenerationConfirmButton(win.webContents, 20_000);
            if (genConfirm.clicked) {
              onEvent("generation_confirm_clicked", {
                accountId: account.account_id,
                stage: "in-flow",
                text: genConfirm.text,
                after: genConfirm.after,
              });
            }
          }
        }
      }

      // 语义守卫第二道（2026-09-16 晚降级为遥测）：生成开始后读一次豆包宣布句并核对。
      // 实证（当晚复核，4 个样本）：宣布句「本次使用 Seedance 2.0 Mini 生成」只是回显
      // 创作页默认档位，与实际生成无关——默认账号 2 例、账号 3 正常路径 1 例宣布 Mini
      // 实测都出了 15.05 秒成片（ability_param 被尊重）；唯一真 Mini 是账号 3 的授权
      // 确认分支（18:14，点「确认生成」后重新规划，10.05s）。因此宣布句不符不再中断
      // 任务（曾因此把 22:10 账号 3 的好片误判为失败）；真正的硬拒绝由下载后的
      // mp4 实测时长检查（±20%，见 media-provider.ts downloadCandidateResult）承担。
      const announcementStartedAt = Date.now();
      let announcementVerdict = { ok: true, checked: false };
      while (Date.now() - announcementStartedAt < 45_000) {
        const tailText = await readPageTail(win.webContents, 2500);
        if (/生成失败|视频生成好了|已生成完毕/u.test(tailText)) break; // 已出结果，再等宣布句没有意义
        announcementVerdict = await verifyGenerationAnnouncement({
          text: tailText,
          requestedModel: validation.model.label,
          requestedDuration: validation.duration,
        });
        if (announcementVerdict.checked) break;
        await wait(3_000);
      }
      onEvent("generation_announcement_checked", {
        accountId: account.account_id,
        ok: announcementVerdict.ok,
        checked: announcementVerdict.checked,
        announcement: announcementVerdict.announcement || "",
        reason: announcementVerdict.reason || "",
        // 仅遥测：宣布句不可靠（见上），不一致只记录，不作为失败依据。
        telemetryOnly: true,
      });

      const vid = await waitForNewLibraryVideo(account, submittedAtMs, win.webContents);
      if (!vid) {
        const error = new Error("豆包已受理，但 25 分钟内作品库没有出现新视频；请到豆包「我的创作」核对结果");
        error.status = 409;
        error.code = "GENERATION_TIMEOUT";
        throw error;
      }
      onEvent("video_library_video_found", { accountId: account.account_id, vid });
      return [{ vid }];
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async function generate(account, request, mediaType) {
    // 2026-09-16：视频一律走直连通道（旧界面点选+发送通道已按用户要求删除）。
    if (mediaType === "video") return generateVideoDirect(account, request);
    const targetUrl = IMAGE_PAGE;
    const win = await createTaskWindow(account, targetUrl);
    let networkCapture;
    try {
      try {
        await waitForComposer(win.webContents);
      } catch (error) {
        if (error?.code !== "CREATION_SURFACE_NOT_READY") throw error;
        onEvent("creation_surface_reload", {
          accountId: account.account_id,
          mediaType,
        });
        await win.loadURL(targetUrl);
        await waitForComposer(win.webContents);
      }
    const references = Array.isArray(request.referenceFiles) ? request.referenceFiles : [];
    if (mediaType === "image") {
      let options = await configureImageGenerationOptions(win.webContents, request);
      if (!options.model.selected || !options.aspectRatio.selected) {
        onEvent("generation_options_reload", {
          accountId: account.account_id,
          modelReason: options.model.reason,
          aspectRatioReason: options.aspectRatio.reason,
        });
        await win.loadURL(targetUrl);
        await waitForComposer(win.webContents);
        options = await configureImageGenerationOptions(win.webContents, request);
      }
      if (!options.model.selected || !options.aspectRatio.selected) {
        const missing = [
          !options.model.selected ? "模型" : "",
          !options.aspectRatio.selected ? "画面比例" : "",
        ].filter(Boolean).join("和");
        const error = new Error(`豆包${missing}控件没有稳定到请求值，任务没有发送`);
        error.status = 502;
        error.code = "GENERATION_OPTIONS_NOT_READY";
        throw error;
      }
    }

    const attachResult = await uploadReferenceImages(win.webContents, references);
    if (references.length) {
      onEvent("reference_attached", {
        accountId: account.account_id,
        mediaType,
        count: references.length,
        mode: attachResult?.mode || "unknown",
      });
    }

    const baseline = (await collectArtifacts(win.webContents, mediaType)).map((item) => item.url);
      await injectPrompt(win.webContents, request.prompt);
      networkCapture = await startNetworkCapture(win.webContents, mediaType, onEvent);
      networkCapture.reset();
      // 2026-09-16：账号首传素材时的「安全确认」弹窗会盖住发送按钮，先确认放行。
      const safetyBefore = await confirmMaterialSafetyDialog(win.webContents);
      if (safetyBefore.handled) {
        onEvent("material_safety_confirmed", { accountId: account.account_id, mediaType, stage: "before-submit" });
        await wait(800);
      }
      let clickResult;
      try {
        clickResult = await submitOnce(win.webContents);
      } catch (error) {
        if (error?.code !== "SUBMISSION_UNCERTAIN") throw error;
        // 2026-09-16：点击没生效时的现场取证（对话框/遮罩/输入框内容/发送键状态）。
        const detail = await win.webContents.executeJavaScript(`(() => {
          function visible(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            var s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
          }
          var send = document.querySelector('#flow-end-msg-send');
          var sendRect = send ? send.getBoundingClientRect() : null;
          var hit = sendRect ? document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2) : null;
          var hitChain = [];
          var node = hit;
          while (node && hitChain.length < 5) {
            hitChain.push(node.tagName + (node.id ? '#' + node.id : '') + '.' + String(node.className || '').split(' ')[0]);
            node = node.parentElement;
          }
          var dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="popover"]'))
            .filter(visible).map(function (el) { return (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200); }).filter(Boolean).slice(0, 3);
          var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
          var composer = composers.sort(function (a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
          return {
            sendExists: Boolean(send),
            sendRect: sendRect ? { x: Math.round(sendRect.x), y: Math.round(sendRect.y), w: Math.round(sendRect.width), h: Math.round(sendRect.height) } : null,
            hitChain: hitChain,
            dialogs: dialogs,
            composerText: composer ? String(composer.innerText || composer.value || '').slice(0, 120) : '(none)',
            bodyTail: (document.body ? document.body.innerText || '' : '').slice(-500),
          };
        })()`, true).catch(() => null);
        onEvent("submission_uncertain_detail", { accountId: account.account_id, mediaType, detail });
        // 若现场是「安全确认」弹窗：豆包的流程是首次点发送先弹授权窗，
        // 点「确认」即完成原发送（输入框随之清空）。
        const safetyAfter = await confirmMaterialSafetyDialog(win.webContents);
        if (!safetyAfter.handled) throw error;
        onEvent("material_safety_confirmed", { accountId: account.account_id, mediaType, stage: "after-uncertain" });
        // 弹窗确认往往已经完成了发送；先核对输入框/生成状态，没发出去才重试，
        // 避免在发送键已禁用时误点其它控件（曾误点顶栏「开启自动播报」）。
        const alreadySent = await win.webContents.executeJavaScript(`(() => {
          function visible(el) {
            if (!el) return false;
            var r = el.getBoundingClientRect();
            var s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
          }
          var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
          var composer = composers.sort(function (a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0];
          var value = composer && composer.value !== undefined ? composer.value : (composer && (composer.innerText || composer.textContent) || '');
          var tail = (document.body && document.body.innerText || '').slice(-8000);
          return {
            inputCleared: !String(value || '').trim(),
            generating: /生成中|正在生成|排队中|停止生成|取消生成/.test(tail),
          };
        })()`, true).catch(() => ({ inputCleared: false, generating: false }));
        clickResult = alreadySent.inputCleared || alreadySent.generating
          ? { label: "material-safety-confirm", ...alreadySent }
          : await submitOnce(win.webContents);
      }
      onEvent("submission_click", {
        accountId: account.account_id,
        mediaType,
        label: clickResult?.label || "",
        width: clickResult?.width ?? null,
        height: clickResult?.height ?? null,
        sendDisabledBeforeClick: clickResult?.sendDisabledBefore ?? null,
        uploadingBeforeClick: clickResult?.uploading ?? null,
        inputCleared: clickResult?.inputCleared ?? null,
      });
      const candidates = await waitForNewArtifacts(
        win.webContents,
        mediaType,
        baseline,
        8 * 60_000,
        networkCapture,
      );
      onEvent("artifact_candidates_found", {
        accountId: account.account_id,
        mediaType,
        count: candidates.length,
        channels: [...new Set(candidates.map((item) => item.channel || "dom"))],
        sources: [...new Set(candidates.map((item) => item.source || "generic"))],
      });
      return candidates;
    } catch (error) {
      if (error instanceof UserActionRequiredError) {
        await navigate(account, targetUrl, true).catch(() => undefined);
      }
      throw error;
    } finally {
      networkCapture?.stop();
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async function fetchArtifact(account, url) {
    const partition = `persist:doubao-native-${account.account_id}`;
    return session.fromPartition(partition).fetch(url, { credentials: "include" });
  }

  /**
   * 按 vid 从“我的创作”取回已经生成好的视频。
   * 用途：任务在本地被判失败/中断，但豆包侧其实已经出片时，把它们捞回来，
   * 避免白等或重复生成（PROJECT.md 里记为待补的恢复路径）。
   */
  async function fetchLibraryVideo(account, vid, destinationPath) {
    const artifact = await resolveVideoFromLibrary(account, vid, { creationNodeId: "", assetNodeId: "" });
    if (!artifact?.url) return { ok: false, reason: "没有拿到下载地址" };
    const response = await fetchArtifact(account, artifact.url);
    if (!response.ok) return { ok: false, reason: `下载返回 HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) return { ok: false, reason: `下载内容过小（${buffer.length} 字节）` };
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, buffer);
    return {
      ok: true,
      bytes: buffer.length,
      width: artifact.width,
      height: artifact.height,
      source: artifact.source || "",
    };
  }

  async function downloadLatestArtifact(account, destinationPath) {
    const win = getWindow(account);
    const target = await win.webContents.executeJavaScript(`(() => {
      ${visibleElementScript()}
      var buttons = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]')).filter(function(el) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        var text = [(el.innerText || ''), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
        return /下载|保存|download|save/i.test(text);
      });
      var button = buttons.sort(function(a, b) {
        var ar = a.getBoundingClientRect();
        var br = b.getBoundingClientRect();
        return br.top - ar.top || br.left - ar.left;
      })[0];
      if (!button) return null;
      var rect = button.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true).catch(() => null);
    if (!target) return false;
    const accountSession = session.fromPartition(`persist:doubao-native-${account.account_id}`);
    return new Promise((resolve, reject) => {
      let received = false;
      const timeout = setTimeout(() => {
        accountSession.removeListener("will-download", onDownload);
        if (received) reject(new Error("豆包下载超过 2 分钟仍未完成"));
        else resolve(false);
      }, 120_000);
      function onDownload(_event, item) {
        received = true;
        item.setSavePath(destinationPath);
        item.once("done", (_doneEvent, state) => {
          clearTimeout(timeout);
          if (state === "completed") resolve(true);
          else reject(new Error(`豆包下载未完成（${state}）`));
        });
      }
      accountSession.once("will-download", onDownload);
      void protocolClick(win.webContents, target).catch((error) => {
        clearTimeout(timeout);
        accountSession.removeListener("will-download", onDownload);
        reject(error);
      });
    });
  }

  function dispose() {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    for (const win of taskWindows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    windows.clear();
    taskWindows.clear();
  }

  /**
   * 调试端点：把所有任务窗口的实时页面状态导出为 JSON。
   * 只读，不点击、不发送、不影响进行中的任务。
   * 用于排查“任务一直生成中”这类无日志可看的问题。
   */
  async function debugTaskWindows() {
    const reports = [];
    for (const win of taskWindows) {
      const base = { title: win.getTitle(), bounds: win.getBounds() };
      if (win.isDestroyed()) {
        reports.push({ ...base, destroyed: true });
        continue;
      }
      const page = await win.webContents.executeJavaScript(`(() => {
        var videos = Array.from(document.querySelectorAll('video')).map(function (v) {
          return {
            src: String(v.currentSrc || v.src || ''),
            width: v.videoWidth, height: v.videoHeight,
            readyState: v.readyState, duration: v.duration,
          };
        });
        var composer = document.querySelector('#flow-end-msg-send');
        var composerInput = document.querySelector('[contenteditable="true"], textarea');
        var tail = (document.body.innerText || '').slice(-2500);
        var notices = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="alert"],[class*="toast"],[class*="Toast"],[class*="error"],[class*="warning"]'))
          .map(function (el) { return ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim().slice(0, 160); })
          .filter(function (t) { return t.length > 1; })
          .slice(0, 8);
        return {
          url: location.href,
          pageTitle: document.title,
          videos: videos,
          generating: /生成中|正在生成|排队中|预计等待|停止生成|取消生成/.test(tail),
          acknowledged: /我将为你生成视频|收到，正在|大约需要/.test(tail),
          completed: /视频生成好了|已生成/.test(tail),
          limit: /额度|次数已用完|今日.*用完/.test(tail),
          asksParams: /回复类似|请上传参考图/.test(tail),
          sendDisabled: composer ? Boolean(composer.disabled) : null,
          composerTextLength: composerInput ? (composerInput.innerText || composerInput.value || '').replace(/\\s+/g, '').length : 0,
          notices: notices,
          tail: tail,
        };
      })()`, true).catch((error) => ({ error: String((error && error.message) || error) }));
      const candidates = await collectArtifacts(win.webContents, "video").catch(() => []);
      reports.push({ ...base, page, rawVideoCandidates: candidates });
    }
    return { taskWindowCount: reports.length, windows: reports };
  }

  /**
   * 只读诊断：打开视频页并把“输入区/上传区”的真实 DOM 结构带回来。
   * 用于确认当前豆包 UI 里参考图入口是标签、按钮还是文件输入框。
   * 不写入提示词、不点击发送，因此不消耗额度。
   */
  async function debugVideoComposer(account) {
    const win = await createTaskWindow(account, VIDEO_PAGE);
    try {
      await waitForComposer(win.webContents);
      await wait(2500);
      return await win.webContents.executeJavaScript(`(() => {
        ${visibleElementScript()}
        function label(el) {
          return ((el.innerText || el.textContent || '') + '|' + (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('data-testid') || ''))
            .replace(/\\s+/g, ' ').trim().slice(0, 80);
        }
        var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
        var composer = composers.sort(function (a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0] || null;
        var composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight;
        // 输入区上方 320px 内的小控件：上传按钮、模式标签都在这一带
        var nearComposer = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],label,[data-testid]'))
          .filter(visible)
          .map(function (el) {
            var r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              testid: el.getAttribute('data-testid') || '',
              text: label(el),
              top: Math.round(r.top),
              left: Math.round(r.left),
              w: Math.round(r.width),
              h: Math.round(r.height),
              nearComposer: r.top > composerTop - 320 && r.top < composerTop + 120,
            };
          })
          .filter(function (item) { return item.nearComposer; })
          .slice(0, 24);
        var fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(function (el) {
          return {
            accept: el.getAttribute('accept') || '',
            multiple: el.multiple,
            visible: visible(el),
            id: el.id || '',
            testid: el.getAttribute('data-testid') || '',
          };
        });
        var composerArea = composer && composer.parentElement && composer.parentElement.parentElement
          ? composer.parentElement.parentElement.outerHTML.slice(0, 6000)
          : '';
        return {
          url: location.href,
          composerCount: composers.length,
          composerPlaceholder: composer ? (composer.getAttribute('placeholder') || '') : '',
          nearComposer: nearComposer,
          fileInputs: fileInputs,
          composerAreaHtml: composerArea,
        };
      })()`, true);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      taskWindows.delete(win);
    }
  }

  /**
   * 只读诊断（2026-09-18）：转储「首页 → 视频生成 chip」切出的**真实提交面**结构，
   * 用于回答「一个分镜能不能挂两张图 / 有没有首尾帧位」。
   *
   * 为什么不用 debugVideoComposer：那个打的是 `/chat/create-video` 落地页，
   * 而带参考图的真实提交面是首页 chip 切入的视频模式（落地页附件残缺，见
   * enterVideoModeFromHome 的说明），两者 DOM 不同，落地页的结论不能外推。
   *
   * 传 ?attach=<绝对路径> 可先挂一张图再转储，看豆包是否在挂图后补出第二个图片位
   * （首帧/尾帧/参考）。行为：只导航 + 挂图 + 读 DOM；不发送消息、不提交生成、不消耗额度。
   */
  async function debugVideoModeSurface(account, options = {}) {
    const attachPath = String(options.attachPath || "").trim();
    const win = await createTaskWindow(account, HOME_PAGE);
    let attach = null;
    try {
      await waitForComposer(win.webContents);
      const entered = await enterVideoModeFromHome(win.webContents);
      await wait(2500);
      if (attachPath) {
        try {
          attach = await uploadReferenceImages(win.webContents, [attachPath]);
          await wait(4000);
        } catch (error) {
          attach = { ok: false, error: String((error && error.message) || error) };
        }
      }
      const dump = await win.webContents.executeJavaScript(`(() => {
        ${visibleElementScript()}
        function label(el) {
          return ((el.innerText || el.textContent || '') + '|' + (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('data-testid') || '') + '|' + (el.getAttribute('placeholder') || ''))
            .replace(/\\s+/g, ' ').trim().slice(0, 90);
        }
        var composers = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
        var composer = composers.sort(function (a, b) { return b.getBoundingClientRect().top - a.getBoundingClientRect().top; })[0] || null;
        var composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight;
        var seen = {};
        var nearComposer = [];
        Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="option"],label,div,span'))
          .filter(visible)
          .forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.top <= composerTop - 460 || r.top >= composerTop + 180) return;
            var text = label(el);
            if (!text || text.length > 70) return;
            if (!/首帧|尾帧|首尾|参考|封面|上传|图片|照片|视频|时长|比例|模式|风格|生成|运镜|镜头/u.test(text)) return;
            var key = el.tagName + text;
            if (seen[key]) return;
            seen[key] = 1;
            nearComposer.push({ tag: el.tagName, text: text, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) });
          });
        var fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(function (el) {
          return { accept: el.getAttribute('accept') || '', multiple: el.multiple, visible: visible(el), testid: el.getAttribute('data-testid') || '' };
        });
        var images = Array.from(document.querySelectorAll('img')).filter(visible).map(function (img) {
          return { src: String(img.currentSrc || img.src || '').slice(0, 70), w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) };
        });
        // 整页 HTML（含隐藏节点）关键词扫描：网页端若存在「首尾帧」概念，
        // 其标签/tooltip/i18n key 通常会留在 DOM 里，即使当前未展开。
        var html = document.documentElement ? document.documentElement.outerHTML : '';
        var probes = ['首帧', '尾帧', '首尾', '参考图', 'last_frame', 'first_frame', 'reference_image', 'end_frame', 'start_frame'];
        var htmlHits = {};
        probes.forEach(function (kw) {
          var count = 0;
          var idx = html.indexOf(kw);
          while (idx >= 0 && count < 50) { count += 1; idx = html.indexOf(kw, idx + kw.length); }
          if (count) htmlHits[kw] = count;
        });
        return {
          url: location.href,
          composerCount: composers.length,
          composerPlaceholders: composers.map(function (c) { return c.getAttribute('placeholder') || ''; }),
          nearComposer: nearComposer.slice(0, 40),
          fileInputs: fileInputs,
          visibleImages: images.slice(0, 12),
          htmlLength: html.length,
          htmlHits: htmlHits,
          tailText: (document.body ? (document.body.innerText || '') : '').replace(/\\s+/g, ' ').slice(-2500),
        };
      })()`, true);
      return { enteredAt: entered && entered.ok ? "video-mode" : "failed", enteredError: (entered && entered.error) || "", attach: attach, dump: dump };
    } finally {
      if (!win.isDestroyed()) win.destroy();
      taskWindows.delete(win);
    }
  }

  /**
   * 只读诊断：把 N 张本地图片挂进豆包视频输入区，捕获**全部** prepare_upload /
   * CommitImageUpload 的请求体与响应体，用来确定「多张参考图」在豆包侧的真实回报结构
   * （一次一图还是合批、uri / 文件名 / 宽高分别挂在哪些字段上）。
   *
   * 2026-09-18：直连通道原先把参考图锁死成一张，靠的就是「只取第一个 uri + 单元素
   * attachments + 写死 reference-1.png / 2848×1600」。要放开成多图，必须先看清真实结构，
   * 否则多张图只能靠到达顺序猜配对。
   * 行为：导航 + 挂图 + 读网络；不发送消息、不提交生成、不消耗额度。
   */
  async function debugReferenceUpload(account, options = {}) {
    const paths = (Array.isArray(options.paths) ? options.paths : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!paths.length) {
      const error = new Error("需要 attach 参数指定至少一张本地图片（多张用 ; 分隔）");
      error.status = 400;
      error.code = "DEBUG_ATTACH_REQUIRED";
      throw error;
    }
    const win = await createTaskWindow(account, HOME_PAGE);
    const debuggerClient = win.webContents.debugger;
    const traffic = [];
    try {
      await waitForComposer(win.webContents);
      const entered = await enterVideoModeFromHome(win.webContents);
      await wait(2500);
      if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
      await debuggerClient.sendCommand("Network.enable").catch(() => undefined);
      const pending = new Map();
      const onMessage = async (_event, method, params) => {
        try {
          const url = String(
            (method === "Network.requestWillBeSent" ? params.request?.url : params.response?.url) || "",
          );
          if (!/CommitImageUpload|prepare_upload/iu.test(url)) return;
          if (method === "Network.requestWillBeSent") {
            pending.set(params.requestId, url);
            traffic.push({
              kind: "request",
              method: params.request?.method || "",
              url,
              postData: String(params.request?.postData || "").slice(0, 4000),
            });
            return;
          }
          if (method === "Network.loadingFinished") {
            const body = await debuggerClient
              .sendCommand("Network.getResponseBody", { requestId: params.requestId })
              .catch(() => null);
            if (!body) return;
            const text = body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : String(body.body || "");
            traffic.push({ kind: "response", url: pending.get(params.requestId) || url, body: text.slice(0, 6000) });
            pending.delete(params.requestId);
          }
        } catch { /* 监听器不能影响主流程 */ }
      };
      debuggerClient.on("message", onMessage);
      let attach = null;
      try {
        attach = await uploadReferenceImages(win.webContents, paths);
        await wait(6_000);
      } catch (error) {
        attach = { ok: false, error: String((error && error.message) || error) };
      } finally {
        debuggerClient.removeListener("message", onMessage);
      }
      const cardState = await readVideoCardState(win.webContents).catch(() => null);
      return {
        enteredAt: entered && entered.ok ? "video-mode" : "failed",
        enteredError: (entered && entered.error) || "",
        requestedPaths: paths,
        attach,
        trafficCount: traffic.length,
        traffic,
        cardState,
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
      taskWindows.delete(win);
    }
  }

  /**
   * 只读诊断：打开创作页模型选择器下拉，读取全部可选档位与角标（会员/限时等）。
   * 2026-09-16：用于解释账号 3 直连请求 seedance_v2.0_fast 被服务端静默降档 Mini——
   * 两个账号创作页选择器默认都显示 Mini，差异要看下拉里各档位的可用性/角标。
   * 行为：仅点开下拉菜单并读取，不选择、不提交、不消耗额度；窗口销毁后下拉自动关闭。
   */
  async function debugModelSelector(account) {
    const win = await createTaskWindow(account, VIDEO_PAGE);
    try {
      await waitForComposer(win.webContents);
      await wait(2000);
      const clickResult = await win.webContents.executeJavaScript(`(() => {
        ${visibleElementScript()}
        function txt(el) { return ((el.innerText || '') + '|' + (el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim().slice(0, 60); }
        var candidates = Array.from(document.querySelectorAll('button,[role="button"],div,span'))
          .filter(visible)
          .filter(function (el) { return /Seedance/i.test(el.innerText || ''); });
        var selector = candidates.sort(function (a, b) {
          return a.getBoundingClientRect().width * a.getBoundingClientRect().height
            - b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        })[0] || null;
        var clicked = false;
        if (selector) {
          try {
            selector.scrollIntoView({ block: 'center' });
            var r = selector.getBoundingClientRect();
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
              selector.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              }));
            });
            clicked = true;
          } catch (e) { clicked = 'error:' + e.message; }
        }
        return { clicked: clicked, selectorText: selector ? txt(selector) : '' };
      })()`, true);
      await wait(2000);
      const menu = await win.webContents.executeJavaScript(`(() => {
        ${visibleElementScript()}
        var seen = {};
        var items = Array.from(document.querySelectorAll('button,[role="button"],[role="option"],[role="menuitem"],div,span'))
          .filter(visible)
          .map(function (el) {
            var text = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
            return { tag: el.tagName, text: text.slice(0, 100) };
          })
          .filter(function (item) {
            if (!item.text || item.text.length > 80) return false;
            if (!/Seedance|Fast|Mini|会员|VIP|开通|即将|限时|升级/i.test(item.text)) return false;
            if (seen[item.text]) return false;
            seen[item.text] = true;
            return true;
          })
          .slice(0, 30);
        var body = (document.body.innerText || '').replace(/\\s+/g, ' ');
        var fastContexts = [];
        var re = /[^ ]{0,30}Fast[^ ]{0,30}/gi, m;
        while ((m = re.exec(body)) && fastContexts.length < 6) fastContexts.push(m[0]);
        return { items: items, fastContexts: fastContexts };
      })()`, true);
      return { url: win.webContents.getURL(), clickResult: clickResult, menu: menu };
    } finally {
      if (!win.isDestroyed()) win.destroy();
      taskWindows.delete(win);
    }
  }

  /**
   * 只读诊断：打开指定会话页并回读文本尾部（宣布句/参数卡片/确认按钮状态）。
   * 2026-09-16：语义守卫拦下降档后，需要零成本复查会话里豆包实际渲染了什么
   * （是否有参数卡片、宣布句上下文、素材授权状态），用于定位降档原因。
   */
  async function debugConversationPage(account, conversationId) {
    const convId = String(conversationId || "").trim();
    if (!convId) throw new Error("conversation_id is required");
    const win = await createTaskWindow(account, `https://www.doubao.com/chat/${convId}`);
    try {
      await wait(5000);
      return await win.webContents.executeJavaScript(`(() => {
        var text = (document.body.innerText || '').replace(/[ \\t]+/g, ' ').trim();
        var markers = ['确认生成', '本次使用', '生成中', '视频生成好了', '已生成完毕', '生成失败', 'Seedance'];
        var found = {};
        markers.forEach(function (mk) {
          var idx = text.lastIndexOf(mk);
          if (idx >= 0) found[mk] = text.slice(Math.max(0, idx - 100), idx + 160).trim();
        });
        return { url: location.href, textLength: text.length, markers: found, tail: text.slice(-3500) };
      })()`, true);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      taskWindows.delete(win);
    }
  }

  /**
   * 只读诊断：列出“我的创作”里最近的作品（名称/类型/时间）。
   * 用来判断豆包侧到底有没有真的产出视频——不依赖任务窗口当前显示的页面。
   */
  async function debugLibrary(account) {
    try {
      const { creationNodeId, rows } = await libraryRows(account);
      return { creationNodeId, count: rows.length, rows: rows.slice(0, 40) };
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  }

  /**
   * 恢复动作：把豆包提交后弹出的「素材授权确认」（“确认生成”按钮）点掉。
   * 背景：新账号首次视频生成时，豆包会在会话里回一条素材授权确认
   * （“上传、使用的素材，均已获充分授权…”+「确认生成」按钮），无人点击
   * 就不会开始生成，任务会空转到 GENERATION_TIMEOUT（2026-09-16 账号 3 实证）。
   * 与提交前的 confirmMaterialSafetyDialog（遮罩弹窗）不同，这是提交后出现在
   * 会话消息里的确认按钮。
   * 行为：优先复用现有任务窗口（URL 含 conversationId，或与 account 同分区）；
   * 没有（Provider 重启后窗口已销毁）就用 account 新开任务窗口并导航到会话——
   * 会话状态在服务端，未确认的授权提示会随会话历史重新出现。提交链路的
   * 自动处理见 generateVideoDirect 内的 clickGenerationConfirmButton 调用。
   */
  async function debugClickGenerationConfirm(account, conversationId) {
    const convId = String(conversationId || "").trim();
    const targetUrl = convId ? `https://www.doubao.com/chat/${convId}` : "";
    const alive = Array.from(taskWindows).filter((candidate) => !candidate.isDestroyed());
    let win = null;
    if (convId) {
      win = alive.find((candidate) => String(candidate.webContents.getURL() || "").includes(convId)) || null;
    }
    if (!win && account) {
      win = alive.find((candidate) => {
        try {
          return candidate.webContents.session === session.fromPartition(`persist:doubao-native-${account.account_id}`);
        } catch {
          return false;
        }
      }) || null;
    }
    let created = false;
    if (win) {
      if (targetUrl && !String(win.webContents.getURL() || "").includes(convId)) {
        await win.loadURL(targetUrl).catch(() => undefined);
        await wait(5_000);
      }
    } else {
      if (!account) {
        return {
          ok: false,
          reason: "NO_WINDOW_AND_NO_ACCOUNT",
          hint: "任务窗口不存在（Provider 可能已重启），请求需要 account_id，必要时配合 conversation_id",
        };
      }
      win = await createTaskWindow(account, targetUrl || HOME_PAGE);
      created = true;
      await wait(5_000); // 等会话历史渲染完成
    }
    const outcome = await clickGenerationConfirmButton(win.webContents, 25_000);
    onEvent("generation_confirm_clicked", {
      accountId: account?.account_id || "",
      conversationId: convId,
      createdWindow: created,
      stage: "recovery",
      clicked: outcome.clicked,
      text: outcome.text || "",
      after: outcome.after || null,
    });
    return {
      ok: true,
      createdWindow: created,
      url: win.isDestroyed() ? "" : win.webContents.getURL(),
      clicked: outcome.clicked,
      text: outcome.text || "",
      after: outcome.after || null,
    };
  }

  return { check, debugTaskWindows, debugVideoComposer, debugVideoModeSurface, debugReferenceUpload, debugModelSelector, debugConversationPage, debugLibrary, debugClickGenerationConfirm, dispose, downloadLatestArtifact, fetchArtifact, fetchLibraryVideo, generate, login };
}

module.exports = {
  IMAGE_PAGE,
  VIDEO_PAGE,
  UserActionRequiredError,
  ABILITY_VIDEO_MODELS,
  configureImageGenerationOptions,
  confirmSubmissionAccepted,
  // 导出确认卡片相关实现，供 test/doubao-adapter.test.cjs 用假 webContents 验证：
  // 「卡片回复走直连、且直连成功时完全不碰 UI」是 2026-09-16 用户明确要求的回归点。
  confirmVideoParameterCard,
  replyDirectText,
  createDoubaoAdapter,
  inspectSession,
  isTrustedNavigation,
  hasAttachedReference,
  resolveAbilityVideoModel,
  uploadReferenceImages,
  validateVideoRequest,
  // 2026-09-18 多参考图相关纯函数，供 test/reference-images.test.cjs 单测：
  // 「多张图不被静默丢弃」「image_ori 用真实尺寸而不是写死 2848×1600」是本轮回归点。
  parseImageBufferInfo,
  pairCapturedUris,
  extractUrisFromCommitRequest,
  describeReferenceImages,
  resolveCameraMovement,
  MAX_REFERENCE_IMAGES,
};
