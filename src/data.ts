import sampleShows from './sampleShows.json';
import { RadioShow, RawRadioShow } from './types';

export const DEFAULT_COVER_IMAGE =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="50%" stop-color="#1e1b4b"/>
          <stop offset="100%" stop-color="#312e81"/>
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8"/>
          <stop offset="100%" stop-color="#818cf8"/>
        </linearGradient>
      </defs>
      <rect width="800" height="800" fill="url(#bg)"/>
      <circle cx="400" cy="360" r="250" fill="none" stroke="#6366f1" stroke-opacity="0.18" stroke-width="2"/>
      <circle cx="400" cy="360" r="190" fill="none" stroke="#38bdf8" stroke-opacity="0.25" stroke-width="2"/>
      <circle cx="400" cy="360" r="130" fill="none" stroke="#818cf8" stroke-opacity="0.35" stroke-width="3"/>
      <circle cx="400" cy="360" r="56" fill="url(#accent)"/>
      <rect x="388" y="328" width="24" height="44" rx="12" fill="#0f172a"/>
      <path d="M372 356 a28 28 0 0 0 56 0" fill="none" stroke="#0f172a" stroke-width="6" stroke-linecap="round"/>
      <line x1="400" y1="384" x2="400" y2="400" stroke="#0f172a" stroke-width="6" stroke-linecap="round"/>
      <text x="400" y="660" text-anchor="middle" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif" font-size="44" font-weight="800" letter-spacing="6">AI TALK RADIO</text>
      <text x="400" y="706" text-anchor="middle" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="500" letter-spacing="4">LIVE STUDIO BROADCAST</text>
    </svg>`
  );

function parseTimecode(time: string): number {
  const parts = String(time || "0:00").split(':').map(Number);
  const mins = Number.isFinite(parts[0]) ? parts[0] : 0;
  const secs = Number.isFinite(parts[1]) ? parts[1] : 0;
  return mins * 60 + secs;
}

export function transformShow(raw: RawRadioShow): RadioShow {
  const rawLines = Array.isArray(raw.timecoded_transcript) ? raw.timecoded_transcript : [];
  const transcript = rawLines.map((line, i, arr) => {
    const start = parseTimecode(line.timecode);
    const nextLine = arr[i + 1];
    const end = nextLine ? parseTimecode(nextLine.timecode) : parseTimecode(raw.show_duration);
    
    return {
      start,
      end,
      speaker: line.speaker,
      text: line.text,
    };
  });

  return {
    title: raw.show_title,
    duration: parseTimecode(raw.show_duration),
    summary: raw.two_sentence_summary,
    date: raw.date_of_generation,
    host: rawLines[0]?.speaker || "Paul",
    coverImage: raw.coverImage || DEFAULT_COVER_IMAGE,
    audioUrl: raw.audioUrl || "",
    notesUrl: raw.notesUrl,
    transcript,
    script: raw.script,
  };
}

export const SAMPLE_SHOWS: RadioShow[] = sampleShows.map(transformShow);
