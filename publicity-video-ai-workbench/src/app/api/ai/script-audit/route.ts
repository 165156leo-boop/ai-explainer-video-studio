import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { isRecord } from "../../../data-shape.ts";
import { parseAiJsonObject } from "../../../extraction-review";
import {
  SCRIPT_AUDIT_SYSTEM,
  normalizeScriptAudit,
  scriptAuditPayload,
} from "../../../script-audit";
import type { ExtractedCase, ScriptParagraph } from "../../../workbench-data";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const config = await readAiConfiguration("text", ownerEmail);
    if (!config.apiKey) {
      return NextResponse.json(
        {
          code: "AI_NOT_CONFIGURED",
          error: "尚未连接文本模型，脚本内容审核已跳过。",
          model: config.model,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      projectTitle?: unknown;
      paragraphs?: unknown;
      cases?: unknown;
    };
    if (!Array.isArray(body.paragraphs) || !Array.isArray(body.cases)) {
      throw new Error("缺少脚本段落或最小案例");
    }
    if (body.paragraphs.length === 0 || body.paragraphs.length > 500) {
      throw new Error("Word 段落数量超出本次内容审核范围");
    }
    const paragraphs = body.paragraphs as ScriptParagraph[];
    const paragraphIds = new Set<number>();
    for (const paragraph of paragraphs) {
      if (
        !isRecord(paragraph) ||
        !Number.isInteger(paragraph.id) ||
        paragraphIds.has(paragraph.id) ||
        typeof paragraph.kind !== "string" ||
        typeof paragraph.text !== "string"
      ) {
        throw new Error("Word 段落数据无效");
      }
      paragraphIds.add(paragraph.id);
    }
    const cases = body.cases as ExtractedCase[];

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: 6000,
        messages: [
          { role: "system", content: SCRIPT_AUDIT_SYSTEM },
          {
            role: "user",
            content: JSON.stringify(
              scriptAuditPayload({
                projectTitle: body.projectTitle,
                paragraphs,
                cases,
              }),
            ),
          },
        ],
      }),
      // 90 秒：实测同一份脚本、同一个 flash 模型，耗时在 28 秒到超过 60 秒之间波动
      // （审核要通读全文并逐段比对，是这条链路上最慢的一次模型调用）。
      // 60 秒会把正常完成的那次也判成超时——端到端验证时正好撞上一次。
      signal: AbortSignal.timeout(90_000),
    });

    const data = (await upstream.json()) as {
      error?: { message?: string } | string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!upstream.ok) {
      const mapped = mapAiUpstreamError(upstream.status, data, {
        authCode: "AI_AUTH_FAILED",
        upstreamCode: "AI_UPSTREAM_FAILED",
        authStatuses: [401, 403],
        rateLimitCode: "AI_RATE_LIMITED",
        fallbackMessage: (status) => `模型请求失败（${status}）`,
      });
      const { status, ...body } = mapped;
      return NextResponse.json({ ...body, model: config.model }, { status });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回脚本审核结果");

    const result = normalizeScriptAudit(
      parseAiJsonObject(content),
      paragraphs,
      cases,
    );
    return NextResponse.json({ ...result, model: config.model });
  } catch (error) {
    const message = error instanceof Error ? error.message : "脚本内容审核失败";
    const timedOut = /abort|timeout/i.test(message);
    return NextResponse.json(
      {
        code: timedOut ? "AI_TIMEOUT" : "AI_AUDIT_FAILED",
        error: timedOut ? "脚本内容审核超时，可先进入工作台。" : message,
      },
      { status: timedOut ? 504 : 400 },
    );
  }
}
