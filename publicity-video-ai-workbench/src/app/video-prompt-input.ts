import type { ImagePromptPackage, Shot } from "./workbench-data";
import { findContinuityReferenceShot } from "./shot-planning.ts";
import { referenceImageStale, shotVisualSignature } from "./media-workflow.ts";
import { matchReuseRules, parseCharacterBindingInstruction, type ReferenceAsset, type ReuseRule } from "./workspace-memory.ts";

export type VideoPromptSources = {
  sceneImage?: string;
  continuityShotId?: string;
  firstFrameReference: boolean;
  bindings: Array<{ sourceRole: string; targetRole: string }>;
  references: Array<{ roleName: string; characterName: string; image: string }>;
};

/** 衔接关系和可用素材分开：关系仍在，但待复核的上游不能继续提供旧图/尾帧。 */
export function resolveContinuityReference(shots: Shot[], prompts: ImagePromptPackage[], shotId: string) {
  const shot = findContinuityReferenceShot(shots, shotId);
  const draft = prompts.find(prompt => prompt.id === (shot?.referenceId ?? shot?.id));
  const usable = shot?.storyboardConfirmed === true && !referenceImageStale(shot, draft);
  const tailFrame = usable && shot?.videoLastFrame && (!shot.videoLastFrameSignature ||
    shot.videoLastFrameSignature === shotVisualSignature(shot)) ? shot.videoLastFrame : undefined;
  return { shot, tailFrame, image: usable ? tailFrame || draft?.image || shot?.image : undefined };
}

/** 与身份诊断、重润判定共用同一份真实输入，避免只签 shot.image 而漏掉尾帧与人物绑定。 */
export function resolveVideoPromptSources(shot: Shot, input: {
  shots: Shot[]; prompts: ImagePromptPackage[]; assets: ReferenceAsset[];
  rules: ReuseRule[]; projectId: string;
}): VideoPromptSources {
  const context = [shot.title, shot.location, shot.speaker, shot.dialogue, ...shot.action, shot.continuity].join(" ");
  const bindings = matchReuseRules(input.rules, { projectId: input.projectId, stage: "imagePrompt", text: context })
    .map(rule => parseCharacterBindingInstruction(rule.title) ?? parseCharacterBindingInstruction(rule.instruction))
    .filter((binding): binding is { sourceRole: string; targetRole: string } => Boolean(binding));
  const continuity = resolveContinuityReference(input.shots, input.prompts, shot.id);
  const previous = continuity.shot;
  const sceneImage = shot.image || input.prompts.find(prompt => prompt.id === (shot.referenceId ?? shot.id))?.image || continuity.tailFrame;
  const references = input.assets.flatMap(asset => {
    if (asset.kind !== "character" || !asset.image || !asset.roleName) return [];
    const binding = bindings.find(item => item.targetRole.replace(/\s+/gu, "") === asset.roleName!.replace(/\s+/gu, ""));
    if (!context.includes(asset.roleName) && !(binding && context.includes(binding.sourceRole))) return [];
    return [{ roleName: asset.roleName, characterName: binding?.sourceRole || asset.roleName, image: asset.image }];
  });
  return { sceneImage, references, bindings, continuityShotId: previous?.id, firstFrameReference: Boolean(previous) };
}
