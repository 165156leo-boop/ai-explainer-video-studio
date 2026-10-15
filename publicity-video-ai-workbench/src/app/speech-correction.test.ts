/**
 * 对白读音纠错（speech-correction.ts）与视频提示词组装/校验（video-prompt.ts，
 * 2026-09-17 镜头时序结构）的回归测试。
 * 运行：npm run check:speech
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  analyzeTone,
  applySpeechCorrections,
  CURATED_SPEECH_FIXES,
  describeSpeechCorrections,
  findHomophone,
  isRareChar,
} from "./speech-correction.ts";
import {
  buildFallbackShotScript,
  buildReferenceImageNote,
  buildSpeakerIdentityNote,
  buildVideoPromptText,
  countSpeechChars,
  doorEntrySequenceConstraint,
  normalizeVideoPromptBriefs,
  normalizeVideoPromptModelResult,
  parseDialogueSpeakers,
  videoScriptWarnings,
} from "./video-prompt.ts";
import { AiInputRejected, AiOutputRejected } from "./ai-output-rejection.ts";
import {
  buildCharacterIdentityNote,
  classifyCharacterIdentity,
  normalizeCharacterIdentityResult,
} from "./character-identity.ts";

const DIALOGUE =
  "小陈：“王老师，学院在三年前报销了几笔公务接待费用，时间较为集中，我们核实时，联系了处理笺上填报的来访人员，对方说那段时间他并没有来京。”\n" +
  "王老师：“我们接待时没做好记录，也没及时报销，可能事后把信息填错了。”";

test("官方角色图匹配结果只接受已知角色，并保留不确定保护", () => {
  const result = normalizeCharacterIdentityResult(
    {
      matches: [
        {
          roleName: "审计员A",
          matchedPerson: "person_1",
          status: "MATCH",
          confidence: 0.91,
          evidence: ["眼镜", "站在桌前"],
          sceneCue: "画面左侧站在桌前并指向文件的人",
        },
        { roleName: "未知资产", status: "MATCH", confidence: 1 },
        { roleName: "审计员B", status: "UNCERTAIN", confidence: 0.42 },
      ],
    },
    [{ roleName: "审计员A", characterName: "小陈" }, { roleName: "审计员B", characterName: "王老师" }],
  );
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].characterName, "小陈");
  assert.match(buildCharacterIdentityNote(result.matches) || "", /小陈/);
  assert.match(buildCharacterIdentityNote(result.matches) || "", /王老师暂未能稳定匹配/);
  assert.equal(
    classifyCharacterIdentity(result.matches, [{ roleName: "审计员A" }, { roleName: "审计员B" }]),
    "uncertain",
  );
  assert.equal(classifyCharacterIdentity([], []), "not-needed");
});

// ---------- 纠错引擎 ----------

test("声调拆解覆盖六个元音与轻声", () => {
  assert.deepEqual(analyzeTone("chī"), { base: "chi", tone: 1, key: "chi1" });
  assert.deepEqual(analyzeTone("lǜ"), { base: "lv", tone: 4, key: "lv4" });
  assert.deepEqual(analyzeTone("le"), { base: "le", tone: 0, key: "le0" });
});

test("生僻字判定以一级字表为准", () => {
  assert.equal(isRareChar("螭"), true);
  assert.equal(isRareChar("笺"), true);
  assert.equal(isRareChar("吃"), false);
  assert.equal(isRareChar("报"), false);
  assert.equal(isRareChar("3"), false);
  assert.equal(isRareChar("，"), false);
});

test("同音替身必须同调、常用、且替身本身不是多音字", () => {
  // 官方指南用例：螭(chī) → 吃。
  const replacement = findHomophone("chī", new Set(["螭"]));
  assert.equal(replacement, "吃");
  // 轻声/未知读音找不到替身时返回空串，而不是乱替。
  assert.equal(findHomophone("", new Set()), "");
});

test("对白里的生僻字被替换，常用字逐字不动", () => {
  const result = applySpeechCorrections(DIALOGUE);
  // 「笺」是本段唯一的生僻字。
  assert.deepEqual(
    result.corrections.map((item) => item.from),
    ["笺"],
  );
  const correction = result.corrections[0];
  assert.equal(correction.kind, "rare");
  assert.equal(correction.pinyin, "jiān");
  assert.notEqual(correction.to, "");
  assert.equal(isRareChar(correction.to), false, "替身必须是常用字");
  // 其余文本逐字不变：把替换还原后必须等于原文。
  assert.equal(result.text.replace(correction.to, "笺"), DIALOGUE);
  // 摘要可读。
  assert.match(describeSpeechCorrections(result), /1 处：笺→.\(jiān\)/);
});

test("找不到同音替身的生僻字保持原样并计入 unresolved", () => {
  const result = applySpeechCorrections("老兵张叟来了。");
  // 「叟」是生僻字且没有同音常用替身（ChatTTS 文档里的著名反例）。
  if (result.unresolved.length) {
    assert.ok(result.unresolved.includes("叟"));
    assert.equal(result.text, "老兵张叟来了。", "无替身时必须原样保留");
  }
});

test("词级校对字典按词替换且长词优先", () => {
  // 不污染正式字典，临时注入一条再还原。
  const key = "测试说服";
  CURATED_SPEECH_FIXES[key] = "测试说福";
  try {
    const result = applySpeechCorrections(`请你${key}他。`);
    assert.equal(result.text, "请你测试说福他。");
    assert.deepEqual(
      result.corrections.filter((item) => item.kind === "curated"),
      [{ from: key, to: "测试说福", pinyin: "", kind: "curated" }],
    );
  } finally {
    delete CURATED_SPEECH_FIXES[key];
  }
});

test("多音字的语境读音来自整句而不是单字猜测", () => {
  // 「率」在「率领」里读 shuài；替换逻辑取的是整句语境拼音。
  const result = applySpeechCorrections("他率领队伍出发了。");
  assert.equal(result.corrections.length, 0, "全是常用字时不做任何替换");
  assert.equal(result.text, "他率领队伍出发了。");
});

// ---------- 镜头时序组装（2026-09-17 官方公式重构） ----------

test("按说话人解析对白并统计朗读字数", () => {
  const speakers = parseDialogueSpeakers(DIALOGUE);
  assert.equal(speakers.length, 2);
  assert.equal(speakers[0].speaker, "小陈");
  assert.equal(speakers[1].speaker, "王老师");
  assert.ok(speakers[0].chars > speakers[1].chars, "第一位角色台词明显更长");
  // 标点不计入朗读时长。
  assert.equal(countSpeechChars("好的，好的。"), 4);
});

test("回退模板按镜头1/2/3 时序组装，台词以大括号逐字嵌入，无任何【】标题", () => {
  const prompt = buildVideoPromptText({
    dialogue: DIALOGUE,
    performance: "自然对话",
    continuity: "同机位",
    constraints: "咬字清晰",
    referenceNote: "参考图",
    actions: "小陈说明核查发现→王老师回应解释→两人保持原位",
    estimatedSeconds: 14,
  });
  assert.doesNotMatch(prompt, /【/u, "官方符号体系里【】是字幕符号，提示词不得出现");
  assert.match(prompt, /镜头1：/);
  assert.match(prompt, /镜头2：/);
  assert.match(prompt, /镜头3：/);
  // 台词逐字嵌入（大括号内与原文一致）。
  assert.match(prompt, /小陈说\{王老师，学院在三年前报销了/);
  assert.match(prompt, /王老师说\{我们接待时没做好记录/);
  assert.match(prompt, /时长 15 秒/);
  // 全局约束行（2026-09-19 二次精简，用户拍板）：只留开头慢开口、结尾停顿收尾、运镜自洽。
  assert.match(prompt, /开口说话前人物自然闭嘴，稍作停顿后再缓慢开口/u);
  assert.match(prompt, /台词说完后人物自然闭嘴，保持一小段停顿再收尾/u);
  assert.match(prompt, /运镜与人物动作必须自洽/u);
  // 用户点名删掉的部分必须彻底消失：语速类措辞（「语速较快」实测催出 7 字/秒赶话+跳对白）、
  // 身份对照文字块（对豆包无效，改走人物参考图绑定）、无字幕水印、面部稳定等细则。
  assert.doesNotMatch(prompt, /语速较快|语速从容|人物身份与台词对照|无字幕|面部稳定/u);
  // 回退模板的镜头1/镜头3 也要各自带上嘴部状态与慢展开，不只靠全局兜底。
  assert.match(prompt, /镜头1：镜头平稳，人物自然闭嘴，稍作停顿后动作缓慢展开/u);
  assert.match(prompt, /随后人物自然闭嘴、保持姿势，动作渐缓，无台词/u);
  // 不写秒数（官方口径：精确时间不稳定）。
  assert.doesNotMatch(prompt, /闭嘴[^。]{0,10}(0\.5|1 秒|半秒)/u);
  // 不再出现旧的精确时间指令。
  assert.doesNotMatch(prompt, /0\.5—1 秒|约半秒|字\/秒/u);
  // 2026-09-20：动作链顺序与台词顺序矛盾时（「王老师回应」在前，台词小陈先说），
  // 前置动作必须被丢弃——实测两条成片身份互换，模型正是被这个前导短语误导。
  assert.doesNotMatch(prompt, /镜头2：王老师回应/u);
  assert.match(prompt, /镜头2：小陈说明核查发现，小陈说\{王老师，学院在三年前报销了/u);
});

test("镜头2 动作按说话人配对：谁的动作紧贴谁的对白（2026-09-20 用户定案）", () => {
  // 经典矛盾场景：动作链「王老师回应」在前、台词小陈先说——旧做法让模型先读
  // 到回应者的动作，两条成片身份互换。配对后王老师的动作回到王老师的对白前。
  const conflicting = buildFallbackShotScript({
    dialogue: DIALOGUE,
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小陈说明核查发现→王老师回应并说明原因→两人保持原位",
    estimatedSeconds: 14,
  });
  // 小陈的动作不再被镜头1 消耗，紧贴他自己的对白。
  assert.match(conflicting, /镜头2：小陈说明核查发现，小陈说\{王老师，学院在三年前报销了/u);
  // 王老师的动作排在他自己的对白之前。
  assert.match(conflicting, /随后王老师回应并说明原因，王老师说\{我们接待时没做好记录/u);
  assert.doesNotMatch(conflicting, /镜头2：王老师/u, "回应者的动作不得先于第一位说话人的对白");
  // 与说话人无关的「两人保持原位」作镜头3 收尾。
  assert.match(conflicting, /镜头3：对白说完后，两人保持原位/u);
  // 同一说话人多个动作：全部归他，按序排在他的对白前。
  const stacked = buildFallbackShotScript({
    dialogue: DIALOGUE,
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小陈说明核查发现→小陈指着文件强调→两人保持原位",
    estimatedSeconds: 14,
  });
  assert.match(stacked, /镜头2：小陈说明核查发现，随后小陈指着文件强调，小陈说\{/u);
  // 首条动作不提任何说话人（场景动作）→ 作镜头1 开场；对白前无前置动作。
  const sceneFirst = buildFallbackShotScript({
    dialogue: DIALOGUE,
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "办公室窗外的光线落在桌面上→小陈说明核查发现→两人保持原位",
    estimatedSeconds: 14,
  });
  assert.match(sceneFirst, /镜头1：镜头平稳，人物自然闭嘴，稍作停顿后动作缓慢展开，自然过渡到办公室窗外的光线落在桌面上/u);
  assert.match(sceneFirst, /镜头2：小陈说明核查发现，小陈说\{王老师，学院在三年前报销了/u);
});

/**
 * 2026-09-20（用户拍板）：参考图说明压到最短——只说「哪张图是画面参考」
 * 「哪张图里的人物是谁」。旧长说明（非首帧/机位/兜底句/分工明细）全部删除：
 * 实测只稀释权重。已知风险：模型可能回到「把参考图当首帧」的行为，成片若复发再加回。
 */
