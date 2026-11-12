#!/usr/bin/env python3
"""Fetch and extract content from any URL for AI Talk Radio research.

Automatically checks /.agents/prefetched_research/manifest.json first for
SSRF-validated external articles pre-fetched by the Node server, falling back
to direct sandbox HTTP for allowlisted domains (GitHub, arXiv, HN).
"""

import argparse
import json
import os
import re
import urllib.request
from datetime import datetime

PREFETCH_MANIFEST = "/.agents/prefetched_research/manifest.json"


def load_prefetched_markdown(url: str) -> str | None:
    if not os.path.exists(PREFETCH_MANIFEST):
        return None
    try:
        with open(PREFETCH_MANIFEST, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        normalized = url.rstrip("/")
        for candidate in (url, normalized, normalized + "/"):
            entry = manifest.get(candidate)
            if isinstance(entry, dict) and entry.get("file") and os.path.exists(entry["file"]):
                with open(entry["file"], "r", encoding="utf-8") as af:
                    return af.read()
    except Exception as e:
        print(f"  [WARN] Could not read prefetch manifest: {e}")
    return None


def fetch_page(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "AI-Radio/1.0 (Content Research)",
            "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_html(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<nav[^>]*>.*?</nav>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<footer[^>]*>.*?</footer>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<header[^>]*>.*?</header>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<h1[^>]*>(.*?)</h1>", r"\n# \1\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<h2[^>]*>(.*?)</h2>", r"\n## \1\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<h3[^>]*>(.*?)</h3>", r"\n### \1\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>(.*?)</li>", r"- \1", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</?p[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    for old, new in [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", '"'),
        ("&#39;", "'"),
        ("&nbsp;", " "),
        ("&#x27;", "'"),
        ("&mdash;", "—"),
        ("&ndash;", "–"),
    ]:
        text = text.replace(old, new)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def extract_title(html: str) -> str | None:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if match:
        return re.sub(r"<[^>]+>", "", match.group(1)).strip()
    return None


def extract_meta_description(html: str) -> str | None:
    match = re.search(
        r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']',
        html,
        re.IGNORECASE,
    )
    return match.group(1).strip() if match else None


def main():
    parser = argparse.ArgumentParser(description="Fetch URL content for AI Talk Radio")
    parser.add_argument("--url", required=True, help="URL to fetch content from")
    parser.add_argument("--workspace", default="workspace", help="Workspace directory")
    parser.add_argument("--max-chars", type=int, default=8000, help="Max chars to extract")
    args = parser.parse_args()

    out_dir = os.path.join(args.workspace, "data", "research")
    os.makedirs(out_dir, exist_ok=True)
    safe_name = re.sub(r"[^a-zA-Z0-9]", "_", args.url)[:60]
    out_path = os.path.join(out_dir, f"url_{safe_name}.md")

    print("=== AI Talk Radio Research: URL Content ===")
    print(f"URL: {args.url}\n")

    prefetched = load_prefetched_markdown(args.url)
    if prefetched:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(prefetched)
        print(f"✅ Loaded pre-fetched external article content ({len(prefetched)} chars) -> {out_path}")
        return

    print("Fetching page directly...")
    try:
        html = fetch_page(args.url)
    except Exception as e:
        print(f"  NOTE: Direct sandbox HTTP could not reach {args.url}: {e}")
        print(
            "  Use your built-in url_context or google_search tool to read this URL "
            f"and save the extracted summary to {out_path}."
        )
        raise SystemExit(1)

    title = extract_title(html) or args.url
    description = extract_meta_description(html)
    text = strip_html(html)
    if len(text) > args.max_chars:
        text = text[: args.max_chars] + f"\n\n*(content truncated at {args.max_chars} characters)*"

    lines = [
        f"# URL Content: {title} — {datetime.now().strftime('%B %d, %Y')}\n",
        f"- **Source URL**: {args.url}",
    ]
    if description:
        lines.append(f"- **Description**: {description}")
    lines.extend(["", "## Content\n", text, "\n---\n"])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"\n✅ Research saved to {out_path} ({len(text)} chars)")


if __name__ == "__main__":
    main()
