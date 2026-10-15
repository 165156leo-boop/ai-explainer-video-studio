import type { ExtractedCase, ImagePromptPackage, ScriptParagraph, Shot } from "./workbench-data";
import { inheritShotAssets, shotCaseId, shotVisualSignature } from "./media-workflow.ts";
import { buildImagePrompts, buildShotsFromCases, findContinuityReferenceShot, recalculateShotTimings } from "./shot-planning.ts";
import { videoPromptSourceSignature } from "./polish-digest.ts";

/** 分镜编辑、案例重建和加载迁移共用的画面词依赖，纯对白/时长不使静态画面作废。 */
export function imagePromptInputSignature(shot: Shot, shots: Shot[]): string {
  return JSON.stringify([
    shotVisualSignature(shot),
    shot.sourceItems?.map(item => item.type === "dialogue" ? item.performance_cue ?? "" : item.text),
    findContinuityReferenceShot(shots, shot.id)?.id ?? "",
  ]);
}

/** 保留未变提示词的完整对象；变化时只重建文字，旧图片留供人工复核，不伪造新签名。 */
export function reconcileImagePrompts(
  shots: Shot[], previousShots: Shot[], previousPrompts: ImagePromptPackage[],
): ImagePromptPackage[] {
  const oldShots = new Map(previousShots.map(shot => [shot.id, shot]));
  const oldPrompts = new Map(previousPrompts.map(prompt => [prompt.id, prompt]));
  return buildImagePrompts(shots).map(fallback => {
    const shot = shots.find(item => item.id === fallback.id)!;
    const previous = oldShots.get(shot.id);
    const saved = oldPrompts.get(previous?.referenceId ?? shot.id) ?? oldPrompts.get(shot.id);
    if (previous && saved && imagePromptInputSignature(shot, shots) === imagePromptInputSignature(previous, previousShots)) {
      return saved.id === shot.id && saved.title === shot.title
        ? saved : { ...saved, id: shot.id, title: shot.title };
    }
    if (!previous || !saved?.image) return fallback;
    return {
      ...fallback,
      image: saved.image,
      status: saved.status,
      mediaSource: saved.mediaSource,
      imageSourceSignature: saved.imageSourceSignature ?? shotVisualSignature(previous),
      imageNeedsReview: saved.imageNeedsReview,
    };
  });
}

function caseSourceSignature(item: ExtractedCase): string {
  return JSON.stringify([item.sourceIds, item.items?.map(row => ({ ...row, estimatedSeconds: undefined })), item.context]);
}

/** 只重新规划来源变化的案例，其他案例连人工拆分粒度也保留。 */
export function rebuildStoryboard(input: {
  cases: ExtractedCase[];
  paragraphs: ScriptParagraph[];
  previousCases: ExtractedCase[];
  previousShots: Shot[];
  previousPrompts: ImagePromptPackage[];
  speechRate: number;
  forceRebuild?: boolean;
}): { shots: Shot[]; prompts: ImagePromptPackage[] } {
  const shots = input.cases.flatMap(item => {
    const previousCase = input.previousCases.find(old => old.id === item.id);
    const previous = input.previousShots.filter(shot => shotCaseId(shot) === item.id);
    if (!input.forceRebuild && previous.length && previousCase && caseSourceSignature(item) === caseSourceSignature(previousCase)) {
      return previous;
    }
    const generated = buildShotsFromCases([item], input.paragraphs);
    const preserveEdits = !input.forceRebuild && previousCase?.context?.scene === item.context?.scene;
    return recalculateShotTimings(
      inheritShotAssets(generated, previous, { preserveEdits }).map(entry => entry.shot),
      input.speechRate,
    );
  });
  return { shots, prompts: reconcileImagePrompts(shots, input.previousShots, input.previousPrompts) };
}

/** 画面/对白改变才撤销分镜确认；仅时间参数改变只废弃本镜视频成果。 */
export function applyShotEdit(previous: Shot, updated: Shot): Shot {
  const contentChanged = shotVisualSignature(previous) !== shotVisualSignature(updated) || previous.dialogue !== updated.dialogue;
  const changed = videoPromptSourceSignature(previous) !== videoPromptSourceSignature(updated) || previous.videoModel !== updated.videoModel;
  return changed ? {
    ...updated,
    storyboardConfirmed: contentChanged ? false : updated.storyboardConfirmed,
    videoPromptPolished: undefined,
    videoLastFrame: undefined,
    videoLastFrameSignature: undefined,
  } : updated;
}

/** 所有分镜/参考图/尾帧写入的共同边界：只沿真实衔接关系传播，不按数组位置误伤独立镜头。 */
export function reconcileStoryboardDependencies(
  previousShots: Shot[], previousPrompts: ImagePromptPackage[],
  proposed: { shots: Shot[]; prompts: ImagePromptPackage[] },
) {
  const oldShots = new Map(previousShots.map(shot => [shot.id, shot]));
  const oldPrompts = new Map(previousPrompts.map(prompt => [prompt.id, prompt]));
  const roots = new Set(previousShots.filter(old => !proposed.shots.some(shot => shot.id === old.id)).map(shot => shot.id));
  const dependent = new Set<string>();
  let shots = proposed.shots.map(shot => {
    const old = oldShots.get(shot.id);
    if (!old) return shot;
    const edited = applyShotEdit(old, shot);
    const before = oldPrompts.get(old.referenceId ?? old.id);
    const after = proposed.prompts.find(prompt => prompt.id === (shot.referenceId ?? shot.id));
    const referenceChanged = before?.image !== after?.image || Boolean(before?.imageNeedsReview) !== Boolean(after?.imageNeedsReview) ||
      before?.imageSourceSignature !== after?.imageSourceSignature;
    const sourceChanged = findContinuityReferenceShot(previousShots, old.id)?.id !==
      findContinuityReferenceShot(proposed.shots, shot.id)?.id;
    if (sourceChanged) dependent.add(shot.id);
    if (edited !== shot || old.videoLastFrame !== shot.videoLastFrame || old.image !== shot.image || referenceChanged || sourceChanged) roots.add(shot.id);
    if (referenceChanged || sourceChanged) return { ...edited,
      videoPromptPolished: undefined, videoLastFrame: undefined, videoLastFrameSignature: undefined };
    return edited;
  });
  const affected = new Set(roots);
  // 固定点遍历也能处理显式引用及循环引用，最多每镜进入集合一次。
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const shot of shots) {
      if (dependent.has(shot.id)) continue;
      const source = findContinuityReferenceShot(shots, shot.id) ?? findContinuityReferenceShot(previousShots, shot.id);
      if (!source || !affected.has(source.id)) continue;
      affected.add(shot.id);
      dependent.add(shot.id);
      advanced = true;
    }
  }
  shots = shots.map(shot => dependent.has(shot.id) ? { ...shot, storyboardConfirmed: false,
    videoPromptPolished: undefined, videoLastFrame: undefined, videoLastFrameSignature: undefined } : shot);
  const prompts = proposed.prompts.map(prompt => dependent.has(prompt.id) ? { ...prompt,
    promptModel: undefined, imageNeedsReview: Boolean(prompt.image) } : prompt);
  return { shots, prompts, affectedIds: [...affected] };
}
