import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { isRecord } from "../../../data-shape.ts";
import {
  normalizeExtractionReview,
  parseAiJsonObject,
} from "../../../extraction-review";
import type {
  ExtractedCase,
  ScriptParagraph,
} from "../../../workbench-data";

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
          error: "尚未连接文本模型，请先在设置中完成连接。",
          model: config.model,
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      projectTitle?: unknown;
      paragraphs?: unknown;
      cases?: unknown;
      rules?: unknown;
    };
    if (!Array.isArray(body.paragraphs) || !Array.isArray(body.cases)) {
      throw new Error("缺少规则提取结果");
    }
    if (body.paragraphs.length === 0 || body.paragraphs.length > 500) {
      throw new Error("Word 段落数量超出本次结构复核范围");
    }
    const paragraphs = body.paragraphs as ScriptParagraph[];
    const cases = body.cases as ExtractedCase[];
    const paragraphIds = new Set<number>();
    for (const paragraph of paragraphs) {
      if (
        !isRecord(paragraph) ||
        !Number.isInteger(paragraph.id) ||
        paragraphIds.has(paragraph.id) ||
        typeof paragraph.text !== "string"
      ) {
        throw new Error("Word 段落数据无效");
      }
      paragraphIds.add(paragraph.id);
    }
    const activeRules = Array.isArray(body.rules)
      ? body.rules
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 8)
      : [];

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
          {
            role: "system",
            content:
              "你是高校审计科普视频工作台的脚本结构复核助手。程序已经做了第一轮规则提取，你只复核最小案例边界、标题/场景上下文和人物对白归属，不改写原文。文本可能没有固定的‘示例一/二’标题，请按同一业务事件、时间地点和人物关系识别最小案例。需要由 AI 生成的场景、人物动作、道具变化、镜头动作和视觉特效应纳入 sourceIds；标题卡、音效、字幕、屏幕文字、弹出提示框及其文案、审计提醒、制度总结、固定结尾属于后期制作内容，不纳入人物案例。旁白、动作和场景只能作为 context，不列为 dialogues。每个 sourceId 必须来自输入段落；同一人物对白段落只能属于一个案例。一个段落中有多个带引号的说话人时，必须拆成多个 dialogue，并按出现顺序返回 segment=1、2……。案例的 sourceIds 必须包含能解释该案例的标题、场景设定、动作和视觉特效段落，不能只返回对白段落。无法确定时写入 issues，不要猜。只返回 JSON 对象：{summary, issues:[{message,sourceId,caseId,reason,question,action}], cases:[{id,group,title,sourceIds,dialogues:[{sourceId,segment,speaker}],reason}]}。案例 ID 必须从 S1-E1 开始，按主题和案例顺序连续编号。",
          },
          {
            role: "user",
            content: JSON.stringify({
              projectTitle:
                typeof body.projectTitle === "string"
                  ? body.projectTitle.trim().slice(0, 160)
                  : "",
              paragraphs: paragraphs.map(({ id, kind, text }) => ({
                id,
                kind,
                text: text.slice(0, 1600),
              })),
              ruleDraft: cases.map((item) => ({
                id: item.id,
                group: item.group,
                title: item.title,
                sourceIds: item.sourceIds,
                dialogues: (item.items ?? [])
                  .filter((row) => row.type === "dialogue")
                  .map((row) => ({
                    sourceId: row.sourceId,
                    segment: row.sourceSegment,
                    speaker: row.speaker,
                  })),
              })),
              reviewedRules: activeRules,
            }),
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
    if (!content) throw new Error("模型没有返回结构复核结果");
    return NextResponse.json({
      ...normalizeExtractionReview(
        parseAiJsonObject(content),
        paragraphs,
        cases,
      ),
      model: config.model,
      rulesUsed: activeRules.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "结构复核失败" },
      { status: 400 },
    );
  }
}
