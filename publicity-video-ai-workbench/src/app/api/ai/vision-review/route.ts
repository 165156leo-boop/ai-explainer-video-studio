import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { isSupportedImageDataUrl, parseJsonObject } from "../../../data-shape.ts";
import { normalizeVisionReview } from "../../../media-workflow";

export const runtime = "nodejs";


export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const config = await readAiConfiguration("vision", ownerEmail);
    if (!config.apiKey) {
      return NextResponse.json(
        {
          code: "VISION_AI_NOT_CONFIGURED",
          error: "尚未连接视觉模型，仍可继续人工选图。",
          model: config.model,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      imageDataUrl?: unknown;
      prompt?: unknown;
      shotContext?: unknown;
      fixedCharacterRules?: unknown;
    };
    const imageDataUrl =
      typeof body.imageDataUrl === "string" ? body.imageDataUrl.trim() : "";
    if (!isSupportedImageDataUrl(imageDataUrl)) {
      throw new Error("候选图片格式无效，只支持 PNG、JPG 或 WebP");
    }
    if (imageDataUrl.length > 28_000_000) throw new Error("候选图片过大，无法进行视觉审核");
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 8000) : "";
    if (!prompt) throw new Error("缺少当前画面提示词");

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          {
            role: "system",
            content:
              "你是高校审计科普视频的候选图审核助手。只判断图片是否满足输入要求，不改写事实，不替用户做最终采用决定。检查人物身份与数量、服装和固定特征、场景、关键道具、设备正反面、构图与16:9比例、扁平线条画风、无关文字和连续性。只返回JSON对象：{status,issueTags,evidence,retrySuggestion}。status只能是PASS、REVISE、BLOCKED；evidence必须指出可见依据；不确定时用BLOCKED。",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  prompt,
                  shotContext:
                    typeof body.shotContext === "string"
                      ? body.shotContext.trim().slice(0, 6000)
                      : "",
                  fixedCharacterRules:
                    typeof body.fixedCharacterRules === "string"
                      ? body.fixedCharacterRules.trim().slice(0, 3000)
                      : "",
                }),
              },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await upstream.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!upstream.ok) {
      const mapped = mapAiUpstreamError(upstream.status, data, {
        authCode: "VISION_AI_AUTH_FAILED",
        upstreamCode: "VISION_AI_UPSTREAM_FAILED",
        fallbackMessage: (status) => `视觉模型请求失败（${status}）`,
      });
      const { status, ...body } = mapped;
      return NextResponse.json({ ...body, model: config.model }, { status });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("视觉模型没有返回审核结果");
    return NextResponse.json(
      normalizeVisionReview({
        ...(parseJsonObject(content, "视觉模型没有返回有效 JSON") as object),
        model: config.model,
        createdAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    const timedOut =
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    return NextResponse.json(
      {
        code: timedOut ? "VISION_AI_TIMEOUT" : "VISION_REVIEW_FAILED",
        error: timedOut
          ? "视觉审核超时，仍可继续人工选图。"
          : error instanceof Error
            ? error.message
            : "视觉审核失败",
      },
      { status: timedOut ? 504 : 400 },
    );
  }
}
