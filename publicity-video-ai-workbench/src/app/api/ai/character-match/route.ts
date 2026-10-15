import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { isSupportedImageDataUrl } from "../../../data-shape.ts";
import { parseAiJsonObject } from "../../../extraction-review";
import {
  normalizeCharacterIdentityResult,
  type CharacterIdentityReference,
} from "../../../character-identity";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const config = await readAiConfiguration("vision", ownerEmail);
    if (!config.apiKey) {
      return NextResponse.json(
        { code: "VISION_AI_NOT_CONFIGURED", error: "尚未连接视觉模型。", model: config.model },
        { status: 503 },
      );
    }
    const body = (await request.json()) as {
      sceneImageDataUrl?: unknown;
      references?: unknown;
      shotContext?: unknown;
    };
    const sceneImageDataUrl = typeof body.sceneImageDataUrl === "string"
      ? body.sceneImageDataUrl.trim()
      : "";
    if (!isSupportedImageDataUrl(sceneImageDataUrl)) throw new Error("当前场景图格式无效");
    if (sceneImageDataUrl.length > 28_000_000) throw new Error("当前场景图过大，无法进行角色匹配");
    const references: CharacterIdentityReference[] = Array.isArray(body.references)
      ? body.references.slice(0, 8).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const roleName = typeof value.roleName === "string" ? value.roleName.trim().slice(0, 80) : "";
          const characterName = typeof value.characterName === "string" ? value.characterName.trim().slice(0, 80) : "";
          const imageDataUrl = typeof value.imageDataUrl === "string" ? value.imageDataUrl.trim() : "";
          return roleName && characterName && isSupportedImageDataUrl(imageDataUrl) && imageDataUrl.length <= 28_000_000
            ? [{ roleName, characterName, imageDataUrl }]
            : [];
        })
      : [];
    if (!references.length) return NextResponse.json({ matches: [], model: config.model });
    if (references.reduce((total, item) => total + item.imageDataUrl.length, sceneImageDataUrl.length) > 56_000_000) {
      throw new Error("角色参考图总大小过大，无法进行角色匹配");
    }

    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text:
          "你是角色身份匹配助手。第1组图片是官方角色参考图，后面标注为‘当前场景图’的图片是待分析场景。" +
          "请只依据可见的人脸、发型、眼镜、服装、体态和动作，把每张官方参考图匹配到当前场景中的具体人物。" +
          "不要只用左边或右边判断；站着/坐着、所在位置、手部动作可以作为场景定位证据。" +
          "如果遮挡、角度或画风导致不能稳定判断，必须返回UNCERTAIN，不要猜。" +
          "只返回JSON：{matches:[{roleName,matchedPerson,status,confidence,evidence,sceneCue,promptClause}]}。" +
          "status只能是MATCH、UNCERTAIN、NO_MATCH；confidence为0到1；matchedPerson使用person_1、person_2等。" +
          `场景上下文：${typeof body.shotContext === "string" ? body.shotContext.trim().slice(0, 4000) : ""}`,
      },
    ];
    for (const reference of references) {
      content.push({ type: "text", text: `官方角色参考图：${reference.roleName}；剧本角色名：${reference.characterName}` });
      content.push({ type: "image_url", image_url: { url: reference.imageDataUrl } });
    }
    content.push({ type: "text", text: "当前场景图：请在这张图中匹配上面的官方角色。" });
    content.push({ type: "image_url", image_url: { url: sceneImageDataUrl } });

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: 1800,
        messages: [
          { role: "system", content: "只输出JSON，不要解释。" },
          { role: "user", content },
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
    const contentText = data.choices?.[0]?.message?.content;
    if (!contentText) throw new Error("视觉模型没有返回角色匹配结果");
    return NextResponse.json({
      ...normalizeCharacterIdentityResult(parseAiJsonObject(contentText), references),
      model: config.model,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    return NextResponse.json(
      { code: timedOut ? "CHARACTER_MATCH_TIMEOUT" : "CHARACTER_MATCH_FAILED", error: error instanceof Error ? error.message : "角色匹配失败" },
      { status: timedOut ? 504 : 400 },
    );
  }
}
