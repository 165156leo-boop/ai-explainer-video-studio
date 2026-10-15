/**
 * 对白读音纠错：提交给豆包前，把容易读错的字静默换成「同音常用字」。
 *
 * 依据（2026-09-16 调研，详见 .workbuddy/memory/2026-09-16.md）：
 *  1. 火山引擎《Seedance 2.0 提示词指南》原文：「模型对多音字、生僻字、形近字
 *     容易读错。可将易读错文字替换为发音一致的常用同音字」（示例：螭龙山→吃龙山）。
 *  2. 赤壁 3D 旁白实践（yazelin）：喂给 TTS 的文本用「同音字替身」，画面字幕
 *     再反向映射回正字——**对念对的字无害（替身=目标读音），念错了会被修正**。
 *  3. ChatTTS PR#350：同类 hack，1.6 万条同音替换规则；GLM-TTS 经验：
 *     「90% 的多音字问题靠 5-10 条精准替换规则就能覆盖」。
 *
 * 本模块两条通道：
 *  A. 生僻字自动替换：不在《通用规范汉字表》一级字表（3500 常用字）里的汉字，
 *     用 pinyin-pro 取语境读音，替换成同音同调的**单音常用字**（替换目标本身
 *     不能是多音字，否则等于换一种方式读错）。
 *  B. 词级校对字典 CURATED_SPEECH_FIXES：常用字里的多音词（如「说服」读 shuō 而
 *     不是 shuì）模型仍可能读错，这类只能靠人工观察后按**词**补字典——
 *     单字替换会误伤（赤壁案例：「率领」的率念对了，「率三万」的率却念 lǜ）。
 *
 * 用户明确要求（2026-09-16）：替换**不用在界面上显示**——工作台与任务历史
 * 保留原文，只有真正发给豆包的文本是替换后的版本；替换记录写进服务端审计日志
 * （%LOCALAPPDATA%/AI科普视频制作台/speech-corrections.log）。
 */

import { pinyin } from "pinyin-pro";
import { COMMON_CHARS } from "./speech-common-chars.ts";

const COMMON_SET = new Set(COMMON_CHARS);
const HAN_RE = /^[一-鿿]$/u;

export type SpeechCorrection = {
  from: string;
  to: string;
  pinyin: string;
  kind: "rare" | "curated";
};

/**
 * 词级校对字典（通道 B）。键是原词、值是同音替换词。
 * 只收录**确认豆包读错过**的词，别凭猜测预填——对本来念得对的词替换没有收益，
 * 还会稀释模型对台词语义的理解。初始为空，观察到错读后在这里补一行即可。
 * 替换词要选常用字、且读音唯一（不要用多音字当替身）。
 */
export const CURATED_SPEECH_FIXES: Record<string, string> = {
  // 示例（官方指南用例）：螭龙山: "吃龙山",
};

/**
 * 某些拼音的首选替身。同音常用字往往有多个（jiān → 奸/坚/歼/间/兼/煎…），
 * 按字表顺序取第一个常取到语义刺眼的字（如「奸」），这里手工指定中性的那个。
 * 只放遇到过的，别穷举。
 */
const PREFERRED_HOMOPHONE: Record<string, string> = {
  chi1: "吃",
  jian1: "兼",
  bu4: "部",
  qi4: "气",
  shan4: "善",
  zhen1: "真",
  teng2: "腾",
  hui4: "会",
  yu4: "玉",
};

/** 声调符号 → [基础字母, 声调]。ü 统一记作 v。 */
const TONE_MARKS: Record<string, [string, number]> = {
  ā: ["a", 1], á: ["a", 2], ǎ: ["a", 3], à: ["a", 4],
  ō: ["o", 1], ó: ["o", 2], ǒ: ["o", 3], ò: ["o", 4],
  ē: ["e", 1], é: ["e", 2], ě: ["e", 3], è: ["e", 4],
  ī: ["i", 1], í: ["i", 2], ǐ: ["i", 3], ì: ["i", 4],
  ū: ["u", 1], ú: ["u", 2], ǔ: ["u", 3], ù: ["u", 4],
  ǖ: ["v", 1], ǘ: ["v", 2], ǚ: ["v", 3], ǜ: ["v", 4],
};