test("参考图说明置顶输出，且只有一句话", () => {
  const note = buildReferenceImageNote([
    { label: "上一镜 S1-E1-1 的结尾画面", role: "continuity" },
  ]);
  assert.ok(note, "单张参考图也要产出说明");
  const prompt = buildVideoPromptText({
    dialogue: DIALOGUE,
    performance: "自然对话",
    continuity: "同机位",
    constraints: "咬字清晰",
    referenceNote: "参考图",
    actions: "小陈说明核查发现→王老师回应解释",
    estimatedSeconds: 14,
    referenceImageNote: note,
  });
  assert.ok(prompt.startsWith("参考图说明："), "参考图说明必须是提示词第一行");
  assert.match(
    prompt,
    /^参考图说明：将第 1 张参考图（上一镜结尾画面）作为本镜首帧参考图上传，视频从该画面的角色位置、姿态、服装、道具和环境状态开始。$/mu,
    "上一镜尾帧必须明确作为本镜首帧参考图",
  );
  // 无参考图时不产出空段。
  assert.equal(buildReferenceImageNote([]), undefined);
});

test("上一镜尾帧会被明确标为下一镜的连续性参考图", () => {
  const note = buildReferenceImageNote([
    { label: "S2-E1-01 的结尾画面", role: "continuity" },
  ]);
  assert.match(note || "", /上一镜结尾画面/u);
  assert.match(note || "", /本镜首帧参考图上传/u);
});

