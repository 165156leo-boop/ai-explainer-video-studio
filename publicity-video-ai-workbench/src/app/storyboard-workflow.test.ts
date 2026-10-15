import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtractedCase, ImagePromptPackage, Shot } from "./workbench-data";
import { buildCaseShots, buildImagePrompts } from "./shot-planning.ts";
import { inheritShotAssets, referenceImageStale, shotVisualSignature } from "./media-workflow.ts";
import { applyShotEdit, rebuildStoryboard, reconcileImagePrompts, reconcileStoryboardDependencies } from "./storyboard-workflow.ts";
import { resolveContinuityReference, resolveVideoPromptSources } from "./video-prompt-input.ts";
import { needsVideoPromptRepolish, videoPromptInputSignature } from "./polish-digest.ts";
import { normalizeVideoConstraints } from "./video-prompt.ts";
import { normalizeProjectSnapshot, STORYBOARD_RULE_VERSION } from "./project-store.ts";
import { BUILT_IN_REFERENCE_ASSETS, type ReuseRule } from "./workspace-memory.ts";

function makeCase(id: string): ExtractedCase {
  return { id, group: "报销", title: "凭证审核", sourceIds: [1, 2], dialogueCount: 2,
    storyboardCount: 2, note: "", context: { scene: "办公室" }, items: [
      { sourceId: 1, type: "dialogue", speaker: "小陈", text: "请核对凭证。", estimatedSeconds: 3 },
      { sourceId: 2, type: "dialogue", speaker: "王老师", text: "好的。", estimatedSeconds: 2 },
    ] };
}
const cases = [makeCase("S1-E1"), makeCase("S2-E1")];
const raw = cases.flatMap(item => buildCaseShots(item, item.items!.map(row => [row])));
const shots: Shot[] = raw.map(shot => ({ ...shot, storyboardConfirmed: true,
  image: `image-${shot.id}`, status: "ready", imageSourceSignature: shotVisualSignature(shot),
  videoLastFrame: `tail-${shot.id}`, videoLastFrameSignature: shotVisualSignature(shot),
  videoPromptPolished: { script: "人工核定稿", model: "model", sourceSignature: "old" },
  videoSecondsOverride: 10, videoModel: "custom", speechRateOverride: 5.5,
}));
const prompts = buildImagePrompts(shots).map((prompt, i): ImagePromptPackage => ({ ...prompt,
  prompt: `人工画面词 ${i}`, promptModel: "approved-model", image: shots[i].image,
  status: "ready", imageSourceSignature: shots[i].imageSourceSignature,
  mediaSource: { jobId: `job-${i}`, candidateId: `candidate-${i}` },
}));

test("无变化重建保留人工拆镜、画面词与全部视频成果", () => {
  const result = rebuildStoryboard({ cases, paragraphs: [], previousCases: cases,
    previousShots: shots, previousPrompts: prompts, speechRate: 5.5 });
  assert.deepEqual(result, { shots, prompts });
  const inherited = inheritShotAssets(raw, shots).map(entry => entry.shot);
  for (const [i, shot] of inherited.entries()) {
    for (const field of ["videoLastFrame", "videoLastFrameSignature", "videoPromptPolished",
      "videoSecondsOverride", "videoModel", "speechRateOverride", "storyboardConfirmed"] as const) {
      assert.deepEqual(shot[field], shots[i][field], field);
    }
    assert.equal(shot.referenceId, shot.id);
  }
});

test("改一个案例只重建该案例，另一个案例的人工成果原样保留", () => {
  const changed = { ...cases[0], items: cases[0].items!.map((row, i) => i ? row : { ...row, text: "请重新核对。" }) };
  const result = rebuildStoryboard({ cases: [changed, cases[1]], paragraphs: [], previousCases: cases,
    previousShots: shots, previousPrompts: prompts, speechRate: 5.5 });
  assert.deepEqual(result.shots.filter(shot => shot.caseId === "S2-E1"), shots.slice(2));
  assert.deepEqual(result.prompts.filter(prompt => prompt.id.startsWith("S2-E1")), prompts.slice(2));
  assert.equal(result.shots[0].storyboardConfirmed, false);
  assert.equal(result.shots[0].videoLastFrame, undefined);
  assert.equal(result.shots[0].videoPromptPolished, undefined);
  assert.ok(result.shots[0].dialogue.includes("请重新核对"));
});

