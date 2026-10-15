import { NextResponse } from "next/server";
import {
  authenticate,
  AUTH_COOKIE,
  getAuthenticatedEmail,
  isSameOrigin,
  sessionCookieOptions,
} from "../../auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "认证失败" },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  const email = await getAuthenticatedEmail(request);
  return NextResponse.json({ authenticated: Boolean(email), user: email ? { email } : null });
}

export async function POST(request: Request) {
  try {
    if (!isSameOrigin(request)) return NextResponse.json({ error: "跨站请求被拒绝" }, { status: 403 });
    const body = (await request.json()) as Record<string, unknown>;
    const mode = body.mode === "register" ? "register" : "login";
    const result = await authenticate(mode, body.email, body.password);
    const response = NextResponse.json({ user: { email: result.email }, mode });
    response.cookies.set(AUTH_COOKIE, result.token, {
      ...sessionCookieOptions,
      secure: new URL(request.url).protocol === "https:",
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "跨站请求被拒绝" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, "", {
    ...sessionCookieOptions,
    secure: new URL(request.url).protocol === "https:",
    maxAge: 0,
  });
  return response;
}
