import type {
  ExtractedCase,
  ExtractedCaseItem,
  ScriptParagraph,
} from "./workbench-data";
import {
  estimateSpeechSeconds,
  splitDialogueVisualNote,
} from "./shot-planning.ts";
import { isRecord, parseJsonObject } from "./data-shape.ts";

export type ExtractionReviewIssue = {
  message: string;
  sourceId?: number;
  caseId?: string;
  sourceText?: string;
  reason?: string;
  question?: string;
  action?: string;
};

export type ExtractionReviewResult = {
  summary: string;
  cases: ExtractedCase[];
  issues: ExtractionReviewIssue[];
  changed: boolean;
};

function cleanText(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanScriptLine(text: string) {
  return text.replace(/^[>\-\s]+/u, "").trim();
}

export function nonGenerationParagraphIds(paragraphs: ScriptParagraph[]) {
  const excluded = new Set<number>();
  let insideSubtitleBlock = false;

  for (const paragraph of paragraphs) {
    const text = cleanScriptLine(paragraph.text);
    const structuralBoundary = paragraph.kind === "heading" ||
      paragraph.kind === "section" ||
      /^\d+\s*(?:s|秒)?\s*[-—~至]\s*\d+\s*(?:s|秒)/iu.test(text);
    if (structuralBoundary) insideSubtitleBlock = false;

    const subtitleHeader = /^(?:字幕(?:[（(].*?[）)])?|屏幕文字|浮现新字幕)[：:]?/u.test(text);
    if (subtitleHeader) {
      excluded.add(paragraph.id);
      insideSubtitleBlock = true;
      continue;
    }

    if (insideSubtitleBlock) {
      const generatedContentResumes = paragraph.kind === "dialogue" ||
        paragraph.kind === "action" ||
        /^(?:场景设定|场景|画面|镜头|镜头\s*\/\s*特效|镜头特效|特效|动作|环境|地点)[：:]/u.test(text);
      if (generatedContentResumes) {
        insideSubtitleBlock = false;
      } else {
        excluded.add(paragraph.id);
        continue;
      }
    }

    if (
      /^音效[：:]/u.test(text) ||
      /^(?:镜头\s*\/\s*特效|镜头特效|特效)[：:]\s*$/u.test(text) ||
      /^(?:(?:弹出|浮现|出现).{0,16}(?:提示框|字幕条|文字框|文字卡)|(?:提示框|字幕条|文字框|文字卡))[：:]/u.test(text) ||
      /^(?:✅|❌|☑️?|✔|✘)\s*/u.test(text) ||
      /^(?:正确做法|错误做法)[：:]/u.test(text)
    ) {
      excluded.add(paragraph.id);
    }
  }

  return excluded;
}

/**
 * 后期特效叠加段落。
 *
 * 2026-09-18 新增，修一个真实事故：上传文档「提示一」的「镜头/特效：」下面写着
 * 「处理笺扫描件浮现在餐桌上方，来访人员信息被红框圈出，旁边弹出“？”」，
 * 而同节「场景设定」是办公室。旧的段落归类只把「镜头/特效：」这个**标签**排除掉，
 * 正文却被当成 `action_or_narration`——它于是成为分镜动作、进入画面词，
 * 最后由生图模型忠实画出「餐桌」，而程序里搜「餐桌」是 0 命中。
 *
 * 这里按标签块划定范围：空标签之后、直到下一段正常内容（或另一类非生成构造）之前的每段都是
 * 后期叠加，行内直接写成「特效：…」的段落同样算。
 *
 * 注意：这个集合**不并入** `nonGenerationParagraphIds`。后者被用来过滤复核旗标，
 * 而新的「后期特效与本节场景不一致」旗标恰恰需要指向这些段落。
 */
export function postProductionEffectParagraphIds(paragraphs: ScriptParagraph[]) {
  const ids = new Set<number>();
  // 「提示框 / 字幕 / 音效 / ✅❌ 行」本身就是独立的非生成构造，是特效块的天然分界。
  // 用它来收口，可以避免把特效块后面的提示框、字幕一起吞进来（真实文档就是这个顺序：
  // 「镜头/特效：」→ 特效正文 → 「弹出绿色提示框：」→ 「字幕（屏幕文字）：」）。
  const nonGenerationIds = nonGenerationParagraphIds(paragraphs);
  let insideEffectBlock = false;

  for (const paragraph of paragraphs) {
    const text = cleanScriptLine(paragraph.text);
    if (
      paragraph.kind === "heading" ||
      paragraph.kind === "section" ||
      /^\d+\s*(?:s|秒)?\s*[-—~至]\s*\d+\s*(?:s|秒)/iu.test(text)
    ) {
      insideEffectBlock = false;
    }

    if (/^(?:镜头\s*\/\s*特效|镜头特效|特效)[：:]\s*$/u.test(text)) {
      ids.add(paragraph.id);
      insideEffectBlock = true;
      continue;
    }

    if (/^(?:镜头\s*\/\s*特效|镜头特效|特效)[：:]\s*\S/u.test(text)) {
      ids.add(paragraph.id);
      insideEffectBlock = false;
      continue;
    }

    if (!insideEffectBlock) continue;

    // 特效块遇到别的非生成构造就结束：它已经被原有机制排除，不需要再打上后期特效标签。
    if (nonGenerationIds.has(paragraph.id)) {
      insideEffectBlock = false;
      continue;
    }

    const resumes = paragraph.kind === "dialogue" ||
      paragraph.kind === "effect" ||
      /^(?:场景设定|场景|画面|镜头|动作|环境|地点)[：:]/u.test(text) ||
      /^.{1,40}[：:]\s*[“"]/u.test(text);
    if (resumes) {
      insideEffectBlock = false;
      continue;
    }
    ids.add(paragraph.id);
  }

  return ids;
}

export function parseAiJsonObject(content: string) {
  return parseJsonObject(content, "模型没有返回有效的结构复核结果");
}

function sourceIds(
  value: unknown,
  validIds: Set<number>,
  paragraphOrder: Map<number, number>,
) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter(
      (item): item is number =>
        Number.isInteger(item) && validIds.has(item as number),
    ),
  )].sort(
    (left, right) =>
      (paragraphOrder.get(left) ?? 0) - (paragraphOrder.get(right) ?? 0),
  );
}

