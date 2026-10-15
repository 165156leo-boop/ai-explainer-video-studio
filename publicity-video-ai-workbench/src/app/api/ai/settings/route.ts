import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import {
  normalizeAiEndpoint,
  readAiConfiguration,
  saveAiConfiguration,
  validateAiConnection,
} from "../../../ai-configuration";

export const runtime = "nodejs";

function configurationKind(value: unknown) {
  return value === "vision" ? "vision" : "text";
}

export async function GET(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  const kind = configurationKind(new URL(request.url).searchParams.get("kind"));
  const config = await readAiConfiguration(kind, ownerEmail);
  return NextResponse.json({
    kind,
    configured: Boolean(config.apiKey),
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
  });
}

export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      provider?: unknown;
      endpoint?: unknown;
      model?: unknown;
      apiKey?: unknown;
      kind?: unknown;
    };
    const kind = configurationKind(body.kind);
    const current = await readAiConfiguration(kind, ownerEmail);
    const provider =
      typeof body.provider === "string" && body.provider.trim()
        ? body.provider.trim()
        : "custom";
    const endpoint = normalizeAiEndpoint(
      typeof body.endpoint === "string" ? body.endpoint : "",
    );
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const suppliedKey =
      typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const connectionChanged =
      provider !== current.provider ||
      endpoint !== normalizeAiEndpoint(current.endpoint);
    const apiKey = suppliedKey || (connectionChanged ? "" : current.apiKey);

    if (!model) {
      return NextResponse.json(
        { code: "MODEL_REQUIRED", error: "请填写模型名称。" },
        { status: 400 },
      );
    }
    if (!apiKey) {
      return NextResponse.json(
        {
          code: "KEY_REQUIRED",
          error: connectionChanged
            ? "切换服务商或服务地址时，请填写新服务对应的 API Key。"
            : "请粘贴这个模型服务的 API Key。",
        },
        { status: 400 },
      );
    }
    if (/\s/u.test(apiKey) || apiKey.length > 512) {
      return NextResponse.json(
        {
          code: "KEY_FORMAT_INVALID",
          error: "Key 格式不正确，请重新复制完整 Key，不要夹带空格或换行。",
        },
        { status: 400 },
      );
    }

    const next = { provider, endpoint, model, apiKey };
    const validation = await validateAiConnection(next);
    if (!validation.ok) {
      const authFailed = validation.status === 401 || validation.status === 403;
      return NextResponse.json(
        {
          code: authFailed ? "KEY_INVALID" : "AI_SERVICE_UNAVAILABLE",
          error: authFailed
            ? "Key 无效或无权使用当前模型，请核对 Key 和模型名称。"
            : validation.upstreamMessage ||
              "暂时无法连接这个模型服务，请检查服务地址、模型名称和网络。原来的连接没有被替换。",
        },
        { status: authFailed ? 401 : 502 },
      );
    }

    await saveAiConfiguration(next, kind, ownerEmail);
    return NextResponse.json({
      kind,
      configured: true,
      provider,
      endpoint,
      model,
      message: "模型连接已保存",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name);
    return NextResponse.json(
      {
        code: timedOut ? "AI_CONNECTION_TIMEOUT" : "SETTINGS_FAILED",
        error: timedOut
          ? "连接模型服务超时，请检查网络后重试。原来的连接没有被替换。"
          : error instanceof Error
            ? error.message
            : "模型连接保存失败，请稍后重试。原来的连接没有被替换。",
      },
      { status: timedOut ? 504 : 400 },
    );
  }
}
