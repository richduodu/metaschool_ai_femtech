#!/usr/bin/env python3
"""Validate or stage the AI Talk Radio script for server-side synthesis.

Zero external network or Gemini API calls are made inside the sandbox.
If {workspace}/data/script.md already exists (authored by the Managed Agent),
validates speaker turns and records {workspace}/data/script_request.json.
Otherwise stages {workspace}/data/script_request.json from research/*.md so
the studio server generates script.md server-side.
"""

import argparse
import json
import os

VALID_STYLES = ["default", "debate", "roundtable", "interview", "explainer"]


def count_turns(script_text: str) -> int:
    turns = 0
    for line in script_text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("```"):
            continue
        if ":" in s and 0 < s.index(":") < 40:
            turns += 1
    return turns


def main():
    parser = argparse.ArgumentParser(description="Validate/stage AI Talk Radio script")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--style", default="default", choices=VALID_STYLES)
    parser.add_argument("--duration", type=int, default=3)
    parser.add_argument("--context", default="")
    args = parser.parse_args()

    data_dir = os.path.join(args.workspace, "data")
    research_dir = os.path.join(data_dir, "research")
    os.makedirs(data_dir, exist_ok=True)

    research = ""
    if os.path.isdir(research_dir):
        for fname in sorted(os.listdir(research_dir)):
            if fname.endswith(".md"):
                with open(os.path.join(research_dir, fname), "r", encoding="utf-8") as f:
                    research += f.read() + "\n\n"

    script_path = os.path.join(data_dir, "script.md")
    req_path = os.path.join(data_dir, "script_request.json")

    with open(req_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "style": args.style,
                "duration": args.duration,
                "context": args.context,
                "research": research,
            },
            f,
            indent=2,
        )

    if os.path.exists(script_path):
        with open(script_path, "r", encoding="utf-8") as f:
            script = f.read()
        turns = count_turns(script)
        words = len(script.split())
        if turns >= 2:
            print(f"✅ Validated radio script at {script_path} ({turns} speaker turns, {words} words)")
            return

    print(
        f"ℹ️ Staged script specification at {req_path} ({len(research)} chars of research). "
        f"Tip: write the dialogue directly to {script_path} (Paul: / Caller: [Male|Female] [Accent: ...] ...) "
        "or let the studio host synthesize it from script_request.json."
    )


if __name__ == "__main__":
    main()