test("拆分匹配与直接编辑共用失效原则，旧图片不会被重新签成有效", () => {
  const original = shots[0];
  const edited = applyShotEdit(original, { ...original, location: "会议室" });
  assert.equal(edited.storyboardConfirmed, false);
  assert.equal(edited.videoLastFrame, undefined);
  assert.equal(edited.videoPromptPolished, undefined);
  const next = reconcileImagePrompts([edited, ...shots.slice(1)], shots, prompts);
  assert.equal(next[0].image, prompts[0].image);
  assert.ok(referenceImageStale(edited, next[0]));
  assert.equal(next[0].promptModel, undefined);
  assert.deepEqual(next.slice(2), prompts.slice(2));
  const rebuilt = inheritShotAssets([{ ...raw[0], location: "会议室" }], [original])[0].shot;
  assert.ok(referenceImageStale(rebuilt, rebuilt));
  assert.equal(rebuilt.storyboardConfirmed, false);
  assert.equal(rebuilt.videoLastFrame, undefined);
  const spoken = applyShotEdit(original, { ...original, dialogue: "小陈：“换句话说。”" });
  assert.deepEqual(reconcileImagePrompts([spoken, ...shots.slice(1)], shots, prompts)[0], prompts[0]);
});

test("来源不变的人工编辑保留；来源行文字或说话人变化不得伪装成同一内容", () => {
  const manual = { ...shots[0], dialogue: "小陈：“人工确认对白。”", location: "手调场景" };
  const kept = inheritShotAssets([raw[0]], [manual], { preserveEdits: true })[0].shot;
  assert.equal(kept.dialogue, manual.dialogue);
  assert.equal(kept.location, manual.location);
  const newSpeaker = { ...raw[0], sourceItems: raw[0].sourceItems!.map(row => ({ ...row, speaker: "小王" })) };
  assert.equal(inheritShotAssets([newSpeaker], [manual], { preserveEdits: true })[0].exact, false);
});

test("保存再加载保留显式确认、手工时长、润色稿、尾帧与画面词", () => {
  const snapshot = { schemaVersion: 1, id: "test", title: "测试", sourceFileName: "test.docx",
    createdAt: "2026-10-13", updatedAt: "2026-10-13", currentStage: "videoPrompt", workflowStage: "videoPrompt",
    selectedId: shots[0].id, selectedCaseId: cases[0].id, selectedImagePromptId: prompts[0].id,
    scriptDrafts: [{ id: 1, kind: "meta", text: "测试" }], caseDrafts: cases,
    shotDrafts: shots, imagePromptDrafts: prompts, scriptReview: { status: "PASS", checks: [], flags: [], issues: [] },
    extractionEngine: "脚本结构提取器规则版本 1.7", storyboardRuleVersion: STORYBOARD_RULE_VERSION,
    speechRate: 5.5, uploadedNames: {}, history: [] };
  const loaded = normalizeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)));
  for (const [i, shot] of loaded.shotDrafts.entries()) {
    for (const field of ["storyboardConfirmed", "videoLastFrame", "videoLastFrameSignature", "videoPromptPolished",
      "videoSecondsOverride", "videoModel", "speechRateOverride"] as const) assert.deepEqual(shot[field], shots[i][field]);
  }
  assert.deepEqual(loaded.imagePromptDrafts, prompts);
  assert.equal(normalizeProjectSnapshot({ ...snapshot, shotDrafts: [{ ...shots[0], storyboardConfirmed: undefined }] }).shotDrafts[0].storyboardConfirmed, false);
});

test("视频签名覆盖画面词图片、尾帧、人物图、绑定和模型，忽略无关素材", () => {
  const shot = { ...shots[1], image: undefined };
  const binding: ReuseRule = { id: "binding", createdAt: "", updatedAt: "", title: "王老师沿用审计员A形象",
    instruction: "王老师沿用审计员A形象", stage: "imagePrompt", issueType: "identity", scope: "project",
    status: "active", keywords: [], sourceProjectId: "p", projectId: "p", adoptedCount: 0, rejectedCount: 0 };
  const inputs = { shots, prompts, assets: BUILT_IN_REFERENCE_ASSETS, rules: [binding], projectId: "p" };
  const signature = (input = inputs, model = "model") => videoPromptInputSignature(shot, resolveVideoPromptSources(shot, input), model);
  const original = signature();
  assert.notEqual(signature({ ...inputs, prompts: prompts.map(p => p.id === shot.id ? { ...p, image: "new-image" } : p) }), original);
  assert.notEqual(signature({ ...inputs, assets: inputs.assets.map(a => a.roleName === "审计员A" ? { ...a, image: "new-face" } : a) }), original);
  assert.notEqual(signature({ ...inputs, rules: [] }), original);
  assert.notEqual(signature(inputs, "new-model"), original);
  assert.equal(signature({ ...inputs, assets: [...inputs.assets, { ...inputs.assets[0], id: "unrelated", roleName: "无关人物" }] }), original);
  const withoutDraft = { ...inputs, prompts: [] };
  assert.equal(resolveVideoPromptSources(shot, withoutDraft).sceneImage, shots[0].videoLastFrame);
  assert.notEqual(signature({ ...withoutDraft, shots: shots.map((s, i) => i ? s : { ...s, videoLastFrame: "new-tail" }) }), signature(withoutDraft));
  const staleTail = { ...withoutDraft, shots: shots.map((s, i) => i ? s : { ...s, location: "不同场景" }) };
  assert.equal(resolveVideoPromptSources(shot, staleTail).sceneImage, undefined);
  assert.equal(needsVideoPromptRepolish({ hasPolished: true, storedSignature: "old", sessionSignature: original, currentSignature: original }), true);
  assert.equal(needsVideoPromptRepolish({ hasPolished: true, storedSignature: original, currentSignature: original }), false);
});

