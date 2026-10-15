import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { parseJsonObject } from "../../../data-shape.ts";
import type { StageKey } from "../../../workbench-data";
import { normalizeAiRuleCandidate } from "../../../workspace-memory";

export const runtime = "nodejs";


export async function GET(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  const config = await readAiConfiguration("text", ownerEmail);
  return NextResponse.json({
    configured: Boolean(config.apiKey),
    provider: config.provider,
    model: config.model,
  });
}

export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const config = await readAiConfiguration("text", ownerEmail);
    if (!config.apiKey) {
      return NextResponse.json(
        {
          code: "AI_NOT_CONFIGURED",
          error: "尚未连接文本模型，可先保存反馈并手动建立规则。",
          model: config.model,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      projectTitle?: unknown;
      stage?: unknown;
      issueType?: unknown;
      targetId?: unknown;
      reason?: unknown;
      before?: unknown;
      after?: unknown;
      decision?: unknown;
    };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new Error("请先填写反馈原因");
    const fallbackStage = (typeof body.stage === "string"
      ? body.stage
      : "imagePrompt") as StageKey;
    const fallbackIssueType =
      typeof body.issueType === "string" ? body.issueType : "其他";

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是审计科普视频工作台的规则整理助手。把一次人工反馈压缩成可审核、可复用、可撤销的项目规则候选。不要虚构事实，不要自动扩大适用范围。只返回 JSON 对象，字段为 title、instruction、stage、issueType、scope、keywords、reason。stage 只能是 script、cases、scriptReview、storyboard、imagePrompt、reference、videoPrompt；scope 必须为 project；keywords 为 2 到 6 个短词。全局规则只能由用户稍后在规则库中人工晋级。",
          },
          {
            role: "user",
            content: JSON.stringify({
              projectTitle: body.projectTitle,
              stage: body.stage,
              issueType: body.issueType,
              targetId: body.targetId,
              reason,
              before: body.before,
              after: body.after,
              decision: body.decision,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const data = (await upstream.json()) as {
      error?: { message?: string } | string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!upstream.ok) {
      const mapped = mapAiUpstreamError(upstream.status, data, {
        authCode: "AI_AUTH_FAILED",
        upstreamCode: "AI_UPSTREAM_FAILED",
        fallbackMessage: (status) => `模型请求失败（${status}）`,
      });
      const { status, ...body } = mapped;
      return NextResponse.json({ ...body, model: config.model }, { status });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回规则候选");
    const candidate = normalizeAiRuleCandidate(
      parseJsonObject(content, "模型没有返回有效的规则候选"),
      fallbackStage,
      fallbackIssueType,
    );
    return NextResponse.json({ candidate, model: config.model });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "规则整理失败" },
      { status: 400 },
    );
  }
}
