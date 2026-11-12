#!/usr/bin/env python3
"""Parse script.md and stage speaker turn voice assignments for server-side TTS.

For security isolation, actual Gemini TTS audio synthesis runs on the Node host
server without exposing API keys inside the sandbox.
"""

import argparse
import json
import os
import re

FEMALE_VOICES = ["Kore", "Aoede"]
MALE_VOICES = ["Charon", "Fenrir", "Puck"]


def split_script_by_turns(script_text: str):
    turns = []
    for line in script_text.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("```"):
            continue
        if ":" in line:
            speaker = line.split(":")[0].strip().strip("*")
            text = ":".join(line.split(":")[1:]).strip()
            if speaker and text:
                turns.append((speaker, text))
    return turns


def main():
    parser = argparse.ArgumentParser(description="Stage TTS voice plan from script.md")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    script_path = os.path.join(args.workspace, "data", "script.md")
    plan_path = os.path.join(args.workspace, "data", "tts_plan.json")
    os.makedirs(os.path.dirname(plan_path), exist_ok=True)

    if not os.path.exists(script_path):
        print(f"ℹ️ {script_path} not yet written; studio server will synthesize turns after script generation.")
        with open(plan_path, "w", encoding="utf-8") as f:
            json.dump({"turns": []}, f)
        return

    with open(script_path, "r", encoding="utf-8") as f:
        script = f.read()

    turns = split_script_by_turns(script)
    assigned_voices = {"Paul": "Puck"}
    assigned_accents = {"Paul": "British English accent as heard in London, England"}
    female_idx = 0
    male_idx = 0
    prepared = []

    for i, (speaker, raw_text) in enumerate(turns):
        text = raw_text
        gender = "Male"
        if "[Female]" in text:
            gender = "Female"
            text = text.replace("[Female]", "").strip()
        elif "[Male]" in text:
            text = text.replace("[Male]", "").strip()

        accent = "American English"
        m = re.search(r"\[Accent:\s*([^\]]+)\]", text)
        if m:
            accent = m.group(1).strip()
            text = re.sub(r"\[Accent:\s*[^\]]+\]", "", text).strip()

        boost = "[boost]" in text
        text = text.replace("[boost]", "").strip()

        if speaker not in assigned_voices:
            if gender == "Female":
                assigned_voices[speaker] = FEMALE_VOICES[female_idx % len(FEMALE_VOICES)]
                female_idx += 1
            else:
                assigned_voices[speaker] = MALE_VOICES[male_idx % len(MALE_VOICES)]
                male_idx += 1
        if speaker not in assigned_accents:
            assigned_accents[speaker] = accent

        prepared.append(
            {
                "index": i,
                "speaker": speaker,
                "text": text,
                "voice": assigned_voices[speaker],
                "accent": assigned_accents[speaker],
                "boost": boost,
                "telephone_filter": speaker != "Paul",
            }
        )

    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump({"turns": prepared}, f, indent=2)

    print(f"✅ Staged {len(prepared)} speaker turns for studio TTS synthesis -> {plan_path}")


if __name__ == "__main__":
    main()