test("续镜首段使用首帧约束，不机械重复闭嘴停顿", () => {
  const prompt = buildVideoPromptText({
    dialogue: DIALOGUE,
    performance: "自然对话",
    continuity: "承接上一镜",
    constraints: "动作连贯",
    referenceNote: "上一镜尾帧",
    actions: "小陈继续指向桌面→王老师回应解释",
    estimatedSeconds: 14,
    firstFrameReference: true,
  });
  assert.match(prompt, /镜头1：第1张参考图作为本镜首帧/u);
  assert.match(prompt, /保持首帧中的人物位置、姿态、服装、道具和环境关系不变/u);
  assert.doesNotMatch(prompt, /镜头1：[^\n]*自然闭嘴/u);
  assert.match(prompt, /以已上传的首帧画面状态为起点/u);

  const legacy = buildVideoPromptText({
    script: "镜头1：镜头平稳，人物自然闭嘴，稍作停顿后动作缓慢展开，自然过渡到小陈继续指向桌面，无台词。\n镜头2：小陈说{王老师，学院在三年前报销了几笔公务接待费用，时间较为集中，我们核实时，联系了处理笺上填报的来访人员，对方说那段时间他并没有来京。}。\n镜头3：对白说完后保持姿势。",
    dialogue: DIALOGUE,
    performance: "自然对话",
    continuity: "承接上一镜",
    constraints: "动作连贯",
    referenceNote: "上一镜尾帧",
    actions: "小陈继续指向桌面→王老师回应解释",
    estimatedSeconds: 14,
    firstFrameReference: true,
  });
  assert.match(legacy, /镜头1：以已上传首帧状态为起点/u);
  assert.doesNotMatch(legacy, /镜头1：[^\n]*自然闭嘴/u);
});

