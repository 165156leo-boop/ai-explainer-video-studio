#!/usr/bin/env python3
"""从固定结构的审计科普 Word 脚本中提取需要生成的视频故事段。

本工具只做结构化提取，不调用图片、视频或语音模型，也不会改写原对白。
它会保留需要由 AI 生成的画面与视觉特效，排除字幕、屏幕文字、提示框等后期叠加内容，
并输出待人工复核的 JSON/Markdown。
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from docx import Document


SECTION_RE = re.compile(r"^\s*(\d+)\s*[.．、]\s*$")
EXAMPLE_RE = re.compile(r"^\s*示例\s*(\d+)\s*[.．、]?\s*(.*)$")
SPEAKER_RE = re.compile(r"^([^：:]{1,40})[：:]\s*(.+)$")
SUMMARY_RE = re.compile(r"(?:\d+\s*[-—~至]\s*\d+\s*[sS秒].*(?:总结|过渡))|(?:常见问题总结)")
REMINDER_RE = re.compile(r"^[（(]\s*审计提醒[：:]?.*[）)]$")
PAREN_NOTE_RE = re.compile(r"^[（(].*[）)]$")
FIXED_END_RE = re.compile(r"^(?:固定结尾|结尾金句)|(?:以上案例旨在提示风险)")
TIMELINE_RE = re.compile(
    r"^(?:###\s*)?(\d+)\s*[sS秒]?\s*[-—~至]\s*(\d+)\s*[sS秒]\s*(?:[（(]|[｜|])?\s*(.*?)\s*[）)]?$"
)
SUMMARY_CONTENT_RE = re.compile(r"结合上述案例.*(?:梳理|总结)")
NESTED_EXAMPLE_RE = re.compile(r"^(?:第([一二三四五六七八九])例|例(\d+)标题)[：:]\s*(.+)$")
SUBTITLE_HEADER_RE = re.compile(
    r"^(?:字幕(?:[（(].*?[）)])?|屏幕文字|浮现新字幕)[：:]?\s*"
)
VISUAL_EFFECT_RE = re.compile(r"^(?:镜头\s*/\s*特效|镜头特效|特效)[：:]\s*(.*)$")
POST_PRODUCTION_OVERLAY_RE = re.compile(
    r"^(?:(?:弹出|浮现|出现).{0,16}(?:提示框|字幕条|文字框|文字卡)|(?:提示框|字幕条|文字框|文字卡))[：:]"
)
VISUAL_CONTENT_HEADER_RE = re.compile(
    r"^(?:场景设定|场景|画面|镜头|动作|环境|地点)[：:]"
)
# 说话动词：左侧的修饰语（温和地/轻声地…）才是现场神态提示，动词本身不是画面信息。
SPEECH_VERB_RE = re.compile(
    r"(?P<modifier>温和地|轻声地|认真地|连忙|随后|继续)?"
    r"(?P<verb>提醒|点头|说道|说|问道|问|回答|解释|补充|表示|回应|建议|强调)"
)
# 标签里紧跟的现场动作/神态提示。旧版直接丢弃，于是对白镜只剩对白、
# 没有任何可执行动作——下游画面词与视频词只能凭空合成口播意向串。
# 结尾锚点（$)让「按原文逐字顺序切出」成为可能，因而不会误伤说话人里
# 恰好含这些字的写法。
TRAILING_STAGE_DIRECTION_RE = re.compile(
    r"(?:站在门口.*|走进来.*|现场对话.*|有些为难|一愣|看了看|又)$"
)
# 「姓名＋动作动词」式提示（刘老师看了看 / 小陈低头翻看处理笺 / 王主任皱着眉）。
# 只在**姓名部分确实是说话人**时才采纳——见 split_stage_direction 的合影校验，
# 因此不会把「赵老师」这种姓氏里带「赵」的说话人误切。
TRAILING_SPEAKER_ACTION_RE = re.compile(
    r"^(?P<name>.{1,6}?)(?P<action>(?:低(?:下)?头|抬(?:起)?头|皱(?:着)?眉|笑了笑|点了?点头轻?|叹(?:了)?(?:口)?气|看了(?:看)?|走(?:进|了进)来|站起身|坐下)[^，。；：:]{0,12})$"
)

# 工作台的全局语速基线（publicity-video-ai-workbench/src/app/shot-planning.ts
# 的 SPEECH_UNITS_PER_SECOND）。旧版这里硬编码 6.0 而工作台是 5.5，
# 同一句台词在两条路径上算出两个时长；对齐成同一个数后两边可以互相核对。
SPEECH_UNITS_PER_SECOND = 5.5
MIN_ESTIMATED_SECONDS = 2.0


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u3000", " ")).strip()


def estimate_speech(text: str) -> dict[str, Any]:
    """按全局语速基线估算朗读时长，用于判断是否需要拆镜。"""
    spoken_units = len(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", text))
    estimated = spoken_units / SPEECH_UNITS_PER_SECOND
    estimated = round(max(MIN_ESTIMATED_SECONDS, estimated), 1)

    return {
        "spoken_units": spoken_units,
        "estimated_seconds_fast": estimated,
    }


def split_dialogue_visual_note(text: str) -> tuple[str, str | None]:
    """把对白末尾的括号说明剥离为画面信息，不计入配音。"""
    clean = normalize(text)
    if clean.startswith(("“", '"')):
        closing = "”" if clean.startswith("“") else '"'
        closing_index = clean.rfind(closing)
        if closing_index > 0:
            trailing = clean[closing_index + 1 :].strip()
            if not trailing or re.fullmatch(r"(?:[（(][^（）()]*[）)])+", trailing):
                clean = normalize(clean[1:closing_index] + trailing)

    notes: list[str] = []
    while match := re.search(r"[（(]([^（）()]*)[）)]\s*$", clean):
        notes.insert(0, normalize(match.group(1)))
        clean = clean[: match.start()].rstrip()

    return clean, "；".join(note for note in notes if note) or None


# 「点头」是可见的现场动作，其余说话动词只是发声方式，单独出现不算画面信息。
PHYSICAL_SPEECH_VERBS = {"点头"}
# 切出来的提示至少要有两个字才算有效信息，避免「又」这类残字进动作链。
MIN_CUE_LENGTH = 2
# 说话人后面跟着一个未闭合的左括号（如「审计人员A（站在门口）」）时，
# 尾巴不是表演提示、而是场景说明：交给 infer_speaker 的括号分支处理。
DANGLING_OPEN_RE = re.compile(r"[（(【“\"][^）)】”\"]*$")


def split_stage_direction(label: str) -> tuple[str, str | None]:
    """把标签里的现场动作/神态提示切出来，而不是丢掉。

    原文里对白天然带着表演提示：「王老师一愣：…」「小陈温和地提醒：…」
    「小李走进来，把平板递过去：…」「刘主任有些为难：…」。旧版 infer_speaker
    把它们整段删掉，只留下说话人——于是对白镜在提取层就没有任何可执行动作，
    下游只能凭空合成「XX说明核查发现」这类口播意向串，画面词与视频词因此被清空。
    这里改为**分流**：说话人照旧识别，提示文字回填到 dialogue 条目的
    `performance_cue`，供分镜规划判断「这条动作能不能与对白同时发生」。
    """
    base = normalize(label)
    cues: list[str] = []

    match = SPEECH_VERB_RE.search(base)
    if match:
        verb = match.group("verb")
        modifier = match.group("modifier")
        if modifier:
            cues.append(f"{modifier}{verb}")
        elif verb in PHYSICAL_SPEECH_VERBS:
            cues.append(verb)
        trimmed = base[: match.start()].strip()
        if trimmed:
            base = trimmed

    match = TRAILING_STAGE_DIRECTION_RE.search(base)
    if match and match.start() > 0:
        head = base[: match.start()].strip()
        if head and not DANGLING_OPEN_RE.search(head):
            cues.insert(0, base[match.start() :].strip())
            base = head

    meaningful = [cue for cue in cues if len(cue) >= MIN_CUE_LENGTH]
    return base, "；".join(meaningful) or None


def infer_speaker(label: str) -> tuple[str, bool, str | None, str | None]:
    """从冒号左侧推断说话人；现场提示回填为 performance_cue，无法稳定判断时标记复核。"""
    label, performance_cue = split_stage_direction(label)
    changed = re.search(r"人员变更为\s*([^，。；:：]+)", label)
    if changed:
        return changed.group(1).strip(), False, label, performance_cue

    if "电话场景" in label and "某教职工" in label:
        return "某教职工", False, label, performance_cue

    parenthetical = re.search(r"[（(](.+?)[）)]", label)
    if parenthetical:
        base_label = re.sub(r"[（(].+?[）)]", "", label).strip()
        hint = parenthetical.group(1).strip()
        return (
            base_label,
            bool(re.fullmatch(r"[A-Za-z]", base_label)),
            hint,
            performance_cue,
        )

    looks_like_direction = any(word in label for word in ("场景", "画面", "镜头", "切换"))
    is_bare_letter = bool(re.fullmatch(r"[A-Za-z]", label))
    return (
        label,
        looks_like_direction or is_bare_letter,
        label if looks_like_direction else None,
        performance_cue,
    )


def classify_story_line(paragraph_index: int, text: str) -> dict[str, Any]:
    clean = re.sub(r"^[>\-\s]+", "", text).strip()

    if PAREN_NOTE_RE.match(clean):
        return {
            "source_paragraph": paragraph_index,
            "type": "visual_note",
            "text": clean,
            "evidence_closeup_candidate": bool(
                re.search(r"发放单|报销单|发票|清单|明细|电脑|屏幕|金额|银行卡|合同", clean)
            ),
        }

    if re.match(r"^(?:画面|镜头|镜头\s*/\s*特效|镜头特效|特效|场景|场景设定|另外，?画面|配图)[：:]", clean):
        # 「特效：…」是后期特效，不是场景。旧版把它归为 visual_direction，
        # 而 visual_direction 会被 shotLocation 当作本镜场景取用——
        # 于是「特效：三张卡片依次弹出」会变成这一镜的地点。
        if VISUAL_EFFECT_RE.match(clean):
            return {
                "source_paragraph": paragraph_index,
                "type": "visual_effect",
                "text": clean,
                "effect_note": "后期特效，不作为画面动作或场景",
            }
        return {
            "source_paragraph": paragraph_index,
            "type": "visual_direction",
            "text": clean,
            "evidence_closeup_candidate": bool(
                re.search(r"发放单|报销单|发票|清单|明细|电脑|屏幕|金额|银行卡|合同|票|凭证", clean)
            ),
        }

    if re.match(r"^字幕(?:[（(].*?[）)])?[：:]", clean):
        return {
            "source_paragraph": paragraph_index,
            "type": "visual_note",
            "text": clean,
            "evidence_closeup_candidate": "屏幕文字" in clean,
        }

    match = SPEAKER_RE.match(clean)
    if match:
        raw_label, dialogue = match.groups()
        if re.search(r"字幕|合同信息|行程信息|凭证|报销合计|出发时间|返程时间|行程路线|出差地点|出差人员|出差天数|补贴天数|行程费用|伙食补贴|交通补助|弹出.*提示框|正确做法|错误做法|^✅|^❌|^合同\d+|^第[一二三四五六]例|^例\d+标题", raw_label):
            return {
                "source_paragraph": paragraph_index,
                "type": "visual_note",
                "text": clean,
                "evidence_closeup_candidate": True,
            }

        spoken_text, visual_note = split_dialogue_visual_note(dialogue)
        speaker, needs_review, scene_hint, performance_cue = infer_speaker(raw_label)
        if speaker == "旁白":
            return {
                "source_paragraph": paragraph_index,
                "type": "narration_context",
                "speaker": "旁白",
                "text": spoken_text,
                "source_text": text,
                "generate_audio": False,
                "purpose": "只用于理解案例画面，不生成旁白",
            }
        item: dict[str, Any] = {
            "source_paragraph": paragraph_index,
            "type": "dialogue",
            "speaker": speaker,
            "text": spoken_text,
            "source_text": text,
            "speaker_needs_review": needs_review,
            "speech": estimate_speech(spoken_text),
        }
        if performance_cue:
            item["performance_cue"] = performance_cue
        if visual_note:
            item["visual_note"] = visual_note
        if scene_hint:
            item["scene_hint"] = scene_hint
        return item

    return {
        "source_paragraph": paragraph_index,
        "type": "action_or_narration",
        "text": clean,
        "needs_review": True,
    }


def classify_story_lines(paragraph_index: int, text: str) -> list[dict[str, Any]]:
    """保留同一 Word 段落中多个“人物：对白”片段的顺序和说话人。"""
    clean = normalize(text)
    matches = list(
        re.finditer(
            r"(?P<label>[^：:\n]{1,40})[：:]\s*[“\"](?P<dialogue>.+?)[”\"]",
            clean,
        )
    )
    if len(matches) < 2:
        return [classify_story_line(paragraph_index, text)]

    items: list[dict[str, Any]] = []
    for segment, match in enumerate(matches, start=1):
        label = normalize(match.group("label"))
        dialogue = normalize(match.group("dialogue"))
        speaker, needs_review, scene_hint, performance_cue = infer_speaker(label)
        spoken_text, visual_note = split_dialogue_visual_note(dialogue)
        item: dict[str, Any] = {
            "source_paragraph": paragraph_index,
            "source_segment": segment,
            "type": "dialogue",
            "speaker": speaker,
            "text": spoken_text,
            "source_text": text,
            "speaker_needs_review": needs_review,
            "speech": estimate_speech(spoken_text),
        }
        if performance_cue:
            item["performance_cue"] = performance_cue
        if visual_note:
            item["visual_note"] = visual_note
        if scene_hint:
            item["scene_hint"] = scene_hint
        items.append(item)
    return items


def annotate_generation_units(sections: list[dict[str, Any]]) -> None:
    """标注分镜预警：同时考虑对白时长和源脚本明确写出的场景切换。"""
    for section in sections:
        for example in section["examples"]:
            dialogue_items = [item for item in example["items"] if item["type"] == "dialogue"]
            narration_items = [item for item in example["items"] if item["type"] == "narration_context"]
            estimated_seconds = round(
                sum(item.get("speech", {}).get("estimated_seconds_fast", 0) for item in dialogue_items), 1
            )
            minimum_clips_by_duration = (
                max(1, int((estimated_seconds + 14.999) // 15)) if estimated_seconds else 1
            )
            scene_transition_cues = [
                {
                    "source_paragraph": item["source_paragraph"],
                    "speaker": item.get("speaker", ""),
                    "scene_hint": item.get("scene_hint", ""),
                }
                for item in dialogue_items
                if re.search(
                    r"场景切换|切换为.*场景|另一个.*场景|人员变更为",
                    item.get("scene_hint", ""),
                )
            ]
            minimum_clips = max(
                minimum_clips_by_duration,
                1 + len(scene_transition_cues),
            )
            example["generation"] = {
                "unit": "one_smallest_case_one_or_more_storyboard_clips",
                "logical_case_count": 1,
                "dialogue_line_count": len(dialogue_items),
                "narration_line_count": len(narration_items),
                "narration_generated": False,
                "estimated_dialogue_seconds_fast": estimated_seconds,
                "clip_duration_min_seconds": 4,
                "clip_duration_max_seconds": 15,
                "minimum_clip_estimate_by_duration": minimum_clips_by_duration,
                "explicit_scene_transition_count": len(scene_transition_cues),
                "scene_transition_cues": scene_transition_cues,
                "minimum_clip_estimate": minimum_clips,
                "requires_storyboard_split": estimated_seconds > 15 or bool(scene_transition_cues),
                "split_reasons": [
                    *(
                        ["estimated_dialogue_exceeds_15_seconds"]
                        if estimated_seconds > 15
                        else []
                    ),
                    *(
                        ["explicit_scene_or_character_location_transition"]
                        if scene_transition_cues
                        else []
                    ),
                ],
            }


def nested_marker(item: dict[str, Any]) -> tuple[int, str] | None:
    if item.get("type") != "visual_note":
        return None
    match = NESTED_EXAMPLE_RE.match(item.get("text", ""))
    if not match:
        return None
    chinese_numbers = "一二三四五六七八九"
    order = chinese_numbers.index(match.group(1)) + 1 if match.group(1) else int(match.group(2))
    return order, normalize(match.group(3))


def split_nested_examples(sections: list[dict[str, Any]]) -> None:
    """把时间段内部的“第一例/例1标题”等继续拆到最小案例层级。"""
    for section in sections:
        expanded: list[dict[str, Any]] = []
        for example in section["examples"]:
            items = example["items"]
            markers = [(index, nested_marker(item)) for index, item in enumerate(items)]
            markers = [(index, marker) for index, marker in markers if marker is not None]
            if len(markers) < 2:
                expanded.append(example)
                continue

            first_marker_index = markers[0][0]
            shared_context = [
                item
                for item in items[:first_marker_index]
                if item.get("type") in {"visual_direction", "action_or_narration"}
            ]
            first_dialogue_index = next(
                (index for index, item in enumerate(items) if item.get("type") == "dialogue"),
                len(items),
            )
            markers_before_dialogue = all(index < first_dialogue_index for index, _ in markers)

            if markers_before_dialogue:
                dialogues = [item for item in items if item.get("type") == "dialogue"]
                for marker_position, (item_index, marker) in enumerate(markers):
                    _, title = marker
                    selected = [*shared_context, items[item_index]]
                    if marker_position < len(dialogues):
                        selected.append(dialogues[marker_position])
                    expanded.append(
                        {
                            "example_number": len(expanded) + 1,
                            "heading": title,
                            "source_heading_paragraph": items[item_index]["source_paragraph"],
                            "source_parent_example": example["heading"],
                            "items": selected,
                            "approval": {"status": "waiting", "comment": ""},
                        }
                    )
                continue

            for marker_position, (item_index, marker) in enumerate(markers):
                _, title = marker
                next_index = markers[marker_position + 1][0] if marker_position + 1 < len(markers) else len(items)
                chunk = items[item_index:next_index]
                trimmed: list[dict[str, Any]] = []
                found_dialogue = False
                for item in chunk:
                    item_text = item.get("text", "")
                    if found_dialogue and re.search(r"弹出学校规定|学校合同管理办法要求", item_text):
                        break
                    trimmed.append(item)
                    found_dialogue = found_dialogue or item.get("type") == "dialogue"
                expanded.append(
                    {
                        "example_number": len(expanded) + 1,
                        "heading": title,
                        "source_heading_paragraph": items[item_index]["source_paragraph"],
                        "source_parent_example": example["heading"],
                        "items": [*shared_context, *trimmed],
                        "approval": {"status": "waiting", "comment": ""},
                    }
                )

        for example_number, example in enumerate(expanded, start=1):
            example["example_number"] = example_number
            example["id"] = f"S{section['section_number']}-E{example_number}"
        section["examples"] = expanded


def is_story_timeline(label: str, start_seconds: int | None = None, end_seconds: int | None = None) -> bool:
    label = normalize(label)
    if not bool(re.search(r"案例|示例|提示", label)) or "标题卡" in label or "过渡" in label:
        return False
    if (
        start_seconds is not None
        and end_seconds is not None
        and end_seconds - start_seconds <= 3
        and re.fullmatch(r"案例[一二三四五六1-9]+", label)
    ):
        return False
    return True


def is_production_only_line(text: str) -> bool:
    clean = re.sub(r"^[>\-\s]+", "", text).strip()
    if re.match(r"^音效[：:]", clean):
        return True
    if re.match(r"^(?:对话|对话/旁白)(?:[（(].*?[）)])?[：:]?$", clean):
        return True
    if "警惕违规点" in clean or "警惕风险点" in clean:
        return True
    if SUBTITLE_HEADER_RE.match(clean) or POST_PRODUCTION_OVERLAY_RE.match(clean):
        return True
    return False


def is_subtitle_header(text: str) -> bool:
    clean = re.sub(r"^[>\-\s]+", "", text).strip()
    return bool(SUBTITLE_HEADER_RE.match(clean))


def is_empty_visual_effect_header(text: str) -> bool:
    clean = re.sub(r"^[>\-\s]+", "", text).strip()
    match = VISUAL_EFFECT_RE.match(clean)
    return bool(match and not normalize(match.group(1)))


def effect_scope_ends(text: str) -> bool:
    """判断「镜头/特效：」引出的一段是否结束。

    特效标签之后的若干段都属于后期特效，直到遇到下一个小节标题、
    新的「画面/场景」标题、「提示框/字幕/音效」这类另一套后期构造，
    或一句带引号的人物对白。
    """
    clean = re.sub(r"^[>\-\s]+", "", text).strip()
    if VISUAL_CONTENT_HEADER_RE.match(clean):
        return True
    if re.match(r"^.{1,40}[：:]\s*[“\"]", clean):
        return True
    if POST_PRODUCTION_OVERLAY_RE.match(clean) or SUBTITLE_HEADER_RE.match(clean):
        return True
    return bool(
        SECTION_RE.match(clean)
        or TIMELINE_RE.match(clean)
        or EXAMPLE_RE.match(clean)
        or SUMMARY_RE.search(clean)
        or FIXED_END_RE.match(clean)
    )


# 房间/家具类地点词。出现在「镜头/特效」行里、却不在本节「场景设定」里时，
# 说明这行写的不是本场景的画面（真实案例：「场景设定：办公室里…」+
# 「处理笺扫描件浮现在餐桌上方」）。它不是画面动作，必须提出来让人确认。
ROOM_OR_FURNITURE_WORDS = (
    "餐桌",
    "饭桌",
    "厨房",
    "卧室",
    "客厅",
    "沙发",
    "阳台",
    "浴室",
    "餐厅",
)


def example_scene_text(example: dict[str, Any]) -> str:
    for item in example["items"]:
        if item.get("type") == "visual_direction" and "场景" in item.get("text", ""):
            return re.sub(r"^[>\-\s]*场景设定[：:]\s*", "", item["text"]).strip("。； ")
    return ""


def effect_scene_conflicts(effect_text: str, scene_text: str) -> list[str]:
    conflicts: list[str] = []
    for word in ROOM_OR_FURNITURE_WORDS:
        if word in effect_text and word not in scene_text and word not in conflicts:
            conflicts.append(word)
    return conflicts


def collect_review_flags(sections: list[dict[str, Any]]) -> list[str]:
    """人工复核旗标。

    2026-09-18 新增「后期特效与本节场景不一致」一条。真实事故：上传文档「提示一」的
    「镜头/特效」行写着「处理笺扫描件浮现在餐桌上方」，而同节「场景设定」是办公室。
    旧版把标签段排除了、却把这行正文当成 action_or_narration，它于是进入分镜动作、
    再进入画面词，最后由生图模型忠实画出「餐桌」——程序里搜「餐桌」是 0 命中，
    来源一直在用户自己的文档里，但**没有任何一处审查把它指出来**。
    """
    flags: list[str] = []
    for section in sections:
        for example in section["examples"]:
            if not example["items"]:
                flags.append(f"{example['id']} 没有提取到故事内容")
            scene_text = example_scene_text(example)
            for item in example["items"]:
                if item.get("speaker_needs_review"):
                    flags.append(
                        f"{example['id']} 第{item['source_paragraph']}段说话人“{item.get('speaker', '')}”需要复核"
                    )
                if item.get("type") == "visual_effect":
                    conflicts = effect_scene_conflicts(item.get("text", ""), scene_text)
                    if conflicts:
                        scene_hint = scene_text[:24] or "未标注场景"
                        flags.append(
                            f"{example['id']} 第{item['source_paragraph']}段 "
                            f"后期特效提到“{'、'.join(conflicts)}”，与本节场景“{scene_hint}”不一致"
                        )
    return flags


def resumes_generated_content(text: str) -> bool:
    """字幕块之后遇到明确的画面/特效/对白标题时，恢复提取。"""
    clean = re.sub(r"^[>\-\s]+", "", text).strip()
    return bool(
        VISUAL_EFFECT_RE.match(clean)
        or VISUAL_CONTENT_HEADER_RE.match(clean)
        or re.match(r"^.{1,40}[：:].*[“\"]", clean)
    )


def timeline_extract(docx_path: Path, paragraphs: list[dict[str, Any]], project_title: str) -> dict[str, Any]:
    """兼容旧版脚本：用时间段标题识别案例内容边界。"""
    sections: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    current_example: dict[str, Any] | None = None
    current_section: dict[str, Any] | None = None
    pending_title_card = ""
    tail_excluded = False
    subtitle_block = False
    effect_block = False

    for paragraph in paragraphs:
        index = paragraph["index"]
        text = paragraph["text"]
        clean = re.sub(r"^[>\-\s]+", "", text).strip()

        if tail_excluded:
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "summary_or_fixed_ending", "text": text})
            continue

        if SUMMARY_RE.search(text) or SUMMARY_CONTENT_RE.search(text) or FIXED_END_RE.search(clean):
            current_example = None
            tail_excluded = True
            subtitle_block = False
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "summary_or_fixed_ending", "text": text})
            continue

        timeline = TIMELINE_RE.match(text)
        if timeline:
            label = normalize(timeline.group(3))
            start_seconds = int(timeline.group(1))
            end_seconds = int(timeline.group(2))
            current_example = None
            subtitle_block = False
            effect_block = False
            if not is_story_timeline(label, start_seconds, end_seconds):
                excluded.append({"source_paragraph": index, "reason": "timeline_non_story", "text": text})
                continue

            detail = ""
            if re.search(r"[：:]", label):
                detail = re.split(r"[：:]", label, maxsplit=1)[1].strip()
            section_title = pending_title_card or detail or label
            if re.fullmatch(r"案例[一二三四五六1-9]+", section_title) and detail:
                section_title = detail

            if current_section is None or current_section["title"] != section_title:
                current_section = {
                    "section_number": len(sections) + 1,
                    "title": section_title,
                    "source_heading_paragraph": index,
                    "examples": [],
                    "audit_reminder": None,
                }
                sections.append(current_section)

            current_example = {
                "id": f"S{current_section['section_number']}-E{len(current_section['examples']) + 1}",
                "example_number": len(current_section["examples"]) + 1,
                "heading": detail or label,
                "source_heading_paragraph": index,
                "source_timeline": {"start_seconds": start_seconds, "end_seconds": end_seconds},
                "items": [],
                "approval": {"status": "waiting", "comment": ""},
            }
            current_section["examples"].append(current_example)
            continue

        if current_example is None:
            title_match = re.match(r"^(?:标题|字幕)[：:]\s*(案例[一二三四五六1-9]+.*)$", clean)
            if title_match:
                pending_title_card = normalize(title_match.group(1))
                excluded.append({"source_paragraph": index, "reason": "title_card", "text": text})
                continue
            if clean.startswith("标题：") or clean.startswith("标题:") or clean.startswith("片名：") or clean.startswith("片名:"):
                value = re.split(r"[：:]", clean, maxsplit=1)[1].strip()
                if not re.match(r"案例[一二三四五六1-9]+", value):
                    project_title = value
                else:
                    pending_title_card = value
                excluded.append({"source_paragraph": index, "reason": "front_matter_or_title_card", "text": text})
            else:
                excluded.append({"source_paragraph": index, "reason": "outside_story_timeline", "text": text})
            continue

        if is_subtitle_header(text):
            subtitle_block = True
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "post_production_subtitle", "text": text})
            continue

        if subtitle_block:
            if resumes_generated_content(text):
                subtitle_block = False
            else:
                excluded.append({"source_paragraph": index, "reason": "post_production_screen_text", "text": text})
                continue

        if is_production_only_line(text):
            # 提示框/字幕/音效这类后期构造也是特效块的天然收口点。不收口的话，
            # 紧跟其后的正常画面动作会被继续当作 visual_effect 吞掉。
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "post_production_overlay_or_audio", "text": text})
            continue

        if is_empty_visual_effect_header(text):
            effect_block = True
            excluded.append({"source_paragraph": index, "reason": "visual_effect_label", "text": text})
            continue

        if effect_block:
            if effect_scope_ends(text):
                effect_block = False
            else:
                # 后期特效正文：是「后期叠加怎么呈现」，不是现场发生的动作。
                # 归为 visual_effect 而不是 action_or_narration——真实事故里
                # 「处理笺扫描件浮现在餐桌上方」正是从这里一路进了画面词。
                current_example["items"].append({
                    "source_paragraph": index,
                    "type": "visual_effect",
                    "text": clean,
                    "effect_note": "后期特效，不作为画面动作或场景",
                })
                continue

        current_example["items"].extend(classify_story_lines(index, text))

    split_nested_examples(sections)
    annotate_generation_units(sections)
    review_flags = collect_review_flags(sections)

    return {
        "schema_version": "1.7",
        "project_title": project_title,
        "source_document": str(docx_path.resolve()),
        "extraction_mode": "timeline_fallback",
        "scope": {
            "include": "按最小案例生成画面，保留人物对白与场景动作；后期特效只登记、不作为画面动作",
            "exclude": ["Word时间控制", "旁白音频", "标题卡", "音效", "字幕与屏幕文字", "后期提示框", "后期视觉特效叠加", "制度总结", "结尾金句", "固定结尾"],
            "dialogue_policy": "最小案例是逻辑单元；每个生成分镜必须为4—15秒；超过15秒时在案例内部按自然对白节点拆分；旁白不生成",
        },
        "generation_policy": {
            "count_by": "smallest_case",
            "clips_per_smallest_case": "one_or_more",
            "clip_duration_min_seconds": 4,
            "clip_duration_max_seconds": 15,
            "ignore_word_timing": True,
            "generate_narration": False,
        },
        "source_paragraphs": paragraphs,
        "sections": sections,
        "excluded_paragraphs": excluded,
        "review_flags": review_flags,
        "approval": {
            "stage": "story_extraction",
            "status": "waiting",
            "approved_by": "",
            "approved_at": "",
            "comment": "",
        },
    }


def extract(docx_path: Path) -> dict[str, Any]:
    document = Document(docx_path)
    paragraphs = [
        {"index": index, "text": normalize(paragraph.text)}
        for index, paragraph in enumerate(document.paragraphs, start=1)
        if normalize(paragraph.text)
    ]

    project_title = docx_path.stem
    sections: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    current_section: dict[str, Any] | None = None
    current_example: dict[str, Any] | None = None
    tail_excluded = False
    subtitle_block = False
    effect_block = False

    for paragraph in paragraphs:
        index = paragraph["index"]
        text = paragraph["text"]

        if tail_excluded:
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "summary_or_fixed_ending", "text": text})
            continue

        if SUMMARY_RE.search(text) or FIXED_END_RE.search(text):
            tail_excluded = True
            subtitle_block = False
            effect_block = False
            excluded.append({"source_paragraph": index, "reason": "summary_or_fixed_ending", "text": text})
            current_example = None
            continue

        section_match = SECTION_RE.match(text)
        if section_match:
            subtitle_block = False
            effect_block = False
            current_section = {
                "section_number": int(section_match.group(1)),
                "title": "",
                "source_heading_paragraph": index,
                "examples": [],
                "audit_reminder": None,
            }
            sections.append(current_section)
            current_example = None
            excluded.append({"source_paragraph": index, "reason": "section_marker", "text": text})
            continue

        example_match = EXAMPLE_RE.match(text)
        if example_match and current_section is not None:
            subtitle_block = False
            example_number = int(example_match.group(1))
            current_example = {
                "id": f"S{current_section['section_number']}-E{example_number}",
                "example_number": example_number,
                "heading": normalize(example_match.group(2)),
                "source_heading_paragraph": index,
                "items": [],
                "approval": {"status": "waiting", "comment": ""},
            }
            current_section["examples"].append(current_example)
            continue

        if REMINDER_RE.match(text):
            subtitle_block = False
            if current_section is not None:
                current_section["audit_reminder"] = text
            excluded.append({"source_paragraph": index, "reason": "audit_reminder", "text": text})
            current_example = None
            continue

        if text.startswith("标题：") or text.startswith("标题:"):
            subtitle_block = False
            title_text = re.split(r"[：:]", text, maxsplit=1)[1].strip()
            if current_section is None:
                project_title = title_text
                excluded.append({"source_paragraph": index, "reason": "front_matter", "text": text})
            elif current_example is None and not current_section["title"]:
                current_section["title"] = title_text
                excluded.append({"source_paragraph": index, "reason": "title_card", "text": text})
            else:
                excluded.append({"source_paragraph": index, "reason": "title_card", "text": text})
            continue

        if current_example is not None:
            if is_subtitle_header(text):
                subtitle_block = True
                effect_block = False
                excluded.append({"source_paragraph": index, "reason": "post_production_subtitle", "text": text})
                continue
            if subtitle_block:
                if resumes_generated_content(text):
                    subtitle_block = False
                else:
                    excluded.append({"source_paragraph": index, "reason": "post_production_screen_text", "text": text})
                    continue
            if is_production_only_line(text):
                # 与 numbered_examples 分支同理：提示框/字幕/音效是特效块的收口点。
                effect_block = False
                excluded.append({"source_paragraph": index, "reason": "post_production_overlay_or_audio", "text": text})
                continue
            if is_empty_visual_effect_header(text):
                effect_block = True
                excluded.append({"source_paragraph": index, "reason": "visual_effect_label", "text": text})
                continue
            if effect_block:
                if effect_scope_ends(text):
                    effect_block = False
                else:
                    current_example["items"].append({
                        "source_paragraph": index,
                        "type": "visual_effect",
                        "text": re.sub(r"^[>\-\s]+", "", text).strip(),
                        "effect_note": "后期特效，不作为画面动作或场景",
                    })
                    continue
            current_example["items"].extend(classify_story_lines(index, text))
        else:
            reason = "title_card" if ("全屏标题卡" in text or "音效" in text) else "front_matter"
            excluded.append({"source_paragraph": index, "reason": reason, "text": text})

    if not sections:
        return timeline_extract(docx_path, paragraphs, project_title)

    split_nested_examples(sections)
    annotate_generation_units(sections)
    review_flags = collect_review_flags(sections)

    return {
        "schema_version": "1.7",
        "project_title": project_title,
        "source_document": str(docx_path.resolve()),
        "extraction_mode": "numbered_examples",
        "scope": {
            "include": "按最小案例生成画面，保留人物对白与场景动作；后期特效只登记、不作为画面动作",
            "exclude": ["Word时间控制", "旁白音频", "标题卡", "音效", "字幕与屏幕文字", "后期提示框", "后期视觉特效叠加", "审计提醒", "制度总结", "结尾金句", "固定结尾"],
            "dialogue_policy": "最小案例是逻辑单元；每个生成分镜必须为4—15秒；超过15秒时在案例内部按自然对白节点拆分；旁白不生成",
        },
        "generation_policy": {
            "count_by": "smallest_case",
            "clips_per_smallest_case": "one_or_more",
            "clip_duration_min_seconds": 4,
            "clip_duration_max_seconds": 15,
            "ignore_word_timing": True,
            "generate_narration": False,
        },
        "source_paragraphs": paragraphs,
        "sections": sections,
        "excluded_paragraphs": excluded,
        "review_flags": review_flags,
        "approval": {
            "stage": "story_extraction",
            "status": "waiting",
            "approved_by": "",
            "approved_at": "",
            "comment": "",
        },
    }


def render_markdown(data: dict[str, Any]) -> str:
    lines = [
        f"# {data['project_title']}｜机器提取草稿",
        "",
        f"- 源文件：`{data['source_document']}`",
        "- 当前状态：待人工复核",
        "- 生成口径：最小案例是逻辑单元；每个实际生成分镜必须控制在4—15秒。",
        "- 一个最小案例15秒内完成则生成1段；超过15秒则在案例内部按自然对白节点拆分。",
        "- Word时间控制全部忽略；旁白仅作画面理解，不生成旁白音频。",
        "- 镜头动作与视觉特效保留；标题卡、字幕、屏幕文字、提示框、音效、审计提醒、制度总结与固定结尾已排除。",
        "",
    ]

    for section in data["sections"]:
        lines.extend([f"## 第{section['section_number']}幕：{section['title']}", ""])
        for example in section["examples"]:
            lines.extend([f"### {example['id']} {example['heading']}", ""])
            generation = example["generation"]
            split_label = "需要案例内拆分" if generation["requires_storyboard_split"] else "可用1个分镜完成"
            lines.append(
                f"- 输出规则：{split_label}；时长下限4秒、上限15秒；"
                f"对白估算约{generation['estimated_dialogue_seconds_fast']}秒"
            )
            if generation.get("scene_transition_cues"):
                cues = "；".join(
                    f"第{cue['source_paragraph']}段：{cue['scene_hint']}"
                    for cue in generation["scene_transition_cues"]
                )
                lines.append(f"- 明确场景切换：{cues}；不得仅因总对白少于15秒而合并为同一时空")
            for item in example["items"]:
                if item["type"] == "dialogue":
                    review = "（说话人待复核）" if item.get("speaker_needs_review") else ""
                    cue = item.get("performance_cue")
                    cue_note = f"［现场提示：{cue}］" if cue else ""
                    lines.append(f"- 生成对白｜{item['speaker']}{review}：{item['text']}{cue_note}")
                elif item["type"] == "narration_context":
                    lines.append(f"- 旁白（只作画面参考，不生成）：{item['text']}")
                elif item["type"] == "visual_note":
                    lines.append(f"- 画面参考：{item['text']}")
                else:
                    lines.append(f"- 画面/动作参考：{item['text']}")
            lines.append("")

    if data["review_flags"]:
        lines.extend(["## 需要人工复核", ""])
        lines.extend(f"- {flag}" for flag in data["review_flags"])
        lines.append("")

    lines.extend([
        "## 审批",
        "",
        "- [ ] 最小案例数量正确",
        "- [ ] 每个生成分镜均为4—15秒",
        "- [ ] 超过15秒的最小案例已在内部合理拆分",
        "- [ ] 对白与说话人正确",
        "- [ ] 旁白不生成",
        "- [ ] 可以进入首帧与视频提示词规划",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="提取审计科普 Word 脚本中的故事段")
    parser.add_argument("input", type=Path, help="输入 .docx 文件")
    parser.add_argument("--json", dest="json_output", type=Path, required=True, help="JSON 输出路径")
    parser.add_argument("--markdown", dest="markdown_output", type=Path, help="可选 Markdown 复核稿路径")
    args = parser.parse_args()

    if not args.input.exists():
        parser.error(f"输入文件不存在：{args.input}")
    if args.input.suffix.lower() != ".docx":
        parser.error("当前仅支持 .docx 文件")

    data = extract(args.input)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.markdown_output:
        args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_output.write_text(render_markdown(data), encoding="utf-8")

    example_count = sum(len(section["examples"]) for section in data["sections"])
    print(f"已提取 {len(data['sections'])} 个主题、{example_count} 个示例。")
    print(f"JSON：{args.json_output.resolve()}")
    if args.markdown_output:
        print(f"Markdown：{args.markdown_output.resolve()}")


if __name__ == "__main__":
    main()