export function analyzeTone(py: string) {
  let tone = 0;
  let base = "";
  for (const ch of py) {
    const mark = TONE_MARKS[ch];
    if (mark) {
      base += mark[0];
      tone = mark[1];
    } else {
      base += ch;
    }
  }
  return { base, tone, key: `${base}${tone}` };
}

/**
 * 同音字索引（惰性构建一次）：
 *   key = 拼音+声调（如 "jian1"）→ 常用字候选列表。
 * 候选只收**读音唯一**的常用字——多音字（如「长」）当替身等于换一种方式读错。
 * 同名 key 下按字表顺序排列，构建 O(3500)。
 */
let homophoneIndex: Map<string, string[]> | null = null;

function getHomophoneIndex() {
  if (homophoneIndex) return homophoneIndex;
  const index = new Map<string, string[]>();
  for (const ch of COMMON_SET) {
    const readings = new Set(pinyin(ch, { type: "array", multiple: true }));
    if (readings.size !== 1) continue; // 多音字不当替身
    const [reading] = readings;
    const { key } = analyzeTone(reading);
    if (!key || key === "0") continue;
    const list = index.get(key);
    if (list) list.push(ch);
    else index.set(key, [ch]);
  }
  homophoneIndex = index;
  return index;
}

/** 给某个读音挑一个同音常用字；找不到（或只有被排除的字）时返回空串。 */
export function findHomophone(pyWithTone: string, exclude: Set<string>) {
  const { key } = analyzeTone(pyWithTone);
  const preferred = PREFERRED_HOMOPHONE[key];
  if (preferred && !exclude.has(preferred)) return preferred;
  for (const candidate of getHomophoneIndex().get(key) || []) {
    if (!exclude.has(candidate)) return candidate;
  }
  return "";
}

/** 生僻字判定：汉字且不在一级字表 3500 内。 */
export function isRareChar(ch: string) {
  return HAN_RE.test(ch) && !COMMON_SET.has(ch);
}

function applyCuratedFixes(input: string, corrections: SpeechCorrection[]) {
  let text = input;
  // 长词优先，避免短词先替把长词拆散。
  for (const [from, to] of Object.entries(CURATED_SPEECH_FIXES).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (!text.includes(from)) continue;
    const count = text.split(from).length - 1;
    for (let i = 0; i < count; i += 1) {
      corrections.push({ from, to, pinyin: "", kind: "curated" });
    }
    text = text.split(from).join(to);
  }
  return text;
}

/**
 * 返回 { text, corrections, unresolved }：
 *  - text：替换后的文本（其余部分逐字不动）；
 *  - corrections：每一处替换（from→to，含读音与通道）；
 *  - unresolved：识别出生僻但找不到同音常用替身的字（如「叟」这类没有常用同音字的）。
 */
export function applySpeechCorrections(input: string) {
  const corrections: SpeechCorrection[] = [];
  let text = applyCuratedFixes(input, corrections);

  const chars = [...text];
  const readings = pinyin(text, { type: "array" });
  const unresolved: string[] = [];
  let changed = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (!isRareChar(ch)) continue;
    const reading = readings[i] || "";
    const tone = analyzeTone(reading);
    if (!tone.tone) {
      unresolved.push(ch);
      continue;
    }
    const to = findHomophone(reading, new Set([ch]));
    if (!to) {
      unresolved.push(ch);
      continue;
    }
    chars[i] = to;
    changed = true;
    corrections.push({ from: ch, to, pinyin: reading, kind: "rare" });
  }

  if (changed) text = chars.join("");
  return { text, corrections, unresolved };
}

/** 审计日志用的一行摘要：「3 处：螭→吃(chī)、笺→兼(jiān)；未解决：叟」。 */
export function describeSpeechCorrections(result: ReturnType<typeof applySpeechCorrections>) {
  const parts = result.corrections.map(
    (item) => `${item.from}→${item.to}${item.pinyin ? `(${item.pinyin})` : ""}`,
  );
  const summary = `${result.corrections.length} 处${parts.length ? `：${parts.join("、")}` : ""}`;
  return result.unresolved.length
    ? `${summary}；未解决：${[...new Set(result.unresolved)].join("、")}`
    : summary;
}