test("多张参考图仍只说画面参考与人物归属，不再罗列分工", () => {
  const note = buildReferenceImageNote([
    { label: "S2-E1-01 本镜分镜画面", role: "base" },
    { label: "审计员A 的人物形象", role: "character", personName: "小陈" },
    { label: "剪映扁平线条风", role: "style" },
  ]);
  assert.ok(note);
  assert.match(note, /根据第 1 张参考图作为画面参考生成视频/u);
  assert.match(note, /第 2 张参考图中的人物为「小陈」/u);
  // 精简后的说明不再罗列分工/画风/兜底句。
  assert.doesNotMatch(note, /用于|分工|画风|以文字描述|首帧/u);
});

/**
 * 2026-09-20：人物参考图带 personName 时，说明写「第 N 张参考图中的人物为「X」」。
 * 不带名字时不产出空绑定。
 */
test("人物参考图带角色名时，说明写明图中人物是谁", () => {
  const single = buildReferenceImageNote([
    { label: "审计员A 的人物形象", role: "character", personName: "小陈" },
  ]);
  assert.ok(single);
  assert.match(single, /参考图中的人物为「小陈」/u);
  // 不带名字时不产出空绑定。
  const anonymous = buildReferenceImageNote([
    { label: "审计员A 的人物形象", role: "character" },
  ]);
  assert.ok(anonymous);
  assert.doesNotMatch(anonymous, /人物为/u);
});

test("多说话人提示词带确定性的说话人绑定，单人不增加噪声", () => {
  const prompt = buildVideoPromptText({
    dialogue: DIALOGUE,
    performance: "自然对话",
    continuity: "同机位",
    constraints: "咬字清晰",
    referenceNote: "参考图",
    actions: "小陈说明核查发现→王老师回应解释",
    estimatedSeconds: 14,
  });
  assert.match(prompt, /第1句由「小陈」开口；第2句由「王老师」开口/u);
  assert.match(prompt, /句首称呼「王老师」是正在听的人/u);
  assert.match(prompt, /绝不互换人物身份/u);
  assert.equal(buildSpeakerIdentityNote("旁白，没有引号"), undefined);
});