function originalDialogue(paragraph: ScriptParagraph, segment?: number) {
  const quotedSegments = [...paragraph.text.matchAll(
    /([^：:\n]{1,40})[：:]\s*[“"](.+?)[”"]/gu,
  )];
  const quoted = segment ? quotedSegments[segment - 1] : undefined;
  const whole = /^([^：:\n]{1,40})[：:]\s*(.+)$/u.exec(paragraph.text);
  const label = (quoted?.[1] ?? whole?.[1] ?? "").trim();
  const { spokenText, visualText } = splitDialogueVisualNote(
    quoted?.[2]?.trim() || whole?.[2]?.trim() || paragraph.text,
  );
  return { label, spokenText, visualText };
}

/**
 * 对白标签里的现场动作/神态提示。
 *
 * 2026-10-07：与 `AI视频agent/scripts/extract_story_sections.py` 的 `split_stage_direction`
 * **同源同规则**。Python 侧负责新导入，这里负责已有项目的回填；两边正则若不一致，
 * 同一份 Word 走「导入」和走「迁移」会得到不同的 performance_cue。
 *
 * 为什么要留：旧提取器把「王老师一愣」「小李走进来，把平板递过去」「刘主任有些为难」
 * 整段剥掉，只留下说话人。对白镜因此没有任何可执行动作，下游只能合成
 * 「小陈对王老师说明核查发现」这类口播意向串，再被 continuityVisualActions 全部删掉，
 * 最后 normalizeVideoPromptBriefs 以「缺少场景或动作」硬拒收——表面故障离缺陷三层。
 */
const SPEECH_VERB_RE =
  /(温和地|轻声地|认真地|连忙|随后|继续)?(提醒|点头|说道|说|问道|问|回答|解释|补充|表示|回应|建议|强调)/u;
/** 结尾锚点让「按原文逐字顺序切出」可行，因而不会误伤说话人里恰好含这些字的写法。 */
const TRAILING_STAGE_DIRECTION_RE =
  /(?:站在门口.*|走进来.*|现场对话.*|有些为难|一愣|看了看|又)$/u;
