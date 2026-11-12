#!/usr/bin/env python3
"""Stage cover image prompt plan for server-side Gemini image generation."""

import argparse
import json
import os
import random

BASE_PROMPT = (
    "A professional podcast cover image for a show titled '{title}' on the 'AI Talk Radio' station. "
    "The design features the text '{title}' in a bold, stylish font"
)

PROMPT_STYLES = [
    " centered on the cover. The background is a vibrant purple with a textured water ripple effect that covers the entire frame, creating a dynamic and clean aesthetic.",
    ". The background is a dark slate blue and charcoal gray with abstract technical blueprints and database diagrams, creating a technical and sophisticated aesthetic.",
    ". The background is a warm orange gradient with clean geometric shapes and subtle grain texture, creating a modern and energetic aesthetic.",
    " in white. The background features abstract organic shapes in earthy tones of terracotta and sage green, with a linen texture, creating a calm and natural aesthetic.",
    ". The background is a dark moody scene with abstract light leaks and smoke effects in deep blue and crimson, creating a dramatic and mysterious aesthetic.",
    ". The background is a composition of flat color blocks in a Swiss design style (red, black, yellow) with bold typography and negative space, creating a clean and powerful aesthetic.",
]


def main():
    parser = argparse.ArgumentParser(description="Stage cover image prompt for studio server")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--prompt", help="Custom image prompt")
    parser.add_argument("--metadata", help="Path to show_notes.json metadata file")
    parser.add_argument("--output", help="Unused legacy output image path")
    parser.add_argument("--reference", help="Unused legacy reference image path")
    args = parser.parse_args()

    title = "AI Talk Radio"
    if args.metadata and os.path.exists(args.metadata):
        try:
            with open(args.metadata, "r", encoding="utf-8") as f:
                meta = json.load(f)
            title = meta.get("show_title") or title
        except Exception:
            pass

    prompt = args.prompt or (BASE_PROMPT.format(title=title) + random.choice(PROMPT_STYLES) + " Image must be a 1:1 aspect ratio.")
    plan_path = os.path.join(args.workspace, "data", "cover_plan.json")
    os.makedirs(os.path.dirname(plan_path), exist_ok=True)
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump({"title": title, "prompt": prompt}, f, indent=2)

    print(f"✅ Staged cover art prompt for '{title}' -> {plan_path}")


if __name__ == "__main__":
    main()
