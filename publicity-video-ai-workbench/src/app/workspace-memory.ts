import { isRecord } from "./data-shape.ts";
import type { StageKey } from "./workbench-data";

export type RuleScope = "global" | "department" | "project";
export type RuleStatus = "candidate" | "active" | "retired";

export type RuleEditableState = {
  title: string;
  instruction: string;
  stage: StageKey;
  issueType: string;
  scope: RuleScope;
  status: RuleStatus;
  keywords: string[];
  projectId?: string;
  updatedAt: string;
};

export type ReuseRule = {
  id: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  instruction: string;
  stage: StageKey;
  issueType: string;
  scope: RuleScope;
  status: RuleStatus;
  keywords: string[];
  sourceProjectId: string;
  sourceHistoryId?: string;
  projectId?: string;
  adoptedCount: number;
  rejectedCount: number;
  speechRate?: number;
  previous?: RuleEditableState;
};

export type ReferenceAsset = {
  id: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt: string;
  sourceProjectId: string;
  sourcePromptId: string;
  title: string;
  image: string;
  prompt: string;
  tags: string[];
  usageCount: number;
  kind: "character" | "style" | "scene";
  roleName?: string;
  builtIn?: boolean;
};

export const BUILT_IN_REFERENCE_ASSETS: ReferenceAsset[] = [
  {
    id: "builtin-auditor-a",
    createdAt: "2026-04-29T03:02:05.000Z",
    updatedAt: "2026-04-29T03:02:05.000Z",
    sourceProjectId: "builtin",
    sourcePromptId: "固定内容/审计员A.png",
    title: "审计员 A · 固定人物形象",
    image: "/fixed/auditor-a.png",
    prompt: "审计员 A 出现时，以这张人物图锁定眼镜、发型、脸型和服装；场景、姿态与构图仍按当前分镜生成。",
    tags: ["审计员A", "固定人物", "眼镜", "角色一致性"],
    usageCount: 0,
    kind: "character",
    roleName: "审计员A",
    builtIn: true,
  },
  {
    id: "builtin-flat-line-style",
    createdAt: "2026-04-29T03:02:05.000Z",
    updatedAt: "2026-04-29T03:02:05.000Z",
    sourceProjectId: "builtin",
    sourcePromptId: "固定内容/剪映扁平线条风参考.png",
    title: "剪映扁平线条风 · 固定风格参考",
    image: "/fixed/flat-line-style.png",
    prompt: "只参考这张图的平涂方式、线条密度、柔和明暗与整体质感，不复制其中的人物、服装、场景或构图。",
    tags: ["剪映扁平线条风", "2D扁平化", "平涂", "整体风格"],
    usageCount: 0,
    kind: "style",
    builtIn: true,
  },
];

export type AiRuleCandidate = Pick<
  ReuseRule,
  "title" | "instruction" | "stage" | "issueType" | "scope" | "keywords"
> & { reason: string };

function comparableRuleInstruction(value: string) {
  return value
    .replace(/[（(]重复记录[）)]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function findDuplicateRule(
  rules: ReuseRule[],
  candidate: Pick<AiRuleCandidate, "instruction" | "scope" | "stage">,
  projectId: string,
) {
  const instruction = comparableRuleInstruction(candidate.instruction);
  return rules.find(
    (rule) =>
      rule.status !== "retired" &&
      rule.stage === candidate.stage &&
      rule.scope === candidate.scope &&
      (rule.scope !== "project" || rule.projectId === projectId) &&
      comparableRuleInstruction(rule.instruction) === instruction,
  );
}

export function parseCharacterBindingInstruction(value: string) {
  const clean = value.replace(/\s+/gu, " ").trim();
  const operator = /(?:沿用|使用|统一为|改为|改成|换成)/u.exec(clean);
  if (!operator || operator.index === undefined) return null;

  const before = clean.slice(0, operator.index).replace(/[，,]\s*$/u, "");
  const after = clean.slice(operator.index + operator[0].length);
  const sourceMatch = /([^，。,\s]{1,12}?)(?:的)?(?:人物)?形象(?:全部)?(?:都)?$/u.exec(before);
  const sourceFallback = before
    .split(/[，,]/u)
    .at(-1)
    ?.replace(/^(?:请|把|将|让)?(?:里面|全文|文章|脚本|项目|全片)?(?:里|中的|中)?(?:所有)?(?:的)?/u, "")
    .replace(/(?:全部)?(?:都)?$/u, "")
    .trim();
  const sourceRole = (sourceMatch?.[1] ?? sourceFallback ?? "")
    .replace(/^(?:请|把|将|让)?(?:里面|全文|文章|脚本|项目|全片)?(?:里|中的|中)?(?:所有)?(?:的)?/u, "")
    .trim();
  const targetRole = after
    .replace(/^(?:之前|此前|原来|素材库(?:中|里)?(?:的)?)/u, "")
    .replace(/(?:的)?(?:固定)?(?:人物)?(?:参考图|形象).*$/u, "")
    .replace(/[，。,].*$/u, "")
    .trim();

  return sourceRole && targetRole && sourceRole !== targetRole
    ? { sourceRole, targetRole }
    : null;
}

const STAGES = new Set<StageKey>([
  "script",
  "cases",
  "scriptReview",
  "storyboard",
  "imagePrompt",
  "reference",
  "videoPrompt",
]);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))].slice(0, 12)
    : [];
}

