#!/usr/bin/env python3
"""Stage audio mixing configuration (or mix locally if speech.wav is present)."""

import argparse
import json
import os


def main():
    parser = argparse.ArgumentParser(description="Stage AI Talk Radio audio mix")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    args = parser.parse_args()

    plan_path = os.path.join(args.workspace, "data", "mix_plan.json")
    os.makedirs(os.path.dirname(plan_path), exist_ok=True)
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "intro_fade_in_ms": 1000,
                "intro_fade_out_ms": 3000,
                "outro_fade_in_ms": 3000,
                "outro_fade_out_ms": 1000,
                "music_duck_db": -15,
            },
            f,
            indent=2,
        )
    print(f"✅ Staged broadcast mix specification -> {plan_path}")


if __name__ == "__main__":
    main()
