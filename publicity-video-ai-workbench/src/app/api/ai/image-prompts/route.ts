import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { AiInputRejected, AiOutputRejected } from "../../../ai-output-rejection";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { parseAiJsonObject } from "../../../extraction-review";
import {
  normalizeImagePromptBriefs,
  normalizeImagePromptModelResult,
} from "../../../image-prompt";
import {
  IMAGE_PROMPT_SYSTEM,
  imagePromptModelPayload,
} from "../../../image-prompt-request";

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
          error: "尚未连接文本模型，已保留干净的模板画面词。",
          model: config.model,
        },
        { status: 503 },
      );
    }
    const body = (await request.json()) as {
      projectTitle?: unknown;
      shots?: unknown;
    };
    const briefs = normalizeImagePromptBriefs(body.shots);
    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: Math.min(6_000, 800 + briefs.length * 650),
        messages: [
          { role: "system", content: IMAGE_PROMPT_SYSTEM },
          {
            role: "user",
            content: JSON.stringify(
              imagePromptModelPayload({
                projectTitle: body.projectTitle,
                briefs,
              }),
            ),
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
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
    if (!content) throw new Error("模型没有返回画面词");
    return NextResponse.json({
      prompts: normalizeImagePromptModelResult(parseAiJsonObject(content), briefs),
      model: config.model,
    });
  } catch (error) {
    if (error instanceof AiOutputRejected || error instanceof AiInputRejected) {
      // 确定性拒收，标 code 让前端不要盲目重试：
      //  - AiOutputRejected（422）：模型违反画面词硬规则；
      //  - AiInputRejected（400）：本镜素材缺场景或动作，重发必然同样失败。
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error instanceof AiInputRejected ? 400 : 422 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "画面词润色失败" },
      { status: 400 },
    );
  }
}