function stage(value: unknown): StageKey {
  return typeof value === "string" && STAGES.has(value as StageKey)
    ? (value as StageKey)
    : "imagePrompt";
}

function editableRuleState(value: unknown): RuleEditableState | undefined {
  if (!isRecord(value)) return undefined;
  const title = text(value.title);
  const instruction = text(value.instruction);
  if (!title || !instruction) return undefined;
  const scope = ["global", "department", "project"].includes(text(value.scope))
    ? (text(value.scope) as RuleScope)
    : "department";
  return {
    title,
    instruction,
    stage: stage(value.stage),
    issueType: text(value.issueType) || "其他",
    scope,
    status: ["candidate", "active", "retired"].includes(text(value.status))
      ? (text(value.status) as RuleStatus)
      : "candidate",
    keywords: stringList(value.keywords),
    projectId: scope === "project" ? text(value.projectId) || undefined : undefined,
    updatedAt: text(value.updatedAt) || new Date().toISOString(),
  };
}

export function normalizeReuseRule(value: unknown): ReuseRule {
  if (!isRecord(value)) throw new Error("规则记录无效");
  const id = text(value.id);
  const title = text(value.title);
  const instruction = text(value.instruction);
  if (!id || !title || !instruction) throw new Error("规则缺少必要内容");
  const scope = ["global", "department", "project"].includes(text(value.scope))
    ? (text(value.scope) as RuleScope)
    : "department";
  const status = ["candidate", "active", "retired"].includes(text(value.status))
    ? (text(value.status) as RuleStatus)
    : "candidate";
  const createdAt = text(value.createdAt) || new Date().toISOString();
  return {
    id,
    ownerEmail: text(value.ownerEmail).toLowerCase() || undefined,
    createdAt,
    updatedAt: text(value.updatedAt) || createdAt,
    title,
    instruction,
    stage: stage(value.stage),
    issueType: text(value.issueType) || "其他",
    scope,
    status,
    keywords: stringList(value.keywords),
    sourceProjectId: text(value.sourceProjectId),
    sourceHistoryId: text(value.sourceHistoryId) || undefined,
    projectId: scope === "project" ? text(value.projectId) || undefined : undefined,
    adoptedCount:
      typeof value.adoptedCount === "number" ? Math.max(0, value.adoptedCount) : 0,
    rejectedCount:
      typeof value.rejectedCount === "number" ? Math.max(0, value.rejectedCount) : 0,
    speechRate:
      typeof value.speechRate === "number" &&
      Number.isFinite(value.speechRate) &&
      value.speechRate >= 3 &&
      value.speechRate <= 9
        ? value.speechRate
        : undefined,
    previous: editableRuleState(value.previous),
  };
}

export function normalizeReferenceAsset(value: unknown): ReferenceAsset {
  if (!isRecord(value)) throw new Error("素材记录无效");
  const id = text(value.id);
  const image = text(value.image);
  if (!id || !image) throw new Error("素材缺少图片数据");
  const createdAt = text(value.createdAt) || new Date().toISOString();
  const kind = ["character", "style"].includes(text(value.kind))
    ? (text(value.kind) as ReferenceAsset["kind"])
    : "scene";
  return {
    id,
    ownerEmail: text(value.ownerEmail).toLowerCase() || undefined,
    createdAt,
    updatedAt: text(value.updatedAt) || createdAt,
    sourceProjectId: text(value.sourceProjectId),
    sourcePromptId: text(value.sourcePromptId),
    title: text(value.title) || text(value.sourcePromptId) || "未命名素材",
    image,
    prompt: text(value.prompt),
    tags: stringList(value.tags),
    usageCount:
      typeof value.usageCount === "number" ? Math.max(0, value.usageCount) : 0,
    kind,
    roleName:
      kind === "character"
        ? text(value.roleName) || text(value.title) || undefined
        : undefined,
    builtIn: value.builtIn === true,
  };
}

export function normalizeAiRuleCandidate(
  value: unknown,
  fallbackStage: StageKey,
  fallbackIssueType: string,
): AiRuleCandidate {
  if (!isRecord(value)) throw new Error("模型返回的规则候选无效");
  const title = text(value.title);
  const instruction = text(value.instruction);
  if (!title || !instruction) throw new Error("模型返回的规则候选缺少标题或规则内容");
  return {
    title,
    instruction,
    stage: STAGES.has(value.stage as StageKey)
      ? (value.stage as StageKey)
      : fallbackStage,
    issueType: text(value.issueType) || fallbackIssueType,
    scope: ["global", "department", "project"].includes(text(value.scope))
      ? (text(value.scope) as RuleScope)
      : "project",
    keywords: stringList(value.keywords),
    reason: text(value.reason),
  };
}

