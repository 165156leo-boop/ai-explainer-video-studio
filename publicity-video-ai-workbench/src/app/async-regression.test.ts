import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { PolishState } from "./polish-state.ts";
import { imagePromptInputSignature, reconcileStoryboardDependencies } from "./storyboard-workflow.ts";
import { videoPromptSourceSignature } from "./polish-digest.ts";
import { recalculateShotTiming, recalculateShotTimings, normalizeSpeechRate } from "./shot-planning.ts";
import { shotDisplayLabel } from "./media-workflow.ts";
import type { Shot, ImagePromptPackage } from "./workbench-data";

// Execute actual functions with simulated I/O, without loading Next or accounts.
function sourceFunction(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) result = `const ${node.getText(source)};`;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, `Missing function ${name}`);
  return ts.transpileModule(result.replace(/^export\s+/u, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const response = deferred<unknown>();
let displayed: unknown = "unchanged";
const context = vm.createContext({
  activeProjectId: "A", activeProjectRef: { current: "A" }, projectSessionRef: { current: 0 }, mediaRequestRef: { current: 0 },
  // 2026-09-25：中间会话给 page.tsx 加了登录态（authStatus 进入 refreshMediaJobs 的
  // useEffect 依赖），沙箱桩同步补上。
  authStatus: "authenticated",
  useCallback: (fn: unknown) => fn, fetch: () => response.promise,
  responseData: async (value: unknown) => value, setMediaJobs: (jobs: unknown) => { displayed = jobs; },
});
vm.runInContext(sourceFunction("./page.tsx", "refreshMediaJobs"), context);
const oldRequest = vm.runInContext("refreshMediaJobs()", context);
context.projectSessionRef.current++;
context.activeProjectRef.current = "B";
response.resolve({ jobs: [{ projectId: "A" }] });
await oldRequest;
assert.equal(displayed, "unchanged", "old project response must not replace current jobs");
context.mediaJobs = [{ projectId: "A", targetId: "same-shot", mediaType: "image" }, { projectId: "B", targetId: "same-shot", mediaType: "image" }];
context.activeProjectId = "B";
context.selectedMediaTargetId = "same-shot";
context.selectedMediaType = "image";
vm.runInContext(sourceFunction("./page.tsx", "selectedMediaJobs"), context);
assert.equal(vm.runInContext("selectedMediaJobs.length", context), 1);
assert.equal(vm.runInContext("selectedMediaJobs[0].projectId", context), "B");

const adoption = deferred<unknown>();
let commits = 0;
Object.assign(context, {
  candidateFile: async () => ({}), blobToDataUrl: async () => "data:image/png;base64,AA==",
  postMedia: () => adoption.promise, setMediaAction: () => {}, setMediaMessage: () => {},
  replaceMediaJob: () => {}, commitSelectedReference: () => { commits++; }, announce: () => {},
  job: { projectId: "B", mediaType: "image", targetId: "same-shot" }, candidate: { id: "candidate" },
  shotDraftsRef: { current: [{ id: "same-shot" }] }, latestVideoSignatureFor: () => "current",
});
vm.runInContext(sourceFunction("./page.tsx", "adoptMediaCandidate"), context);
const adopting = vm.runInContext("adoptMediaCandidate(job, candidate)", context);
await new Promise((done) => setImmediate(done));
context.projectSessionRef.current++;
context.activeProjectRef.current = "C";
adoption.resolve({ job: context.job });
await adopting;
assert.equal(commits, 0, "adoption must not write an image into the new project");

let saved: { candidates: Array<{ status: string }> } | undefined;
const media = vm.createContext({
  isRecord: (value: unknown) => value !== null && typeof value === "object",
  text: (value: unknown) => typeof value === "string" ? value : "",
  providerJson: async () => ({ data: [{}, {}] }),
  downloadCandidateResult: async (_job: unknown, _result: unknown, index: number) => {
    if (index === 1) throw new Error("download failed");
    return { filePath: "good.png", status: "pending" };
  },
  // 2026-09-25：中间会话引入登录体系，updateJob 签名变为 (ownerEmail, id, update)。
  updateJob: async (_owner: string, _id: string, update: (job: object) => typeof saved) => { saved = update({}); },
});
vm.runInContext(sourceFunction("./media-provider.ts", "candidateFromResult") + sourceFunction("./media-provider.ts", "runImageJob"), media);
await vm.runInContext('runImageJob({id:"job",referenceFiles:[]})', media);
assert.equal(saved?.candidates.length, 2);
assert.equal(saved?.candidates[0].status, "pending");
assert.equal(saved?.candidates[1].status, "rejected");

const storedJobs: Array<Record<string, unknown>> = [
  { id: "legacy", ownerEmail: "", projectId: "A", status: "queued" },
  { id: "running", ownerEmail: "user@example.com", projectId: "A", status: "running" },
  { id: "finished", ownerEmail: "user@example.com", projectId: "A", status: "succeeded" },
];
let jobWrites = 0;
const jobMaintenance = vm.createContext({
  writeQueue: Promise.resolve(),
  readStoredJobs: async () => storedJobs,
  mutateJobs: async (update: (jobs: typeof storedJobs) => boolean) => {
    jobWrites++;
    return update(storedJobs);
  },
  activeJobs: new Set<string>(),
  publicJob: (job: object) => job,
  Date,
});
vm.runInContext(
  sourceFunction("./media-provider.ts", "maintainMediaJobs") + sourceFunction("./media-provider.ts", "listMediaJobs"),
  jobMaintenance,
);
const listedBeforeMaintenance = await vm.runInContext('listMediaJobs("user@example.com", "A")', jobMaintenance);
assert.equal(listedBeforeMaintenance.length, 2, "列表只返回已有归属的当前用户任务");
assert.equal(jobWrites, 0, "GET 列表读取不得触发任务写入");
assert.equal(
  await vm.runInContext('maintainMediaJobs("user@example.com")', jobMaintenance),
  true,
  "显式维护入口必须报告已处理遗留任务",
);
assert.equal(jobWrites, 1, "维护入口只进行一次串行任务写入");
assert.equal(storedJobs[0].ownerEmail, "user@example.com", "遗留任务必须迁移到当前用户");
assert.equal(storedJobs[0].status, "failed", "迁移后的孤儿排队任务必须失败化");
assert.equal(storedJobs[1].status, "failed", "Provider 重启遗留的运行任务必须失败化");
assert.equal(storedJobs[1].errorCode, "LOCAL_PROVIDER_RESTARTED");
assert.equal(
  await vm.runInContext('maintainMediaJobs("user@example.com")', jobMaintenance),
  false,
  "已收敛的维护入口不得重复写入",
);
assert.equal(jobWrites, 1, "已收敛的维护入口不得重复写盘");
console.log("project isolation, partial candidate failure, and media maintenance checks passed");

// 等待润色的点击必须调用已经渲染的新稿提交函数，不能恢复最初捕获的旧闭包。
for (const switched of [false, true]) {
  const polish = deferred<{ ok: boolean }>();
  let oldSubmissions = 0;
  let freshSubmissions = 0;
  const submit = vm.createContext({
    mediaSubmitBlocker: "", mediaPolishPending: true,
    selectedMediaType: "video", selectedMediaTargetId: "shot-1",
    selectedImagePrompt: { id: "shot-1" }, selected: { id: "shot-1" },
    polishStateRef: { current: { hasWaiters: () => false, reset: () => {} } },
    projectSessionRef: { current: 1 }, awaitPolish: () => polish.promise,
    setUnpolishedEscape: () => {}, setPendingMediaElapsed: () => {}, setPendingMediaSubmit: () => {},
    expectAutoPolish: () => {}, queueVideoPromptPolish: () => {}, announce: () => {},
    createSelectedMediaJob: async () => { oldSubmissions++; },
    latestMediaSubmitRef: { current: { targetId: "shot-1", run: async () => { oldSubmissions++; } } },
  });
  vm.runInContext(sourceFunction("./page.tsx", "handleGenerateClick"), submit);
  const pending = vm.runInContext("handleGenerateClick()", submit);
  submit.latestMediaSubmitRef.current = {
    targetId: switched ? "shot-2" : "shot-1",
    run: async () => { freshSubmissions++; },
  };
  polish.resolve({ ok: true });
  await pending;
  assert.equal(oldSubmissions, 0, "等待后不得提交旧稿");
  assert.equal(freshSubmissions, switched ? 0 : 1, "切换镜头则取消；仍在本镜则用最新稿提交");
}
console.log("polish wait uses committed current content and cancels on selection change");

function workflowSandbox() {
  const shot: Shot = { id: "S1-E1-01", caseId: "S1-E1", referenceId: "S1-E1-01", title: "测试", chapter: "测试",
    speaker: "小陈", location: "办公室", dialogue: "小陈：“请核对凭证。”", action: ["小陈打开凭证"], continuity: "独立开场",
    estimatedSeconds: 10, storyboardConfirmed: true, videoLastFrame: "tail", status: "missing",
    prompt: { reference: "图", action: "打开凭证", dialogue: "自然", constraints: "不改对白" } };
  let shots: Shot[] = [shot, { ...shot, id: "S1-E1-02", referenceId: "S1-E1-02", continuity: "接续上一镜" },
    { ...shot, id: "S2-E1-01", caseId: "S2-E1", referenceId: "S2-E1-01" }];
  let prompts: ImagePromptPackage[] = shots.map(s => ({ id: s.id, title: s.title, prompt: "原画面词", status: "missing" }));
  const pending = deferred<ImagePromptPackage[]>();
  let running: Promise<void> | undefined;
  let active: string[] = [];
  let history: unknown[] = [];
  const sandbox: vm.Context = vm.createContext({
    aiConfiguration: { configured: true }, projectSessionRef: { current: 1 }, activeProjectRef: { current: "p" }, activeProjectId: "p",
    polishStateRef: { current: new PolishState() }, videoPromptAutoPolishRef: { current: new Map() },
    shotDrafts: shots, shotDraftsRef: { current: shots }, imagePromptDrafts: prompts, imagePromptDraftsRef: { current: prompts },
    selected: shot, selectedId: shot.id, selectedImagePrompt: prompts[0], selectedDisplayLabel: "测试镜头", currentStage: "videoPrompt", speechRate: 5.5,
    reuseRules: [], referenceAssets: [], projectHistory: history, batchRuleDraft: "小陈沿用审计员A形象", batchRuleInFlightRef: { current: false },
    setShotDrafts: (update: Shot[] | ((s: Shot[]) => Shot[])) => { shots = typeof update === "function" ? update(shots) : update; sandbox.shotDrafts = shots; },
    setImagePromptDrafts: (update: ImagePromptPackage[] | ((p: ImagePromptPackage[]) => ImagePromptPackage[])) => { prompts = typeof update === "function" ? update(prompts) : update; sandbox.imagePromptDrafts = prompts; },
    setImagePromptPolishingIds: (update: (ids: string[]) => string[]) => { active = update(active); },
    setVideoPromptPolishingIds: () => {}, setUploadedNames: () => {}, setSelectedId: () => {}, setSelectedImagePromptId: () => {},
    setSpeechRate: () => {}, setWorkflowStage: () => {}, announce: () => {}, abandonAutoPolish: () => {},
    settlePolishWaiters: (kind: "image" | "video", id: string, result: { ok: boolean }) => sandbox.polishStateRef.current.settle(kind, id, result),
    reconcileStoryboardDependencies, imagePromptInputSignature, videoPromptSourceSignature,
    recalculateShotTiming, recalculateShotTimings, normalizeSpeechRate, speechRateLabel: String, shotDisplayLabel,
    requestPolishedImagePrompts: () => pending.promise,
    imagePromptPolishLaneRef: { current: { enqueue: ({ run }: { run: () => Promise<void> }) => { running = run(); } } },
    appendRulesToPrompt: (prompt: string) => `${prompt}\n新规则`, cleanImagePromptForProvider: (s: string) => s,
    setProjectHistory: (update: (h: unknown[]) => unknown[]) => { history = update(history); sandbox.projectHistory = history; },
    createProjectId: () => "id", recordRuleDecision: async () => ({ rules: [] }), saveReferenceAsset: async () => ({ rules: [], assets: [] }),
    saveReuseRule: async () => ({ rules: [], assets: [] }), setReuseRules: () => {}, setReferenceAssets: () => {},
    setBatchRuleLoading: () => {}, setBatchRuleResult: () => {}, matchingKeywords: () => ["小陈"],
    parseCharacterBindingInstruction: () => ({ sourceRole: "小陈", targetRole: "审计员A" }),
    isRejectedPolishError: () => false,
  });
  for (const name of ["invalidateImagePromptPolish", "applyStoryboardWork", "updateImagePrompts", "beginImagePromptRewrite",
    "queueImagePromptPolish", "applyImageRule", "applyCharacterAsset", "applyBatchProductionRule",
    "applyVideoDuration", "applyProjectSpeechRate", "applyShotSpeechRate", "applySpeechRateRule"]) {
    vm.runInContext(sourceFunction("./page.tsx", name), sandbox);
  }
  return { sandbox, pending, get shots() { return shots; }, get prompts() { return prompts; }, get running() { return running; } };
}

for (const edit of [
  "applyImageRule({id:'rule',title:'规则',instruction:'要求'})",
  "applyCharacterAsset({id:'asset',roleName:'小陈',usageCount:0})",
  "applyBatchProductionRule()",
  "updateImagePrompts(current => current.map((p,i) => i ? p : {...p,prompt:'人工新稿',promptModel:undefined}))",
]) {
  const env = workflowSandbox();
  vm.runInContext("queueImagePromptPolish(selected, selectedImagePrompt)", env.sandbox);
  await vm.runInContext(edit, env.sandbox);
  const edited = env.prompts[0].prompt;
  assert.notEqual(edited, "原画面词", edit);
  env.pending.resolve([{ id: env.shots[0].id, title: "测试", prompt: "迟到的旧模型稿", promptModel: "model", status: "missing" }]);
  await env.running;
  assert.equal(env.prompts[0].prompt, edited, `${edit} 不能被旧润色结果覆盖`);
}

for (const command of ["applyVideoDuration('15')", "applyShotSpeechRate('7.2')", "applySpeechRateRule({id:'rate',speechRate:7.2})", "applyProjectSpeechRate(7.2)"]) {
  const env = workflowSandbox();
  await vm.runInContext(command, env.sandbox);
  assert.equal(env.shots[0].storyboardConfirmed, true, command);
  assert.equal(env.shots[0].videoLastFrame, undefined, command);
  assert.equal(env.shots[1].storyboardConfirmed, false, `${command} 必须更新关联续镜`);
  assert.equal(env.shots[2].storyboardConfirmed, true, `${command} 不得撤销独立镜头的画面确认`);
  if (!command.startsWith("applyProject")) assert.equal(env.shots[2].videoLastFrame, "tail", command);
}

for (const changed of [false, true]) {
  const env = workflowSandbox();
  const rewrite = deferred<object>();
  const messages: string[] = [];
  Object.assign(env.sandbox, {
    uploadedNames: {}, candidateMatchesSelectedImage: () => false,
    requestImageRetry: () => rewrite.promise,
    setMediaAction: () => {}, setMediaMessage: (message: string) => messages.push(message), setMediaFeedbackProgress: () => {},
    postMedia: async () => ({ id: "job", candidates: [] }), replaceMediaJob: () => {},
    IMAGE_RETRY_FEEDBACK_TYPE: "feedback", mediaFeedbackSource: () => "source",
    setPendingMediaRejection: () => {}, setMediaRejectionReason: () => {},
  });
  vm.runInContext(sourceFunction("./page.tsx", "rejectMediaCandidate"), env.sandbox);
  const pendingFeedback = vm.runInContext("rejectMediaCandidate({id:'job',projectId:'p',targetId:selected.id,mediaType:'image'},{id:'candidate'},'改衣服')", env.sandbox);
  if (changed) await vm.runInContext("applyImageRule({id:'rule',title:'规则',instruction:'新要求'})", env.sandbox);
  const beforeReturn = env.prompts[0].prompt;
  rewrite.resolve({ prompt: "反馈重写稿", textModel: "text", visionModel: "vision", review: {} });
  await pendingFeedback;
  assert.equal(env.prompts[0].prompt, changed ? beforeReturn : "反馈重写稿", "反馈只能更新仍匹配的输入版本");
  if (changed) assert.ok(messages.some(message => message.includes("未覆盖")));
}

for (const switchProject of [false, true]) {
  const env = workflowSandbox();
  const save = deferred<object>();
  env.sandbox.saveReuseRule = () => save.promise;
  const pendingBatch = vm.runInContext("applyBatchProductionRule()", env.sandbox);
  vm.runInContext("updateImagePrompts(current => current.map((p,i) => i ? p : {...p,prompt:'等待中手改'}))", env.sandbox);
  if (switchProject) env.sandbox.projectSessionRef.current++;
  save.resolve({ rules: [], assets: [] });
  await pendingBatch;
  assert.equal(env.prompts[0].prompt, switchProject ? "等待中手改" : "等待中手改\n新规则", "批量规则应增量应用于当前稿，不得回填等待前快照或串项目");
}

{
  const env = workflowSandbox();
  const timers: Array<() => void> = [];
  let requests = 0;
  Object.assign(env.sandbox, {
    window: { setTimeout: (run: () => void) => timers.push(run) }, POLISH_RETRY_DELAYS_MS: [1, 2],
    requestPolishedImagePrompts: async () => { requests++; throw new Error("temporary"); },
  });
  vm.runInContext("queueImagePromptPolish(selected, selectedImagePrompt)", env.sandbox);
  await env.running;
  assert.equal(timers.length, 1);
  await vm.runInContext("applyImageRule({id:'rule',title:'规则',instruction:'新要求'})", env.sandbox);
  timers[0]();
  assert.equal(requests, 1, "素材改变后，旧失败请求的定时重试必须作废");
}

// 架构门禁：今后新增日常修改入口不得绕过共同写入边界。加载与整份脚本替换单独重置生命周期。
const pageSource = ts.createSourceFile("page.tsx", readFileSync(new URL("./page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function checkWrites(node: ts.Node, owner = "") {
  if (ts.isVariableDeclaration(node) && ["applyProjectSnapshot", "handleScriptUpload", "applyStoryboardWork"].includes(node.name.getText(pageSource))) owner = node.name.getText(pageSource);
  if (ts.isCallExpression(node) && ["setShotDrafts", "setImagePromptDrafts"].includes(node.expression.getText(pageSource))) {
    assert.ok(owner, `直接写入绕过共同边界: ${node.getText(pageSource).slice(0, 100)}`);
  }
  ts.forEachChild(node, child => checkWrites(child, owner));
}
checkWrites(pageSource);
console.log("all prompt-edit and timing entry points share invalidation; independent shots stay confirmed");