test("只替换冲突的历史自动约束，保留用户自定义要求", () => {
  assert.equal(normalizeVideoConstraints("全程固定镜头，不切镜、不转场、不运镜。不得改写对白。"),
    "一个镜头只采用一种与动作一致的运镜，不切镜、不转场。不得改写对白。");
  assert.equal(normalizeVideoConstraints("此处使用固定机位特写。"), "此处使用固定机位特写。");
});

function linkedFixture() {
  const chain = ["独立开场", "接续上一镜", "接续上一镜", "独立开场", "接续上一镜"].map((continuity, i): Shot => {
    const shot = { ...shots[0], id: `S1-E1-0${i + 1}`, referenceId: `S1-E1-0${i + 1}`, continuity };
    return { ...shot, videoLastFrameSignature: shotVisualSignature(shot) };
  });
  const images = chain.map((shot, i) => ({ ...prompts[0], id: shot.id, prompt: `手工词 ${i}`, imageSourceSignature: shotVisualSignature(shot) }));
  return { shots: chain, prompts: images };
}

test("改时长保留本镜画面确认，关联续镜逐级失效，独立开场及它的续镜不动", () => {
  const before = linkedFixture();
  const result = reconcileStoryboardDependencies(before.shots, before.prompts, {
    shots: before.shots.map((shot, i) => i ? shot : { ...shot, videoSecondsOverride: 15 }), prompts: before.prompts,
  });
  assert.equal(result.shots[0].storyboardConfirmed, true);
  assert.equal(result.shots[0].videoLastFrame, undefined);
  assert.equal(result.shots[0].videoPromptPolished, undefined);
  assert.deepEqual(result.prompts[0], before.prompts[0]);
  for (const index of [1, 2]) {
    assert.equal(result.shots[index].storyboardConfirmed, false);
    assert.equal(result.shots[index].videoLastFrame, undefined);
    assert.equal(result.shots[index].videoPromptPolished, undefined);
    assert.equal(result.prompts[index].prompt, before.prompts[index].prompt);
    assert.ok(referenceImageStale(result.shots[index], result.prompts[index]));
  }
  assert.deepEqual(result.shots.slice(3), before.shots.slice(3));
  assert.deepEqual(result.prompts.slice(3), before.prompts.slice(3));
  assert.equal(resolveContinuityReference(result.shots, result.prompts, result.shots[2].id).image, undefined);
});

test("更换尾帧/参考图也遵循同一关联图；无变化与纯确认不触发传播", () => {
  const before = linkedFixture();
  for (const patch of [{ videoLastFrame: "new-tail" }, { image: "new-reference" }, { estimatedSeconds: 12 }]) {
    const result = reconcileStoryboardDependencies(before.shots, before.prompts, {
      shots: before.shots.map((shot, i) => i ? shot : { ...shot, ...patch }), prompts: before.prompts,
    });
    assert.equal(result.shots[1].storyboardConfirmed, false);
    assert.deepEqual(result.shots.slice(3), before.shots.slice(3));
  }
  const same = reconcileStoryboardDependencies(before.shots, before.prompts, before);
  assert.deepEqual(same.affectedIds, []);
  const unconfirmed = before.shots.map((shot, i) => i ? shot : { ...shot, storyboardConfirmed: false });
  assert.deepEqual(reconcileStoryboardDependencies(unconfirmed, before.prompts, before).affectedIds, []);
});

test("删镜改变实际衔接对象须复核，独立镜头不因位置移动被撤销确认", () => {
  const before = linkedFixture();
  const result = reconcileStoryboardDependencies(before.shots, before.prompts, {
    shots: before.shots.filter((_, i) => i !== 1), prompts: before.prompts.filter((_, i) => i !== 1),
  });
  assert.equal(result.shots[1].storyboardConfirmed, false);
  assert.deepEqual(result.shots.slice(2), before.shots.slice(3));
});

test("复核标记保存重载仍有效，不因图片本身未变而自动放行", () => {
  const before = linkedFixture();
  const stale = JSON.parse(JSON.stringify({ ...before.prompts[1], imageNeedsReview: true }));
  assert.ok(referenceImageStale(before.shots[1], stale));
  assert.equal(referenceImageStale(before.shots[1], { ...stale, imageNeedsReview: false }), false);
});
