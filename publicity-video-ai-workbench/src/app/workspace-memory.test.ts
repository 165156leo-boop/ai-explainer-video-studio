import assert from "node:assert/strict";
import {
  appendRulesToPrompt,
  BUILT_IN_REFERENCE_ASSETS,
  cleanImagePromptForProvider,
  findDuplicateRule,
  matchReuseRules,
  matchingKeywords,
  normalizeAiRuleCandidate,
  normalizeReferenceAsset,
  normalizeReuseRule,
  parseCharacterBindingInstruction,
  type ReuseRule,
} from "./workspace-memory.ts";

const base: ReuseRule = {
  id: "rule-1",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  title: "固定人物发型",
  instruction: "同一角色在相邻镜头保持发型和服装一致。",
  stage: "imagePrompt",
  issueType: "角色连续性",
  scope: "department",
  status: "active",
  keywords: ["角色", "发型"],
  sourceProjectId: "project-a",
  adoptedCount: 1,
  rejectedCount: 0,
};

assert.deepEqual(
  matchReuseRules([base], {
    projectId: "project-b",
    stage: "imagePrompt",
    text: "保持角色发型一致",
  }).map((rule) => rule.id),
  ["rule-1"],
);
assert.deepEqual(matchingKeywords(base, "人物发型保持一致"), ["发型"]);

assert.equal(
  normalizeReuseRule({
    ...base,
    previous: {
      title: "旧标题",
      instruction: "旧规则",
      stage: "imagePrompt",
      issueType: "角色连续性",
      scope: "department",
      status: "candidate",
      keywords: ["旧词"],
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
  }).previous?.title,
  "旧标题",
);

assert.equal(
  findDuplicateRule(
    [base],
    {
      instruction: "同一角色在相邻镜头保持发型和服装一致。",
      stage: "imagePrompt",
      scope: "department",
    },
    "project-a",
  )?.id,
  "rule-1",
);
assert.equal(
  findDuplicateRule(
    [{ ...base, scope: "project", projectId: "project-a" }],
    {
      instruction: "同一角色在相邻镜头保持发型和服装一致。",
      stage: "imagePrompt",
      scope: "project",
    },
    "project-b",
  ),
  undefined,
);

assert.equal(normalizeReuseRule({ ...base, speechRate: 4.8 }).speechRate, 4.8);

assert.equal(
  matchReuseRules([{ ...base, scope: "project", projectId: "project-a" }], {
    projectId: "project-b",
    stage: "imagePrompt",
    text: "角色发型",
  }).length,
  0,
);

const injected = appendRulesToPrompt("原提示词", [base]);
assert.doesNotMatch(injected, /工作台复用规则|素材库/u);
assert.match(injected, /保持发型和服装一致/u);
assert.equal(appendRulesToPrompt(injected, [base]), injected);

assert.equal(
  cleanImagePromptForProvider(
    "原提示词\n\n工作台复用规则：\n- 小陈出现时，人物外观统一沿用审计员A的固定人物参考图；保留“小陈”的角色名和原对白；生成时使用素材库中的人物图。",
  ),
  "原提示词\n小陈的外观严格沿用上传的审计员A人物参考图，包括眼镜、发型、脸型和服装；只参考人物外观，不复制参考图的背景、姿态和构图。",
);
assert.equal(
  cleanImagePromptForProvider(
    "电脑屏幕显示历史新闻标题为我校赴M公司调研，凭证旁边弹出“跨度数年”。",
  ),
  "电脑屏幕显示历史新闻，凭证。",
  "提交生图前应删除屏幕可读标题和后期弹出文案",
);

assert.deepEqual(
  normalizeAiRuleCandidate(
    {
      title: "固定人物发型",
      instruction: "保持人物发型一致",
      stage: "imagePrompt",
      issueType: "角色连续性",
      scope: "department",
      keywords: ["人物", "发型"],
      reason: "来自一次已采用修改",
    },
    "storyboard",
    "其他",
  ).keywords,
  ["人物", "发型"],
);

assert.equal(BUILT_IN_REFERENCE_ASSETS[0].roleName, "审计员A");
assert.equal(
  BUILT_IN_REFERENCE_ASSETS.find((asset) => asset.kind === "style")?.image,
  "/fixed/flat-line-style.png",
);
assert.equal(
  normalizeReferenceAsset({
    id: "style-asset",
    image: "/style.png",
    kind: "style",
  }).kind,
  "style",
);
assert.equal(
  normalizeReferenceAsset({
    id: "legacy-asset",
    image: "/legacy.png",
    title: "旧场景图",
  }).kind,
  "scene",
);

assert.deepEqual(
  parseCharacterBindingInstruction("把里面小陈的人物形象全部沿用之前审计员A的形象"),
  { sourceRole: "小陈", targetRole: "审计员A" },
);
assert.deepEqual(
  parseCharacterBindingInstruction("让小陈的形象统一为审计员 A"),
  { sourceRole: "小陈", targetRole: "审计员 A" },
);

console.log("workspace memory tests passed");
