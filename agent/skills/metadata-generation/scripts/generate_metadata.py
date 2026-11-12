#!/usr/bin/env python3
"""Generate show_notes.json metadata from script.md without exposing API keys in sandbox."""

import argparse
import json
import os
import re
from datetime import datetime


def build_metadata(script_text: str, title: str | None, summary: str | None) -> dict:
    turns = []
    current_seconds = 0
    for raw_line in script_text.strip().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("```"):
            continue
        if ":" in line:
            parts = line.split(":")
            speaker = parts[0].strip().strip("*")
            text = ":".join(parts[1:]).strip()
            cleaned = re.sub(r"\[[^\]]*\]", "", text)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if not speaker or not cleaned:
                continue
            mins = current_seconds // 60
            secs = current_seconds % 60
            turns.append(
                {
                    "timecode": f"{mins:02d}:{secs:02d}",
                    "speaker": speaker,
                    "text": cleaned,
                }
            )
            word_secs = max(4, round(len(cleaned.split()) / 2.6))
            current_seconds += word_secs

    dur_str = f"{current_seconds // 60:02d}:{current_seconds % 60:02d}"
    today_date = datetime.utcnow().strftime("%Y-%m-%d")

    resolved_title = (title or "").strip() or "AI Talk Radio Broadcast"
    resolved_summary = (summary or "").strip() or (
        "Host Paul and international callers debate key developments, engineering trade-offs, "
        "and contrasting community perspectives from today's research."
    )

    return {
        "show_title": resolved_title,
        "show_duration": dur_str,
        "two_sentence_summary": resolved_summary,
        "date_of_generation": today_date,
        "timecoded_transcript": turns,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate AI Talk Radio show metadata")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--title", default="", help="Optional episode title")
    parser.add_argument("--summary", default="", help="Optional two-sentence episode summary")
    args = parser.parse_args()

    script_path = os.path.join(args.workspace, "data", "script.md")
    output_path = os.path.join(args.workspace, "data", "show_notes.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    script_text = ""
    if os.path.exists(script_path):
        with open(script_path, "r", encoding="utf-8") as f:
            script_text = f.read()

    notes = build_metadata(script_text, args.title, args.summary)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(notes, f, indent=2)

    print(f"✅ Metadata saved to {output_path} (title='{notes['show_title']}', turns={len(notes['timecoded_transcript'])})")


if __name__ == "__main__":
    main()
