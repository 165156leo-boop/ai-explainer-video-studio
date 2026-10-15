import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../../auth";
import { readAiConfiguration } from "../../../ai-configuration";
import { mapAiUpstreamError } from "../../../ai-upstream-error";
import { parseAiJsonObject } from "../../../extraction-review";
import { shotRevisionDialoguePreserved } from "../../../shot-planning";

export const runtime = "nodejs";

const SYSTEM_PROMPT =
  "你是高校审计科普视频的分镜策划。用户对当前镜头的分镜拆分结果提出了具体反馈（例如画面里少了一个在场人物、场景描述不完整、动作不符合案例事实），请结合反馈和同案例相邻镜头的上下文，重写这个镜头的画面字段。" +
  "重写要求：" +
  "① speaker 写明本镜画面中的出场人物与开口顺序（用「 → 」分隔），画面里应包含场景内所有在场人物，哪怕某人本镜不开口——反馈指出人物缺失时必须补全；" +
  "② location 写具体的地点与环境细节（在什么房间/场景、有哪些关键陈设或凭证）；" +
  "③ dialogue 保持原文对白不变：所有中文引号内的台词逐字保留，一字不改、一字不增删、不调整顺序；引号外的说明文字可以按新画面改写；无对白的镜头不得新增引号台词；" +
  "④ action 是 1—7 条按时间顺序的画面动作，每条具体到人物和身体部位，可执行、可画；" +
  "⑤ continuity 保持与相邻镜头的衔接说明（人物站位、视线、手势、道具位置），不得凭空更换场景设定；" +
  "⑥ 不得出现「用户反馈」「您提到」「按要求」「原分镜」「修订」等内部过程文字，字段里只写画面事实本身；" +
  "⑦ 不虚构输入案例事实之外的人物、道具和事件。" +
  '只返回 JSON：{"speaker":"…","location":"…","dialogue":"…","action":["…"],"continuity":"…","note":"一句话说明你改了什么"}，note 可省略。';

type ShotReviseInput = {
  id: string;
  speaker: string;
  location: string;
  dialogue: string;
  action: string[];
  continuity: string;
};

const asText = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(request: Request) {
  const ownerEmail = await getAuthenticatedEmail(request);
  if (!ownerEmail) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const config = await readAiConfiguration("text", ownerEmail);
    if (!config.apiKey) {
      return NextResponse.json(
        {
          code: "AI_NOT_CONFIGURED",
          error: "尚未连接文本模型，无法按反馈修改分镜。",
          model: config.model,
        },
        { status: 503 },
      );
    }
    const body = (await request.json()) as {
      feedback?: unknown;
      shot?: unknown;
      caseContext?: unknown;
      projectTitle?: unknown;
    };
    const feedback = asText(body.feedback, 500);
    if (!feedback) throw new Error("请先填写要让 AI 修改的内容");
    const rawShot = (typeof body.shot === "object" && body.shot !== null
      ? body.shot
      : {}) as Record<string, unknown>;
    const shot: ShotReviseInput = {
      id: asText(rawShot.id, 60),
      speaker: asText(rawShot.speaker, 200),
      location: asText(rawShot.location, 300),
      dialogue: asText(rawShot.dialogue, 2_000),
      action: Array.isArray(rawShot.action)
        ? rawShot.action
            .map((item) => asText(item, 200))
            .filter(Boolean)
            .slice(0, 7)
        : [],
      continuity: asText(rawShot.continuity, 500),
    };
    if (!shot.id || !shot.dialogue) {
      throw new Error("缺少当前分镜的基本信息");
    }
    const caseContext = asText(body.caseContext, 2_000);
    const projectTitle = asText(body.projectTitle, 200);

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 1_600,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              projectTitle,
              caseContext,
              feedback,
              shot: {
                id: shot.id,
                speaker: shot.speaker,
                location: shot.location,
                dialogue: shot.dialogue,
                actions: shot.action,
                continuity: shot.continuity,
              },
            }),
          },
        ],
      }),
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
        fallbackMessage: (status) => `模型请求失败（${status}）`,
      });
      const { status, ...body } = mapped;
      return NextResponse.json({ ...body, model: config.model }, { status });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回修订结果");

    const parsed = parseAiJsonObject(content) as Record<string, unknown>;
    const speaker = asText(parsed.speaker, 200);
    const location = asText(parsed.location, 300);
    const dialogue = asText(parsed.dialogue, 2_000);
    const action = Array.isArray(parsed.action)
      ? parsed.action.map((item) => asText(item, 200)).filter(Boolean).slice(0, 7)
      : [];
    const continuity = asText(parsed.continuity, 500);
    if (!speaker || !location || !dialogue || !continuity || !action.length) {
      throw new Error("模型返回的修订结果字段不完整，请重试或改用手动编辑");
    }
    // 台词保护：引号内的对白逐字一致才放行；无对白镜不得新增台词。
    if (!shotRevisionDialoguePreserved(shot.dialogue, dialogue)) {
      throw new Error("模型改动了对白原文，已拒收；台词只能手动微调");
    }
    return NextResponse.json({
      revision: { speaker, location, dialogue, action, continuity },
      note: asText(parsed.note, 200),
      model: config.model,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "按反馈修改分镜失败" },
      { status: 400 },
    );
  }
}