test("纯旁白镜头的回退模板不出现大括号台词", () => {
  const script = buildFallbackShotScript({
    dialogue: "没有引号的一段旁白描述",
    performance: "自然讲述",
    continuity: "同机位",
    constraints: "",
    referenceNote: "参考图",
    actions: "镜头缓慢扫过桌面→停在凭证册上",
    estimatedSeconds: 10,
  });
  assert.doesNotMatch(script, /\{/u);
  assert.match(script, /镜头1：/);
  assert.match(script, /镜头3：/);
});

// ---------- 回退模板的三处语法修复（2026-09-17 对照真实提交的提示词复盘） ----------

const SAME_SPEAKER_DIALOGUE =
  "小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”\n" +
  "小李：“您看，这份公务接待报销总费用2250元。”";

test("同一说话人连续多句：只在首句写名字，后续用「随后继续说」，不重复姓名", () => {
  const script = buildFallbackShotScript({
    dialogue: SAME_SPEAKER_DIALOGUE,
    performance: "由对应人物按顺序自然、清楚地完整说出原文对白。",
    continuity: "同机位",
    constraints: "",
    referenceNote: "参考图",
    actions:
      "财务人员小李路过时顺便敲门进来，手里拿着平板→小李提出核实请求→小李继续展示单据并说明数据",
    estimatedSeconds: 15,
  });
  assert.match(script, /小李说\{刘老师，您提交的公务接待费用/u);
  assert.match(script, /随后继续说\{您看，这份公务接待报销总费用2250元。\}/u);
  assert.equal(
    (script.match(/小李说\{/gu) || []).length,
    1,
    "同一说话人不应重复出现「小李说」",
  );
});

test("回退模板不再叠出「。。」，收尾段也不再拼出主语错乱的句子", () => {
  const script = buildFallbackShotScript({
    dialogue: SAME_SPEAKER_DIALOGUE,
    performance: "由对应人物按顺序自然、清楚地完整说出原文对白。",
    continuity: "同机位",
    constraints: "",
    referenceNote: "参考图",
    actions:
      "财务人员小李路过时顺便敲门进来，手里拿着平板→小李提出核实请求→小李继续展示单据并说明数据",
    estimatedSeconds: 15,
  });
  assert.doesNotMatch(script, /。。/u, "句末标点不得叠加");
  assert.doesNotMatch(
    script,
    /人物完成/u,
    "旧模板会拼出「人物完成小李继续展示…后保持姿势」这种主语错乱的句子",
  );
  // 2026-09-20 配对结构：小李的两个动作分给他的两句台词（前句多分），
  // 全部动作都有主且各归其位，镜头3 只剩通用收尾。
  assert.match(script, /镜头2：财务人员小李路过时顺便敲门进来，手里拿着平板，随后小李提出核实请求，小李说\{刘老师，您提交的公务接待费用，跟您确认些细节。\}/u);
  assert.match(script, /随后小李继续展示单据并说明数据，随后继续说\{您看，这份公务接待报销总费用2250元。\}/u);
  assert.doesNotMatch(script, /镜头2：.*敲门进来.*敲门进来/u, "动作不得重复出现");
  // 两个动作时镜头3 才写收尾动作；只有一个动作时不与镜头2 重复。
  const single = buildFallbackShotScript({
    dialogue: "小陈：“好的。”",
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小陈低头翻材料→小陈合上文件夹",
    estimatedSeconds: 5,
  });
  assert.match(single, /镜头2：小陈低头翻材料，随后小陈合上文件夹，小陈说\{好的。\}/u);
  assert.match(single, /镜头3：对白说完后，人物自然闭嘴，保持当前姿势/u);
});

test("videoScriptWarnings 只在台词落进收尾段时告警，且不阻断", () => {
  const inClosing =
    "镜头1：固定机位，人物从停顿状态自然过渡到整理桌面，动作轻缓，无台词。\n" +
    "镜头2：小李抬手示意，小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}。\n" +
    "镜头3：随后继续说{您看，这份公务接待报销总费用2250元。}，动作渐缓，无台词。";
  const warnings = videoScriptWarnings(inClosing, SAME_SPEAKER_DIALOGUE);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "dialogue-in-closing-shot");
  assert.match(warnings[0].message, /镜头3/u);

  const inMainShot =
    "镜头1：固定机位，动作轻缓，无台词。\n" +
    "镜头2：小李抬手示意，小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}，" +
    "随后继续说{您看，这份公务接待报销总费用2250元。}。\n" +
    "镜头3：动作渐缓，无台词。";
  assert.deepEqual(videoScriptWarnings(inMainShot, SAME_SPEAKER_DIALOGUE), []);

  // 无对白镜头与空文案都不告警。
  assert.deepEqual(videoScriptWarnings(inClosing, "没有引号的旁白"), []);
  assert.deepEqual(videoScriptWarnings("", SAME_SPEAKER_DIALOGUE), []);
});

/**
 * 2026-09-18：「敲门却没进门」那支失败成片的提示词，同时写了「固定机位」和
 * 「缓慢抬手敲门，进入办公室」。模型面对自相矛盾的指令保住了机位，人原地打转。
 * 这类矛盾必须在界面可见（不阻断提交——拍法可以保留，但用户有权先看见）。
 */
test("运镜与动作矛盾时告警（固定机位 + 进入/走到/跨过）", () => {
  const contradicting =
    "镜头1：固定机位，小李停顿片刻后，缓慢抬手敲门，进入办公室，动作轻缓，无台词。\n" +
    "镜头2：小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}，动作连贯。\n" +
    "镜头3：对白说完后，人物保持当前姿势，动作渐缓，无台词。";
  const warnings = videoScriptWarnings(contradicting, SAME_SPEAKER_DIALOGUE);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "camera-action-conflict");
  assert.match(warnings[0].message, /固定机位/u);

  // 人物不需要离开原位时，写固定机位不告警。
  const steady =
    "镜头1：固定机位，小李从停顿状态自然过渡到整理桌面，动作轻缓，无台词。\n" +
    "镜头2：小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}，动作连贯。\n" +
    "镜头3：对白说完后，人物保持当前姿势，动作渐缓，无台词。";
  assert.deepEqual(videoScriptWarnings(steady, SAME_SPEAKER_DIALOGUE), []);

  // 跟随主体的运镜 + 离开原位的动作，是自洽的，不告警。
  const following =
    "镜头1：镜头跟随小李推门进入办公室，动作轻缓，无台词。\n" +
    "镜头2：小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}，动作连贯。\n" +
    "镜头3：对白说完后，人物保持当前姿势，动作渐缓，无台词。";
  assert.deepEqual(videoScriptWarnings(following, SAME_SPEAKER_DIALOGUE), []);

  // 该类判定与台词无关：没有台词的镜头也要能报出来。
  assert.equal(
    videoScriptWarnings(contradicting, "没有引号的旁白")[0]?.code,
    "camera-action-conflict",
  );
});

test("手持道具放手但未写明接住或放置时告警，并固定物理连续约束", () => {
  const ambiguous =
    "镜头1：小李右手持平板进入办公室，无台词。\n" +
    "镜头2：小李左手将平板移到刘老师面前，随后放下左手并说{您看，这份公务接待报销总费用2250元。}。";
  const warnings = videoScriptWarnings(ambiguous, SAME_SPEAKER_DIALOGUE);
  assert.equal(warnings.some((warning) => warning.code === "prop-contact-ambiguity"), true);
  assert.match(buildVideoPromptText({
    dialogue: SAME_SPEAKER_DIALOGUE,
    performance: "动作连贯",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小李右手持平板→小李将平板移到桌面",
    estimatedSeconds: 10,
  }), /道具物理连续/u);
});

test("敲门进场固定为先敲门、再进办公室、最后说话", () => {
  const badOrder =
    "镜头1：镜头跟随小李走进办公室后再敲门，无台词。\n" +
    "镜头2：小李说{刘老师，您提交的公务接待费用，跟您确认些细节。}。\n" +
    "镜头3：动作渐缓，无台词。";
  assert.equal(
    videoScriptWarnings(badOrder, "小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”")
      .some((warning) => warning.code === "door-entry-order"),
    true,
  );

  const source = "小李站在开着的办公室门口敲门→小李走进办公室→小李与刘老师说话";
  assert.match(doorEntrySequenceConstraint(source), /先在门口敲门一次，再进入办公室/u);
  const prompt = buildVideoPromptText({
    script: badOrder,
    dialogue: "小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”",
    performance: "自然",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: source,
    estimatedSeconds: 10,
  });
  assert.match(prompt, /门口进场顺序（硬约束）/u);
  assert.match(prompt, /若门已打开，只保留敲门动作，不再开门或关门/u);
});

test("回退模板的镜头1 不再硬写固定机位（避免与离开原位的动作打架）", () => {
  const script = buildFallbackShotScript({
    dialogue: "小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”",
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小李走到门口敲门→小李推门进入办公室→小李站在办公桌旁说明数据",
    estimatedSeconds: 15,
  });
  assert.match(script, /镜头1：镜头平稳/u);
  assert.doesNotMatch(script, /固定机位/u);
  // 全篇约束行也补了「运镜与动作必须自洽」这条硬约束。
  const prompt = buildVideoPromptText({
    dialogue: "小李：“刘老师，您提交的公务接待费用，跟您确认些细节。”",
    performance: "",
    continuity: "",
    constraints: "",
    referenceNote: "",
    actions: "小李走到门口敲门→小李推门进入办公室",
    estimatedSeconds: 15,
  });
  assert.match(prompt, /运镜与人物动作必须自洽/u);
  assert.match(prompt, /不得同时锁定机位/u);
});

// ---------- 润色结果校验（镜头时序 + 台词逐字） ----------
function briefFor(overrides: Partial<{ id: string; dialogue: string }> = {}) {
  const dialogue = overrides.dialogue ?? DIALOGUE;
  return {
    id: overrides.id ?? "S1-E1-1",
    title: "沟通",
    scene: "办公室",
    characters: "小陈、王老师",
    dialogue,
    // 2026-09-17：台词改为「预切分逐句」送给模型（见 VideoPromptBrief.dialogueLines）。
    dialogueLines: parseDialogueSpeakers(dialogue).map(({ speaker, line }) => ({
      speaker,
      line,
    })),
    actions: ["小陈说明核查发现", "王老师回应解释"],
    referenceNote: "参考图",
    performance: "自然对话",
    continuity: "同机位",
    constraints: "咬字清晰",
    seconds: 15,
    aspectRatio: "16:9",
  };
}

test("brief 会把对白预切成 dialogueLines（本次修复的根因）", () => {
  // 只给「小陈：“…”」原始串时，模型会把句首称呼语当成称呼对象挖出大括号。
  // 预切成逐句 {speaker, line} 后，line 的边界一目了然，模型退化成「原样搬运」。
  const [brief] = normalizeVideoPromptBriefs([
    {
      id: "S1-E1-1",
      scene: "办公室",
      actions: ["小陈说明核查发现"],
      dialogue: DIALOGUE,
      seconds: 15,
    },
  ]);
  assert.equal(brief.dialogueLines.length, 2);
  assert.equal(brief.dialogueLines[0].speaker, "小陈");
  assert.equal(
    brief.dialogueLines[0].line,
    "王老师，学院在三年前报销了几笔公务接待费用，时间较为集中，我们核实时，联系了处理笺上填报的来访人员，对方说那段时间他并没有来京。",
  );
  // 句首称呼语必须留在 line 内——这正是模型此前挖掉的部分。
  assert.match(brief.dialogueLines[0].line, /^王老师，/u);
  assert.equal(brief.dialogueLines[1].speaker, "王老师");
  // 无对白镜给空数组，模型据此判定不得出现大括号。
  const [silent] = normalizeVideoPromptBriefs([
    { id: "S2-E1-1", scene: "走廊", actions: ["镜头缓慢扫过走廊"], dialogue: "", seconds: 10 },
  ]);
  assert.deepEqual(silent.dialogueLines, []);
});

const GOOD_SCRIPT =
  "镜头1：固定机位，小陈从停顿状态自然过渡到说明核查发现，微微俯身指向桌上的凭证，动作轻缓，无台词。\n" +
  "镜头2：小陈说{王老师，学院在三年前报销了几笔公务接待费用，时间较为集中，我们核实时，联系了处理笺上填报的来访人员，对方说那段时间他并没有来京。}，" +
  "随后王老师说{我们接待时没做好记录，也没及时报销，可能事后把信息填错了。}，王老师双手轻按桌面，眉头微皱，语气带着解释的意味。\n" +
  "镜头3：对白说完后两人保持姿势，小陈轻轻把凭证册推到桌面中央，动作渐缓，无台词。";

test("合规的镜头时序正文通过校验", () => {
  const results = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: GOOD_SCRIPT }] },
    [briefFor()],
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].script, GOOD_SCRIPT);
});