export function matchReuseRules(
  rules: ReuseRule[],
  context: { projectId: string; stage: StageKey; text: string },
) {
  const haystack = context.text.toLowerCase();
  return rules
    .filter((rule) => {
      if (rule.status !== "active" || rule.stage !== context.stage) return false;
      if (rule.scope === "project" && rule.projectId !== context.projectId) return false;
      return rule.keywords.length === 0 || matchingKeywords(rule, context.text).length > 0;
    })
    .sort((left, right) => {
      const score = (rule: ReuseRule) =>
        rule.keywords.filter((word) => haystack.includes(word.toLowerCase())).length * 10 +
        rule.adoptedCount -
        rule.rejectedCount;
      return score(right) - score(left);
    });
}

export function matchingKeywords(rule: ReuseRule, contextText: string) {
  const haystack = contextText.toLowerCase();
  return rule.keywords.filter((word) => haystack.includes(word.toLowerCase()));
}

function characterBindingFromPromptRule(value: string) {
  const direct = /([^，。；\n]{1,16})出现时[^；。\n]*?沿用([^，。；\n]{1,16}?)(?:的)?固定人物参考图/u.exec(
    value,
  );
  if (direct) {
    return { sourceRole: direct[1].trim(), targetRole: direct[2].trim() };
  }
  return parseCharacterBindingInstruction(value);
}

export function promptRuleInstruction(rule: Pick<ReuseRule, "title" | "instruction">) {
  const binding =
    characterBindingFromPromptRule(rule.title) ??
    characterBindingFromPromptRule(rule.instruction);
  if (binding) {
    return `${binding.sourceRole}的外观严格沿用上传的${binding.targetRole}人物参考图，包括眼镜、发型、脸型和服装；只参考人物外观，不复制参考图的背景、姿态和构图。`;
  }

  const visualClauses = rule.instruction
    .split(/[。；\n]+/u)
    .map((clause) => clause.replace(/^[-\s]+/u, "").trim())
    .filter(Boolean)
    .filter(
      (clause) =>
        !/(?:工作台|素材库|规则库|保留.{0,12}角色名|原对白|生成时使用|保存|命中)/u.test(
          clause,
        ),
    );
  return visualClauses.length ? `${visualClauses.join("；")}。` : "";
}

export function cleanImagePromptForProvider(prompt: string) {
  const marker = "工作台复用规则：";
  const markerIndex = prompt.indexOf(marker);
  const base = (markerIndex >= 0 ? prompt.slice(0, markerIndex) : prompt)
    .split(/\r?\n/u)
    .map((line) => {
      if (!line.trim().startsWith("人物资产：")) return line;
      const role = /锁定([^；。]+?)的(?:眼镜|发型|脸型|服装)/u.exec(line)?.[1];
      return role
        ? `${role}的眼镜、发型、脸型和服装严格参考上传的人物图；只参考人物外观，不复制参考图的背景、姿态和构图。`
        : "";
    })
    .filter((line) => line.trim())
    .join("\n")
    .replace(
      /((?:电脑|平板|手机|显示器)屏幕[^，。；\n]{0,40}?)(?:标题|文字|内容)为[^，。；\n]+/gu,
      "$1",
    )
    .replace(
      /(?:，|,)?(?:旁边)?(?:弹出|打出)\s*[“"]?[^，。；\n”"]*[”"]?(?:\s*(?:和|与)\s*[“"][^”"]*[”"])?/gu,
      "",
    )
    .trim();
  if (markerIndex < 0) return base;

  const legacyRules = prompt
    .slice(markerIndex + marker.length)
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*-\s*/u, "").trim())
    .filter(Boolean)
    .map((instruction) => promptRuleInstruction({ title: "", instruction }))
    .filter(Boolean);
  return [base, ...legacyRules.filter((rule) => !base.includes(rule))]
    .filter(Boolean)
    .join("\n");
}

export function appendRulesToPrompt(prompt: string, rules: ReuseRule[]) {
  const cleanPrompt = cleanImagePromptForProvider(prompt);
  const missing = rules
    .map(promptRuleInstruction)
    .filter((instruction) => instruction && !cleanPrompt.includes(instruction));
  return [cleanPrompt, ...missing].filter(Boolean).join("\n");
}

export function inferAssetTags(title: string, prompt: string) {
  const source = `${title} ${prompt}`;
  const candidates = source
    .split(/[，。；、：:\s/|]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12);
  return [...new Set(candidates)].slice(0, 8);
}