/** 「点头」是可见的现场动作，其余说话动词只是发声方式，单独出现不算画面信息。 */
const PHYSICAL_SPEECH_VERBS = new Set(["点头"]);
/** 提示至少两个字才算有效信息，避免「又」这类残字进动作链。 */
const MIN_CUE_LENGTH = 2;
/** 说话人后面跟着未闭合左括号（「审计人员A（站在门口）」）时，尾巴是场景说明而非提示。 */
const DANGLING_OPEN_RE = /[（(【“"][^）)】”"]*$/u;

export function splitStageDirection(label: string): {
  label: string;
  performanceCue?: string;
} {
  let base = label.replace(/\s+/gu, " ").trim();
  const cues: string[] = [];

  const verb = SPEECH_VERB_RE.exec(base);
  if (verb) {
    const modifier = verb[1];
    const word = verb[2];
    if (modifier) cues.push(`${modifier}${word}`);
    else if (PHYSICAL_SPEECH_VERBS.has(word)) cues.push(word);
    const trimmed = base.slice(0, verb.index).trim();
    if (trimmed) base = trimmed;
  }

  const trailing = TRAILING_STAGE_DIRECTION_RE.exec(base);
  if (trailing && trailing.index > 0) {
    const head = base.slice(0, trailing.index).trim();
    if (head && !DANGLING_OPEN_RE.test(head)) {
      cues.unshift(base.slice(trailing.index).trim());
      base = head;
    }
  }

  const meaningful = cues.filter((cue) => cue.length >= MIN_CUE_LENGTH);
  return { label: base, performanceCue: meaningful.join("；") || undefined };
}

/**
 * 给已有项目的 `caseDrafts.items` 回填 `performance_cue`。
 *
 * 只补一个字段：不删除、不重排、不覆盖任何已有内容，也不动用户在 UI 里改过的
 * speaker/text——提示文字只从原始 Word 段落重新推导。Power-of-idempotence：
 * 已带 `performance_cue` 的条目直接跳过，重复执行结果不变。
 *
 * 调用时机由 project-store 的版本闸门决定（见 normalizeProjectSnapshot）。
 */
export function backfillPerformanceCue(
  paragraphs: ScriptParagraph[],
  cases: ExtractedCase[],
): ExtractedCase[] {
  const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  let changed = false;
  const next = cases.map((caseItem) => {
    if (!caseItem.items?.length) return caseItem;
    let itemsChanged = false;
    const items = caseItem.items.map((item) => {
      if (item.type !== "dialogue" || item.performance_cue) return item;
      const paragraph = byId.get(item.sourceId);
      if (!paragraph) return item;
      const { performanceCue } = splitStageDirection(
        originalDialogue(paragraph, item.sourceSegment).label,
      );
      if (!performanceCue) return item;
      itemsChanged = true;
      return { ...item, performance_cue: performanceCue };
    });
    if (!itemsChanged) return caseItem;
    changed = true;
    return { ...caseItem, items };
  });
  return changed ? next : cases;
}

function dialogueKey(sourceId: number, segment?: number) {
  return `${sourceId}:${segment ?? 0}`;
}

function contextParagraphs(
  paragraphs: ScriptParagraph[],
  ids: number[],
  dialogueIds: number[],
) {
  const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const ordered = paragraphs.map((paragraph) => paragraph.id);
  const firstDialogueIndex = Math.min(
    ...dialogueIds.map((id) => ordered.indexOf(id)).filter((index) => index >= 0),
  );
  const nearbyScene = Number.isFinite(firstDialogueIndex)
    ? [...paragraphs.slice(0, firstDialogueIndex)].reverse().find((paragraph) =>
        /场景设定|场景[：:]|画面[：:]/u.test(paragraph.text),
      )
    : undefined;
  const title = paragraphs.find((paragraph) => /^标题[：:]/u.test(paragraph.text));
  const existingContextIds = ids.filter((id) => {
    const paragraph = byId.get(id);
    return paragraph && /场景设定|场景[：:]|画面[：:]|动作[：:]/u.test(paragraph.text);
  });
  const extraIds = nearbyScene && !existingContextIds.includes(nearbyScene.id)
    ? [nearbyScene.id]
    : [];
  return {
    ids: [...new Set([...ids, ...extraIds])].sort((left, right) =>
      (ordered.indexOf(left) >= 0 ? ordered.indexOf(left) : 0) -
      (ordered.indexOf(right) >= 0 ? ordered.indexOf(right) : 0),
    ),
    title: title?.text,
    scene: nearbyScene?.text,
  };
}

function isContextParagraph(paragraph: ScriptParagraph) {
  return paragraph.kind === "note" || /^(?:标题|场景设定|场景|画面|镜头|动作|环境|地点)[：:]/u.test(paragraph.text);
}

function caseSignature(cases: ExtractedCase[]) {
  return JSON.stringify(
    cases.map((item) => ({
      id: item.id,
      group: item.group,
      title: item.title,
      sourceIds: item.sourceIds,
      dialogues: (item.items ?? [])
        .filter((row) => row.type === "dialogue")
        .map((row) => [row.sourceId, row.sourceSegment, row.speaker]),
    })),
  );
}

export function normalizeExtractionReview(
  value: unknown,
  paragraphs: ScriptParagraph[],
  currentCases: ExtractedCase[],
): ExtractionReviewResult {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error("模型返回的案例结构无效");
  }

  const paragraphById = new Map(paragraphs.map((item) => [item.id, item]));
  const paragraphOrder = new Map(
    paragraphs.map((item, index) => [item.id, index]),
  );
  const excludedIds = nonGenerationParagraphIds(paragraphs);
  const validIds = new Set(
    [...paragraphById.keys()].filter((id) => !excludedIds.has(id)),
  );
  const currentItemsBySource = new Map<number, ExtractedCaseItem[]>();
  for (const item of currentCases.flatMap((caseItem) => caseItem.items ?? [])) {
    currentItemsBySource.set(item.sourceId, [
      ...(currentItemsBySource.get(item.sourceId) ?? []),
      item,
    ]);
  }

  const usedCaseIds = new Set<string>();
  const usedDialogueKeys = new Set<string>();
  const cases = value.cases.map((rawCase, caseIndex) => {
    if (!isRecord(rawCase)) throw new Error("模型返回了无效案例");
    const id = cleanText(rawCase.id, 24);
    if (!/^S\d+-E\d+$/u.test(id) || usedCaseIds.has(id)) {
      throw new Error(`模型返回的第 ${caseIndex + 1} 个案例 ID 无效或重复`);
    }
    usedCaseIds.add(id);

    const rawIds = sourceIds(rawCase.sourceIds, validIds, paragraphOrder);
    if (!Array.isArray(rawCase.dialogues) || !rawCase.dialogues.length) {
      throw new Error(`${id} 没有标出人物对白`);
    }

    const parsedDialogues: Array<{ sourceId: number; segment?: number; speaker: string }> = [];
    for (const rawDialogue of rawCase.dialogues) {
      if (!isRecord(rawDialogue)) throw new Error(`${id} 的对白标注无效`);
      const sourceId = rawDialogue.sourceId;
      const speaker = cleanText(rawDialogue.speaker, 40);
      const segment = Number.isInteger(rawDialogue.segment)
        ? Math.max(1, Number(rawDialogue.segment))
        : undefined;
      const key = Number.isInteger(sourceId) ? dialogueKey(sourceId as number, segment) : "";
      if (
        !Number.isInteger(sourceId) ||
        !speaker ||
        usedDialogueKeys.has(key)
      ) {
        throw new Error(`${id} 的对白段落无效、重复或缺少说话人`);
      }
      parsedDialogues.push({ sourceId: sourceId as number, segment, speaker });
      usedDialogueKeys.add(key);
    }

    const context = contextParagraphs(
      paragraphs,
      [...rawIds, ...parsedDialogues.map((dialogue) => dialogue.sourceId)],
      parsedDialogues.map((dialogue) => dialogue.sourceId),
    );
    const ids = context.ids;
    const idSet = new Set(ids);
    const dialogueBySource = new Map<number, typeof parsedDialogues>();
    for (const dialogue of parsedDialogues) {
      if (!idSet.has(dialogue.sourceId)) {
        throw new Error(`${id} 的对白段落未包含在 sourceIds 中`);
      }
      dialogueBySource.set(dialogue.sourceId, [
        ...(dialogueBySource.get(dialogue.sourceId) ?? []),
        dialogue,
      ]);
    }

    const items = ids.flatMap((sourceId) => {
      const paragraph = paragraphById.get(sourceId);
      if (!paragraph) return [];
      const currentItems = currentItemsBySource.get(sourceId) ?? [];
      const retainedContext = currentItems.filter((item) => item.type !== "dialogue");
      const dialogueRows = dialogueBySource.get(sourceId) ?? [];
      const contextRows = retainedContext.length
        ? retainedContext
        : paragraph.kind !== "summary" && paragraph.kind !== "dialogue" && isContextParagraph(paragraph)
          ? [{
              sourceId,
              // kind 是 effect 的段落只能生成 visual_effect：
              // 归成 visual_direction 会被 shotLocation 当作本镜场景取用。
              type: paragraph.kind === "action"
                ? "action_or_narration"
                : paragraph.kind === "effect"
                  ? "visual_effect"
                  : "visual_direction",
              text: paragraph.text,
              estimatedSeconds: 0,
            } satisfies ExtractedCaseItem]
          : [];
      if (!dialogueRows.length) return contextRows;

      return [
        ...contextRows,
        ...dialogueRows.flatMap(({ segment, speaker }) => {
          const currentDialogue = currentItems.find(
            (item) => item.type === "dialogue" && item.sourceSegment === segment,
          ) ?? currentItems.find((item) => item.type === "dialogue" && segment === undefined);
          const original = originalDialogue(paragraph, segment);
          const spokenText = currentDialogue?.text || original.spokenText;
          const performanceCue = currentDialogue?.performance_cue ??
            splitStageDirection(original.label).performanceCue;
          const visual = original.visualText && !contextRows.some(
            (item) => item.text.includes(original.visualText),
          )
            ? [{
                sourceId,
                sourceSegment: segment,
                type: "visual_direction",
                text: `画面：${original.visualText}`,
                estimatedSeconds: 0,
              } satisfies ExtractedCaseItem]
            : [];
          return [
            ...visual,
            {
              sourceId,
              sourceSegment: segment,
              type: "dialogue",
              speaker,
              text: spokenText,
              estimatedSeconds:
                currentDialogue?.estimatedSeconds || estimateSpeechSeconds(spokenText),
              sceneHint: currentDialogue?.sceneHint,
              performance_cue: performanceCue,
            } satisfies ExtractedCaseItem,
          ];
        }),
      ];
    });
    const estimatedSeconds = items
      .filter((item) => item.type === "dialogue")
      .reduce((sum, item) => sum + item.estimatedSeconds, 0);
    const reason = cleanText(rawCase.reason, 360);
    return {
      id,
      group: cleanText(rawCase.group, 80) || `主题 ${caseIndex + 1}`,
      title: cleanText(rawCase.title, 120) || id,
      sourceIds: ids,
      dialogueCount: parsedDialogues.length,
      storyboardCount: Math.max(1, Math.ceil(estimatedSeconds / 15)),
      note: reason
        ? `AI 结构建议：${reason}`
        : "AI 已提出案例边界，原文段落与对白仍由程序校验。",
      estimatedSeconds: Math.round(estimatedSeconds * 10) / 10,
      context: {
        title: context.title,
        scene: context.scene,
      },
      items,
    } satisfies ExtractedCase;
  });

  if (!cases.length) throw new Error("模型没有返回最小案例");

  const issues: ExtractionReviewIssue[] = Array.isArray(value.issues)
    ? value.issues.slice(0, 16).flatMap((rawIssue) => {
        if (!isRecord(rawIssue)) return [];
        const rawSourceId = rawIssue.sourceId;
        const sourceId = Number.isInteger(rawSourceId) && validIds.has(rawSourceId as number)
          ? (rawSourceId as number)
          : undefined;
        const message = cleanText(rawIssue.message, 240) || cleanText(rawIssue.reason, 240);
        if (!message) return [];
        return [{
          message,
          sourceId,
          caseId: cleanText(rawIssue.caseId, 24) || undefined,
          sourceText: sourceId ? paragraphById.get(sourceId)?.text : undefined,
          reason: cleanText(rawIssue.reason, 360) || message,
          question: cleanText(rawIssue.question, 360) || "请确认 AI 对该段的判断是否正确。",
          action: cleanText(rawIssue.action, 360) || "确认后采用建议，或保留规则提取结果并修改原文。",
        }];
      })
    : [];

  const ruleDialogueIds = new Set([
    ...paragraphs
      .filter((item) => item.kind === "dialogue" && !excludedIds.has(item.id))
      .map((item) => item.id),
    ...currentCases.flatMap((item) =>
      (item.items ?? [])
        .filter((row) => row.type === "dialogue" && !excludedIds.has(row.sourceId))
        .map((row) => row.sourceId),
    ),
  ]);
  for (const sourceId of ruleDialogueIds) {
    if ([...usedDialogueKeys].some((key) => key.startsWith(`${sourceId}:`))) continue;
    const sourceText = paragraphById.get(sourceId)?.text;
    issues.push({
      message: `AI 建议未纳入规则初稿中的第 ${sourceId} 段人物对白`,
      sourceId,
      sourceText,
      reason: "规则与 AI 对这段是否属于人物对白存在分歧。",
      question: "这段是否应由人物实际说出并进入分镜？",
      action: "采用 AI 建议前先核对原文；若应保留，请继续使用规则结果或重新复核。",
    });
  }

  return {
    summary:
      cleanText(value.summary, 500) ||
      `AI 建议整理为 ${cases.length} 个最小案例，等待人工确认。`,
    cases,
    issues,
    changed: caseSignature(cases) !== caseSignature(currentCases),
  };
}