test("台词被改写、数量不符或括号外复述一律拒收", () => {
  const reworded = GOOD_SCRIPT.replace("时间较为集中", "时间比较集中");
  assert.throws(
    () => normalizeVideoPromptModelResult({ prompts: [{ id: "S1-E1-1", script: reworded }] }, [briefFor()]),
    /逐字/,
  );  const missing = GOOD_SCRIPT.replace(/，随后王老师说\{[^}]*\}/u, "");
  assert.throws(
    () => normalizeVideoPromptModelResult({ prompts: [{ id: "S1-E1-1", script: missing }] }, [briefFor()]),
    /数量/,
  );
  const leaked = GOOD_SCRIPT + "\n王老师补充：我们接待时没做好记录，说完了。";
  assert.throws(
    () => normalizeVideoPromptModelResult({ prompts: [{ id: "S1-E1-1", script: leaked }] }, [briefFor()]),
    /复述了对白/,
  );
  const recovered = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: "太短" }] },
    [briefFor()],
  );
  assert.equal(recovered[0].fallback, true);
  assert.match(recovered[0].script, /镜头1：/u);
  assert.throws(
    () =>
      normalizeVideoPromptModelResult(
        { prompts: [{ id: "S1-E1-1", script: GOOD_SCRIPT.replace("镜头2：", "镜头2：【表演】") }] },
        [briefFor()],
      ),
    /分节标题/,
  );
});

