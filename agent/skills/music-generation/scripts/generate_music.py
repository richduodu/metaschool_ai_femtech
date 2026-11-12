#!/usr/bin/env python3
"""Stage background music mood specification for server-side synthesis."""

import argparse
import json
import os

MOOD_PROMPTS = {
    "chill": (
        "Create a 30-second subtle ambient track. "
        "Soft pads, gentle electric piano, light warm beats. "
        "Instrumental only, no vocals."
    ),
    "tech": (
        "Create a 30-second modern electronic radio show intro track. "
        "Clean synths, subtle electronic pulse, forward-looking sound. "
        "Instrumental only, no vocals."
    ),
    "debate": (
        "Create a 30-second dramatic discussion show intro track. "
        "Building tension, confident synth brass, measured intensity. "
        "Instrumental only, no vocals."
    ),
}
MOOD_PROMPTS["default"] = MOOD_PROMPTS["tech"]


def main():
    parser = argparse.ArgumentParser(description="Stage background music plan")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--mood", default="default", choices=list(MOOD_PROMPTS.keys()))
    args = parser.parse_args()

    plan_path = os.path.join(args.workspace, "data", "music_plan.json")
    os.makedirs(os.path.dirname(plan_path), exist_ok=True)
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump({"mood": args.mood, "prompt": MOOD_PROMPTS[args.mood]}, f, indent=2)

    print(f"✅ Staged studio background music cue (mood='{args.mood}') -> {plan_path}")


if __name__ == "__main__":
    main()
