import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAuthenticatedEmail } from "../../auth";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const EXTRACTOR_PATH = process.env.AUDIT_VIDEO_EXTRACTOR ??
  path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    "..",
    "AI视频agent",
    "scripts",
    "extract_story_sections.py",
  );

type ParagraphKind =
  | "meta"
  | "section"
  | "heading"
  | "dialogue"
  | "note"
  | "summary"
  | "action"
  /** 后期特效叠加（红框、浮层、弹窗、数字闪烁…）。
   * 2026-09-18 新增：它不是现场发生的动作、也不是本镜场景，必须单独成类，
   * 否则会被当作画面动作或地点使用——真实事故见 extractor 的 collect_review_flags。 */
  | "effect";

type RawParagraph = { index: number; text: string };
type RawItem = {
  source_paragraph: number;
  source_segment?: number;
  type: string;
  text?: string;
  source_text?: string;
  speaker?: string;
  scene_hint?: string;
  visual_note?: string;
  /** 对白标签里被剥出的现场动作/神态提示（「王老师一愣」「小李走进来，把平板递过去」）。
   * 规则版本 ≥1.7 才产出；旧提取结果没有这个字段。 */
  performance_cue?: string;
  speech?: { estimated_seconds_fast?: number };
};
type RawExample = {
  id: string;
  heading: string;
  source_heading_paragraph: number;
  items: RawItem[];
  generation?: {
    estimated_dialogue_seconds_fast?: number;
    minimum_clip_estimate?: number;
    explicit_scene_transition_count?: number;
    requires_storyboard_split?: boolean;
    split_reasons?: string[];
  };
};
type RawSection = {
  section_number: number;
  title: string;
  source_heading_paragraph: number;
  examples: RawExample[];
};
type RawExtraction = {
  schema_version: string;
  project_title: string;
  extraction_mode: string;
  source_paragraphs: RawParagraph[];
  sections: RawSection[];
  excluded_paragraphs: Array<{
    source_paragraph: number;
    reason: string;
    text: string;
  }>;
  review_flags: string[];
};

type PythonCandidate = { command: string; prefix: string[] };

function pythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const configured = process.env.AUDIT_VIDEO_PYTHON;
  if (configured) candidates.push({ command: configured, prefix: [] });

  if (process.platform === "win32") {
    candidates.push({
      command: path.join(
        /* turbopackIgnore: true */ homedir(),
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "dependencies",
        "python",
        "python.exe",
      ),
      prefix: [],
    });
    candidates.push({ command: "py", prefix: ["-3"] });
  }

  candidates.push({ command: "python3", prefix: [] });
  candidates.push({ command: "python", prefix: [] });
  return candidates.filter(
    (candidate, index, list) =>
      list.findIndex(
        (item) =>
          item.command === candidate.command &&
          item.prefix.join("\u0000") === candidate.prefix.join("\u0000"),
      ) === index,
  );
}