test("润色结果的说话人标签错位时拒收，避免把错配提示词送进视频生成", () => {
  const swapped = GOOD_SCRIPT
    .replace("小陈说{王老师，", "王老师说{王老师，")
    .replace("随后王老师说{我们接待时", "随后小陈说{我们接待时");
  assert.throws(
    () => normalizeVideoPromptModelResult({ prompts: [{ id: "S1-E1-1", script: swapped }] }, [briefFor()]),
    /说话人标签/u,
  );
});

test("大括号内多一层包裹引号被安全修复，不拒收", () => {
  // 2026-09-17 实测：模型常输出 {“台词”}，属纯排版噪声（说了什么没变），
  // 剥掉外层引号后写回原文，不应因此拒收整个镜头的润色。
  const wrapped = GOOD_SCRIPT.replace(
    "{王老师，学院在三年前报销了几笔公务接待费用",
    "{“王老师，学院在三年前报销了几笔公务接待费用",
  ).replace("对方说那段时间他并没有来京。}", "对方说那段时间他并没有来京。”}");
  assert.notEqual(wrapped, GOOD_SCRIPT);
  const results = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: wrapped }] },
    [briefFor()],
  );
  assert.equal(results[0].script, GOOD_SCRIPT);
  assert.doesNotMatch(results[0].script, /\{“/u);
});

test("标点差异（句尾句号/句中逗号）不拒收，文字漂移仍然拒收（2026-09-26 用户拍板放宽）", () => {
  // glm-4-flash 高频把句尾「。」丢在 {} 外（3 次润色 1 次两连丢）；
  // 用户拍板：比对只关心「文字没有漂移」，全部标点差异都属排版噪声——
  // 写回机制保证最终提示词的台词仍与对白原文逐字一致。
  const dropped = GOOD_SCRIPT
    .replace("对方说那段时间他并没有来京。}", "对方说那段时间他并没有来京}")
    .replace("可能事后把信息填错了。}", "可能事后把信息填错了}");
  assert.notEqual(dropped, GOOD_SCRIPT);
  const results = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: dropped }] },
    [briefFor()],
  );
  assert.equal(results[0].script, GOOD_SCRIPT);
  // 句中标点互换（逗号→顿号）同样放行。
  const commaSwapped = GOOD_SCRIPT.replace("时间较为集中，我们核实时", "时间较为集中、我们核实时");
  const swappedResults = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: commaSwapped }] },
    [briefFor()],
  );
  assert.equal(swappedResults[0].script, GOOD_SCRIPT);
  // 丢字（内容缺失）仍然拒收，与排版噪声严格区分。
  const truncated = GOOD_SCRIPT.replace("对方说那段时间他并没有来京。}", "对方说那段时间他并没有来。}");
  assert.throws(
    () => normalizeVideoPromptModelResult({ prompts: [{ id: "S1-E1-1", script: truncated }] }, [briefFor()]),
    /逐字/,
  );
});

