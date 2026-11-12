# AGENTS.md — AI Talk Radio

An AI agent that turns **any content source** into a radio show. Give it a topic, a URL, a GitHub repo, a research paper, or just say "Hacker News" — the agent researches the content, writes a multi-caller radio script with host Paul and callers representing opposing views, and stages the metadata and production cues so the studio server synthesizes multi-voice TTS with telephone effects, ambient music, and cover art.

## Workspace

All work is performed in the `./workspace` directory. All paths are relative to `./workspace` unless absolute.

## Before You Do Anything

> [!NOTE]
> For security isolation, all Gemini media synthesis (TTS speech, Lyria background music, final mixing, and cover art image generation) runs automatically on the studio host server right after your sandbox scripts stage the production artifacts. No API keys are needed inside the sandbox!
> If the user pasted an external URL or asked for Hacker News, the server also pre-fetches external article text into `/.agents/prefetched_research/` (`fetch_url.py` and `fetch_hn.py` automatically load those pre-fetched articles, and you also have `url_context` and `google_search` tools enabled for any external web page!).

## Workflow

> [!IMPORTANT]
> **Bias for Action**: Do NOT ask for approval before executing commands, running scripts, or proceeding to the next step. Proceed autonomously.

Upon execution, run in order:

1. **Research** — gather source material based on the user's prompt into `./workspace/data/research/*.md`:
   - Hacker News: run `fetch_hn.py --workspace ./workspace --mode scan --top 10`, pick 2-3 safe tech/science stories, then run `fetch_hn.py --workspace ./workspace --mode deep-dive --stories <ids>` (which automatically includes linked external article text when pre-fetched, or use `url_context` / `google_search` to read the linked articles!).
   - GitHub repo: run `fetch_github.py --repo <owner/repo> --workspace ./workspace`.
   - External URL / blog / article: run `fetch_url.py --url <url> --workspace ./workspace` (loads server-prefetched article text or fetches allowlisted hosts; if unavailable, use your `url_context` or `google_search` tool and write the extracted summary to `./workspace/data/research/url_research.md`).
   - General topic: use `google_search` (and `url_context`) and write grounded findings to `./workspace/data/research/topic.md`.

2. **Write Script (`./workspace/data/script.md`)** — write the full radio dialogue directly to `./workspace/data/script.md` following these rules, then validate it with `python3 /.agents/skills/script-writing/scripts/generate_script.py --workspace ./workspace --style <style>`:
   - Host: `Paul:` (calm, articulate British moderator in a London studio).
   - Callers: `CallerName: [Male|Female] [Accent: <city/country accent>] [emotion tag] ...` (spontaneous, conversational, opposing or complementary angles depending on `--style`: `debate`, `roundtable`, `interview`, `explainer`).
   - Paul MUST introduce each new caller by name and city before their first line.
   - Target ~450-500 words (or ~125 words per requested minute). Ground every claim strictly in `./workspace/data/research/*.md`.

3. **Stage Speech, Music, Metadata & Cover Plans** — run the production staging pipeline:
   ```bash
   python3 /.agents/skills/tts-generation/scripts/generate_tts.py --workspace ./workspace && \
   python3 /.agents/skills/music-generation/scripts/generate_music.py --workspace ./workspace --mood <chill|tech|debate> && \
   python3 /.agents/skills/audio-mixing/scripts/mix_audio.py --workspace ./workspace && \
   python3 /.agents/skills/metadata-generation/scripts/generate_metadata.py --workspace ./workspace --title "<Catchy 3-6 Word Show Title>" --summary "<Concise two-sentence summary of the episode>" && \
   python3 /.agents/skills/cover-image-generation/scripts/generate_image.py --workspace ./workspace --metadata ./workspace/data/show_notes.json
   ```

> [!IMPORTANT]
> When providing the final summary to the user, do NOT include markdown links or URLs to the generated files or scripts (e.g. `[fetch_hn.py](file:///.agents...)`). Just use the plain file name (e.g. `fetch_hn.py`).

## Content Rules

- **NO FAKE DATA**: All stories, insights, and perspectives must come from real research gathered in step 1.
- **Topics to AVOID — strictly off-limits**: Politics, international conflicts/wars/geopolitics, race/ethnicity, religion, historical controversies, gender/sexuality culture wars, immigration, or profanity. Stick to technology, software, programming, open source, AI/ML, science, engineering, developer tools, startups, product launches, creative projects, and tech culture.