function runFile(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      /* turbopackIgnore: true */ command,
      args,
      { timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

async function runExtractor(inputPath: string, outputPath: string) {
  const failures: string[] = [];
  for (const candidate of pythonCandidates()) {
    try {
      await runFile(candidate.command, [
        ...candidate.prefix,
        EXTRACTOR_PATH,
        inputPath,
        "--json",
        outputPath,
      ]);
      return candidate.command;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.command}: ${message.split(/\r?\n/u)[0]}`);
    }
  }
  throw new Error(`没有可用的 Python 提取运行时。${failures.join("；")}`);
}

function paragraphKindMap(data: RawExtraction) {
  const kinds = new Map<number, ParagraphKind>();

  for (const excluded of data.excluded_paragraphs) {
    const kind: ParagraphKind = excluded.reason === "visual_effect_label"
      ? "effect"
      : excluded.reason === "summary_or_fixed_ending" ||
          excluded.reason.startsWith("post_production_")
        ? "summary"
        : excluded.reason === "section_marker"
          ? "section"
          : excluded.reason.includes("title_card") ||
              excluded.reason.includes("effects") ||
              excluded.reason === "audit_reminder"
            ? "note"
            : "meta";
    kinds.set(excluded.source_paragraph, kind);
  }

  for (const section of data.sections) {
    kinds.set(section.source_heading_paragraph, "section");
    for (const example of section.examples) {
      kinds.set(example.source_heading_paragraph, "heading");
      for (const item of example.items) {
        kinds.set(
          item.source_paragraph,
          item.type === "dialogue"
            ? "dialogue"
            : item.type === "action_or_narration" || item.type === "narration_context"
              ? "action"
              // 后期特效：只登记、不参与画面动作与场景判定。
              : item.type === "visual_effect"
                ? "effect"
                : "note",
        );
      }
    }
  }

  return kinds;
}

function splitNote(example: RawExample) {
  const generation = example.generation;
  if (!generation?.requires_storyboard_split) {
    return "同一时空、同一事件状态默认保留为 1 个分镜；说话人切换不会自动拆镜。";
  }
  if (
    generation.split_reasons?.includes(
      "explicit_scene_or_character_location_transition",
    )
  ) {
    return `原文存在明确的场景或人物地点切换，先按 ${Math.max(
      2,
      1 + (generation.explicit_scene_transition_count ?? 1),
    )} 个连续分镜规划。`;
  }
  return `按已验收样片语速估算约 ${generation.estimated_dialogue_seconds_fast ?? "—"} 秒，先按 ${generation.minimum_clip_estimate ?? 2} 个分镜规划；优先在说话人切换或自然句点处拆分。`;
}

function buildReview(data: RawExtraction) {
  const examples = data.sections.flatMap((section) => section.examples);
  const items = examples.flatMap((example) => example.items);
  const dialogues = items.filter((item) => item.type === "dialogue");
  const narration = items.filter((item) => item.type === "narration_context");
  const ids = examples.map((example) => example.id);
  const idsValid = new Set(ids).size === ids.length &&
    ids.every((id) => /^S\d+-E\d+$/u.test(id));
  const issues = data.review_flags.map((message) => {
    const match = /^(S\d+-E\d+)\s+第(\d+)段/u.exec(message);
    const sourceId = match ? Number(match[2]) : undefined;
    const speakerMatch = /说话人“([^”]+)”需要复核/u.exec(message);
    const speaker = speakerMatch?.[1];
    // 2026-09-18 新增：后期特效与本节场景不一致。
    // 真实事故：「场景设定：办公室里…」+「镜头/特效：处理笺扫描件浮现在餐桌上方」——
    // 旧版只排除了「镜头/特效：」这个标签，却把这行正文当成画面动作，
    // 于是「餐桌」一路进了分镜动作和生图提示词，而没有任何一处审查报出来。
    const effectMatch = /后期特效提到“([^”]+)”，与本节场景“([^”]*)”不一致/u.exec(message);
    const effectWords = effectMatch?.[1];
    const effectScene = effectMatch?.[2];
    const sourceText = sourceId
      ? data.source_paragraphs.find((paragraph) => paragraph.index === sourceId)
          ?.text
      : undefined;
    return {
      message,
      caseId: match?.[1],
      sourceId,
      sourceText,
      reason: effectWords
        ? `第 ${sourceId} 段写在「镜头/特效：」下面，属于后期叠加（浮层、红框、弹窗），其中提到的“${effectWords}”与本节场景“${effectScene}”不是同一个地方。它已按后期特效处理，不会成为画面动作，也不会进入生图提示词。`
        : speaker
          ? `说话人只写成“${speaker}”，无法确定这个字母对应的真实角色身份。`
          : "这一段的结构或角色归属无法由规则稳定判断。",
      question: effectWords
        ? `这一段的特效还要不要保留？如果保留，它提到的地点是否写错了——本镜场景是“${effectScene}”。`
        : speaker
          ? `请确认“${speaker}”具体是谁，以及这句台词是否确实由该角色说出。`
          : "请确认这段是否属于当前最小案例，以及是否需要进入后续分镜。",
      action: effectWords
        ? `把该行的地点改成本场景内的位置（例如“办公桌上方”），或直接删掉这一行；若确实要换场景，请改本节的「场景设定」并重新拆镜。`
        : speaker
          ? `把“${speaker}”改成完整角色名，例如“工作人员”“主任”或“审计人员A”，并保持相邻对白中的称呼一致。`
          : "确认后修改原文中的角色名或内容归属，再重新执行脚本审查。",
    };
  });

  const checks = [
      {
        label: "大案例识别",
        status: data.sections.length ? "PASS" : "BLOCKED",
        detail: `识别 ${data.sections.length} 个内容主题`,
      },
      {
        label: "最小案例识别",
        status: examples.length ? "PASS" : "BLOCKED",
        detail: `递归识别 ${examples.length} 个最小案例`,
      },
      {
        label: "人物对白覆盖",
        status: dialogues.length ? "PASS" : "BLOCKED",
        detail: `纳入 ${dialogues.length} 句人物对白`,
      },
      {
        label: "旁白排除",
        status: "PASS",
        detail: `${narration.length} 句旁白仅作画面理解，不生成音频`,
      },
      {
        label: "非生成内容排除",
        status: "PASS",
        detail: `排除 ${data.excluded_paragraphs.length} 段标题卡、字幕/屏幕文字、提示框、音效或总结；后期特效单独标记，不作为画面动作`,
      },
      {
        label: "Word 时间码",
        status: "PASS",
        detail: "只用于定位案例边界，不作为生成时长约束",
      },
      {
        label: "角色简称",
        status: data.review_flags.length ? "REVISE" : "PASS",
        detail: data.review_flags.length
          ? `${data.review_flags.length} 项需要人工核对`
          : "未发现需要复核的说话人简称",
      },
      {
        label: "案例 ID",
        status: idsValid ? "PASS" : "BLOCKED",
        detail: idsValid ? `使用 ${ids[0] ?? "—"} 至 ${ids.at(-1) ?? "—"}` : "案例 ID 有重复或格式错误",
      },
    ] as const;
  const status = checks.some((check) => check.status === "BLOCKED")
    ? "BLOCKED"
    : checks.some((check) => check.status === "REVISE")
      ? "REVISE"
      : "PASS";

  return {
    status,
    checks,
    flags: data.review_flags,
    issues,
  };
}

function adaptExtraction(data: RawExtraction) {
  const kinds = paragraphKindMap(data);
  const ruleCases = data.sections.flatMap((section) =>
    section.examples.map((example) => {
      const dialogueItems = example.items.filter(
        (item) => item.type === "dialogue",
      );
      return {
        id: example.id,
        group: section.title || `主题 ${section.section_number}`,
        title: example.heading || section.title || example.id,
        context: {
          title: example.heading || section.title || example.id,
          scene: example.items.find((item) =>
            item.type === "visual_direction" && /场景|画面|镜头/u.test(item.text ?? ""),
          )?.text,
        },
        sourceIds: [
          example.source_heading_paragraph,
          ...example.items.map((item) => item.source_paragraph),
        ].filter((id, index, ids) => ids.indexOf(id) === index),
        dialogueCount: dialogueItems.length,
        storyboardCount: Math.max(
          1,
          example.generation?.minimum_clip_estimate ?? 1,
        ),
        note: splitNote(example),
        estimatedSeconds:
          example.generation?.estimated_dialogue_seconds_fast ?? 0,
        items: example.items
          // 2026-09-19（用户拍板）：后期特效在前期识别就不进案例素材——特效段落只登记在
          // scriptDrafts（kind=effect）与审查旗标里。此前特效会顺着案例 → 分镜 sourceItems
          // → 画面词/视频词流进生成提示词，实测造成生成漂移（浮层、红框被模型当真实镜头渲染）。
          .filter((item) => item.type !== "visual_effect")
          .flatMap((item) => {
          const extractedItem = {
            sourceId: item.source_paragraph,
            sourceSegment: item.source_segment,
            type: item.type,
            speaker: item.speaker,
            text: item.text ?? item.source_text ?? "",
            estimatedSeconds: item.speech?.estimated_seconds_fast ?? 0,
            sceneHint: item.scene_hint,
            performance_cue: item.performance_cue,
          };
          return item.type === "dialogue" && item.visual_note
            ? [{
                sourceId: item.source_paragraph,
                type: "visual_direction",
                text: `画面：${item.visual_note}`,
                estimatedSeconds: 0,
              }, extractedItem]
            : [extractedItem];
        }),
      };
    }),
  );
  const cases = ruleCases.length
    ? ruleCases
    : [{
        id: "S1-E1",
        group: "待复核内容",
        title: "规则未识别案例边界",
        sourceIds: data.source_paragraphs.map((paragraph) => paragraph.index),
        dialogueCount: 0,
        storyboardCount: 1,
        note: "当前 Word 没有稳定的案例标题结构，请使用 AI 结构复核或人工修改原文后确认。",
        estimatedSeconds: 0,
        items: [],
      }];

  return {
    projectTitle: data.project_title,
    extractionMode: data.extraction_mode,
    engine: `脚本结构提取器 · 规则版本 ${data.schema_version}${
      ruleCases.length ? "" : " · 待结构复核"
    }`,
    paragraphs: data.source_paragraphs.map((paragraph) => ({
      id: paragraph.index,
      kind: kinds.get(paragraph.index) ?? "meta",
      text: paragraph.text,
    })),
    cases,
    review: buildReview(data),
  };
}

export async function POST(request: Request) {
  if (!(await getAuthenticatedEmail(request))) return NextResponse.json({ error: "请先登录", code: "AUTH_REQUIRED" }, { status: 401 });
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "请选择一个 .docx 文件。" }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return NextResponse.json({ error: "目前只支持 .docx 文件。" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Word 文件不能超过 12 MB。" }, { status: 400 });
  }

  const tempRoot = path.resolve(/* turbopackIgnore: true */ tmpdir());
  const tempDirectory = await mkdtemp(
    path.join(/* turbopackIgnore: true */ tempRoot, "audit-video-extract-"),
  );
  const safeFileName = file.name
    .replace(/[<>:"|?*\u0000-\u001F]/gu, "_")
    .replace(/[\\/]/gu, "_");
  const inputPath = path.join(
    /* turbopackIgnore: true */ tempDirectory,
    safeFileName || "source.docx",
  );
  const outputPath = path.join(
    /* turbopackIgnore: true */ tempDirectory,
    "extraction.json",
  );

  try {
    await writeFile(
      /* turbopackIgnore: true */ inputPath,
      Buffer.from(await file.arrayBuffer()),
    );
    await runExtractor(inputPath, outputPath);
    const raw = JSON.parse(
      await readFile(/* turbopackIgnore: true */ outputPath, "utf8"),
    ) as RawExtraction;
    if (!raw.source_paragraphs?.length || !raw.sections) {
      return NextResponse.json(
        { error: "提取器没有返回可用的脚本结构，请检查 Word 正文。" },
        { status: 422 },
      );
    }

    return NextResponse.json({
      fileName: file.name,
      ...adaptExtraction(raw),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json(
      { error: `脚本结构提取失败：${message}` },
      { status: 500 },
    );
  } finally {
    const resolved = path.resolve(/* turbopackIgnore: true */ tempDirectory);
    if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith("audit-video-extract-")) {
      await rm(/* turbopackIgnore: true */ resolved, { recursive: true, force: true });
    }
  }
}