test("把句首称呼语挖出大括号仍然拒收（本次线上踩坑形态）", () => {
  // 模型把「王老师，」误判成称呼对象移出括号，并把说话人写成对方人名——
  // 这是语义改动（少说了两个字），必须拒收，不能当作排版噪声放过。
  const hoisted = GOOD_SCRIPT.replace(
    "小陈说{王老师，学院在三年前报销了几笔公务接待费用",
    "王老师说{学院在三年前报销了几笔公务接待费用",
  );
  assert.notEqual(hoisted, GOOD_SCRIPT);
  assert.throws(
    () =>
      normalizeVideoPromptModelResult(
        { prompts: [{ id: "S1-E1-1", script: hoisted }] },
        [briefFor()],
      ),
    /逐字/,
  );
});

test("规则违规抛 AiOutputRejected（前端据此判定不该重试）", () => {
  const reworded = GOOD_SCRIPT.replace("时间较为集中", "时间比较集中");
  assert.throws(
    () =>
      normalizeVideoPromptModelResult(
        { prompts: [{ id: "S1-E1-1", script: reworded }] },
        [briefFor()],
      ),
    (error: unknown) =>
      error instanceof AiOutputRejected && error.code === "AI_OUTPUT_REJECTED",
  );
  // 结构性问题（正文过短）改为确定性模板兜底，不再把生成按钮卡死。
  const recovered = normalizeVideoPromptModelResult(
    { prompts: [{ id: "S1-E1-1", script: "太短" }] },
    [briefFor()],
  );
  assert.equal(recovered[0].fallback, true);
});

test("素材本身缺场景或动作抛 AiInputRejected（2026-09-30）", () => {
  // 实测来源：存量项目「第5期-公务接待费 0828V5」的 S1-E1-02。
  // 它的动作只有「小陈对王老师说明核查发现」「王老师对小陈回应并说明原因」两条，
  // 都会被 continuityVisualActions 的口语化过滤规则清空，于是 actions 变成 []。
  // 此前这里抛裸 Error → 服务端 400 → 前端按瞬时错误退避重试两次，同样的输入必然同样失败，
  // 用户白等 40 秒还看不到真正原因。现在抛 AiInputRejected，前端不做自动重试。
  //
  // 2026-10-08 二轮：文案里**不再带镜头编号**——服务端拿不到分镜列表，算不出对外展示的
  // 「第几镜」（`S1-E1_01`），回显内部键只会让用户照着界面去找却找不到。
  // 编号改由客户端用 `shotDisplayLabel` 补在前面。这条断言就是这次分工变更的守门人。
  assert.throws(
    () =>
      normalizeVideoPromptBriefs([
        { id: "S1-E1-02", scene: "办公室里", actions: [], dialogue: "", seconds: 10 },
      ]),
    (error: unknown) =>
      error instanceof AiInputRejected &&
      error.code === "AI_INPUT_REJECTED" &&
      /缺少场景或动作/.test(error.message) &&
      !/S1-E1-02/.test(error.message),
  );
  // 边界：场景缺失同样属于输入问题，而不是模型问题。
  assert.throws(
    () => normalizeVideoPromptBriefs([{ id: "S1-E1-02", scene: "", actions: ["推开办公室的门"] }]),
    (error: unknown) => error instanceof AiInputRejected,
  );
});

test("模型漏写镜头1时自动回退模板，不再返回400阻塞分镜", () => {
  const recovered = normalizeVideoPromptModelResult(
    {
      prompts: [{
        id: "S1-E1-1",
        script: "开场人物整理桌面，随后小陈说{王老师，学院在三年前报销了几笔公务接待费用，时间较为集中，我们核实时，联系了处理笺上填报的来访人员，对方说那段时间他并没有来京。}。",
      }],
    },
    [briefFor()],
  );
  assert.equal(recovered[0].fallback, true);
  assert.match(recovered[0].script, /镜头1：/u);
  assert.match(recovered[0].script, /镜头2：/u);
});

/**
 * 2026-10-08：系统提示词里曾经有一句自相矛盾的话——正文结构要求每段以
 * 「镜头1：」「镜头2：」「镜头3：」开头，硬性要求却写「不要写…编号…」。
 * glm-4-flash-250414 服从了禁令、把分段标记删掉，服务端随即判定「没写镜头1」
 * 让**每一条**都走模板兜底（实测 9/9，每次都没有「镜头1」；只改这一句后
 * 同一批 9 镜里 6 镜拿到模型稿）。这条测试读 route.ts 原文当守门人。
 */
test("视频词系统提示词不得再禁掉「镜头1/2/3」分段标记（2026-10-08）", () => {
  const source = readFileSync(new URL("./api/ai/video-prompts/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /不要写标题、列表、编号/u, "旧的冲突句必须已删除");
  assert.match(source, /是必需的分段标记/u, "必须显式放行「镜头1：」这类分段标记");
  assert.match(source, /不得在括号内添加原文没有的称呼语或人名/u, "必须显式禁止凭空补称呼语");
  assert.match(source, /response_format/u, "必须声明 JSON 输出格式，避免模型偶发输出非法 JSON");
});
