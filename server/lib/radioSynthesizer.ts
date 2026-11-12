import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { GoogleGenAI } from "@google/genai";
import { API_BASE_URL } from "./agentClient.ts";

const execFileAsync = util.promisify(execFile);

const SAMPLE_RATE = 24000;
const FEMALE_VOICES = ["Kore", "Aoede"];
const MALE_VOICES = ["Charon", "Fenrir", "Puck"];

const PROFILES: Record<string, { profile: string; scene: string; notes: string }> = {
  Paul: {
    profile:
      "# AUDIO PROFILE: Paul\n## Role: Community Radio Host\n## Persona: Professional, warm, and engaging British radio host.",
    scene:
      "## THE SCENE: The London Studio\nA professional studio in London. Paul is sitting comfortably, speaking into a high-quality microphone with a warm and authoritative tone.",
    notes:
      "### DIRECTOR'S NOTES\nStyle: Professional, warm, engaging, and measured.\nPacing: Steady but dynamic.\nAccent: British English accent as heard in London, England.",
  },
  default_caller: {
    profile:
      "# AUDIO PROFILE: Caller\n## Role: Tech-savvy individual calling in to a radio show.\n## Persona: Nerdy, conversational, not a professional broadcaster.",
    scene:
      "## THE SCENE: Remote Location via Phone\nCalling in from a home, office, or public space. The audio quality is that of a telephone call.",
    notes:
      "### DIRECTOR'S NOTES\nStyle: Conversational, natural.\nPacing: Normal conversational pace.\nAccent: American English.",
  },
};

const COVER_STYLES = [
  " centered on the cover. The background is a vibrant purple with a textured water ripple effect that covers the entire frame, creating a dynamic and clean aesthetic.",
  ". The background is a dark slate blue and charcoal gray with abstract technical blueprints and database diagrams, creating a technical and sophisticated aesthetic.",
  ". The background is a warm orange gradient with clean geometric shapes and subtle grain texture, creating a modern and energetic aesthetic.",
  " in white. The background features abstract organic shapes in earthy tones of terracotta and sage green, with a linen texture, creating a calm and natural aesthetic.",
  ". The background is a dark moody scene with abstract light leaks and smoke effects in deep blue and crimson, creating a dramatic and mysterious aesthetic.",
  ". The background is a composition of flat color blocks in a Swiss design style (red, black, yellow) with bold typography and negative space, creating a clean and powerful aesthetic.",
];

const MOOD_PROMPTS: Record<string, string> = {
  chill:
    "Create a 30-second subtle ambient track. Soft pads, gentle electric piano, light warm beats. Perfect as background music for a calm conversation. Instrumental only, no vocals.",
  tech:
    "Create a 30-second modern electronic radio show intro track. Clean synths, subtle electronic pulse, forward-looking and innovative sound. Instrumental only, no vocals.",
  debate:
    "Create a 30-second dramatic discussion show intro track. Building tension, confident synth brass, measured intensity. Instrumental only, no vocals.",
};

interface ParsedTurn {
  index: number;
  speaker: string;
  ttsText: string;
  cleanText: string;
  voice: string;
  accent: string;
  boost: boolean;
  isCaller: boolean;
}

export function parseRadioScriptTurns(scriptText: string): ParsedTurn[] {
  const rawTurns: Array<{ speaker: string; text: string }> = [];
  for (const rawLine of scriptText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("---")) {
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < 40) {
      const speaker = line.slice(0, colonIdx).replace(/^\*+|\*+$/g, "").trim();
      const text = line.slice(colonIdx + 1).trim();
      if (speaker && text) {
        rawTurns.push({ speaker, text });
      }
    }
  }

  const assignedVoices: Record<string, string> = { Paul: "Puck" };
  const assignedAccents: Record<string, string> = {
    Paul: "British English accent as heard in London, England",
  };
  let femaleIndex = 0;
  let maleIndex = 0;

  return rawTurns.map((turn, index) => {
    let text = turn.text;
    let gender: "Male" | "Female" = "Male";
    if (/\[Female\]/i.test(text)) {
      gender = "Female";
      text = text.replace(/\[Female\]/gi, "").trim();
    } else if (/\[Male\]/i.test(text)) {
      gender = "Male";
      text = text.replace(/\[Male\]/gi, "").trim();
    }

    let accent = "American English";
    const accentMatch = /\[Accent:\s*([^\]]+)\]/i.exec(text);
    if (accentMatch) {
      accent = accentMatch[1].trim();
      text = text.replace(/\[Accent:\s*[^\]]+\]/gi, "").trim();
    }

    let boost = false;
    if (/\[boost\]/i.test(text)) {
      boost = true;
      text = text.replace(/\[boost\]/gi, "").trim();
    }

    const speaker = turn.speaker;
    const isCaller = speaker.toLowerCase() !== "paul";
    if (!assignedVoices[speaker]) {
      if (gender === "Female") {
        assignedVoices[speaker] = FEMALE_VOICES[femaleIndex % FEMALE_VOICES.length];
        femaleIndex++;
      } else {
        assignedVoices[speaker] = MALE_VOICES[maleIndex % MALE_VOICES.length];
        maleIndex++;
      }
    }
    if (!assignedAccents[speaker]) {
      assignedAccents[speaker] = accent;
    }

    const cleanText = text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim() || text;
    return {
      index,
      speaker,
      ttsText: text,
      cleanText,
      voice: assignedVoices[speaker],
      accent: assignedAccents[speaker],
      boost,
      isCaller,
    };
  });
}

function stripWavHeaderIfPresent(buf: Buffer): Buffer {
  if (
    buf.length >= 44 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        const start = offset + 8;
        const end = Math.min(buf.length, start + chunkSize);
        return buf.subarray(start, end);
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return buf.subarray(44);
  }
  return buf;
}

function biquadFilter(
  samples: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/**
 * Pure-TypeScript 24kHz telephone bandpass filter (300Hz - 3400Hz) + codec dynamics.
 */
function applyTelephoneFilterPcm16(pcmBuf: Buffer, boost: boolean): Buffer {
  const sampleCount = Math.floor(pcmBuf.length / 2);
  if (sampleCount === 0) return pcmBuf;

  let floatSamples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floatSamples[i] = pcmBuf.readInt16LE(i * 2) / 32768;
  }

  // 2nd-order Butterworth High-Pass at 300Hz (fs = 24000)
  {
    const w0 = (2 * Math.PI * 300) / SAMPLE_RATE;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;
    const a0 = 1 + alpha;
    floatSamples = biquadFilter(
      floatSamples,
      (1 + cosW0) / 2 / a0,
      -(1 + cosW0) / a0,
      (1 + cosW0) / 2 / a0,
      (-2 * cosW0) / a0,
      (1 - alpha) / a0,
    );
  }

  // 2nd-order Butterworth Low-Pass at 3400Hz (fs = 24000)
  {
    const w0 = (2 * Math.PI * 3400) / SAMPLE_RATE;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;
    const a0 = 1 + alpha;
    floatSamples = biquadFilter(
      floatSamples,
      (1 - cosW0) / 2 / a0,
      (1 - cosW0) / a0,
      (1 - cosW0) / 2 / a0,
      (-2 * cosW0) / a0,
      (1 - alpha) / a0,
    );
  }

  // Soft-knee telephone compression + gain boost
  const gain = boost ? 1.75 : 1.45;
  const outBuf = Buffer.allocUnsafe(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const amplified = floatSamples[i] * gain;
    const compressed = Math.tanh(amplified * 1.35) / Math.tanh(1.35);
    const clamped = Math.max(-0.98, Math.min(0.98, compressed));
    outBuf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return outBuf;
}

/**
 * Adds subtle studio intro & outro ambient harmonic bed directly into 24kHz PCM
 * when external Lyria/ffmpeg mixing is unavailable.
 */
function mixAmbientIntroOutroPadPcm16(speechPcm: Buffer, mood: string): Buffer {
  const totalSamples = Math.floor(speechPcm.length / 2);
  if (totalSamples === 0) return speechPcm;
  const out = Buffer.from(speechPcm);

  const freqs =
    mood.toLowerCase().includes("debate")
      ? [146.83, 220.0, 293.66, 369.99]
      : mood.toLowerCase().includes("chill")
        ? [174.61, 220.0, 261.63, 329.63]
        : [196.0, 246.94, 293.66, 392.0];

  const bedSamples = Math.min(totalSamples, SAMPLE_RATE * 10);
  const applyWindow = (startSample: number, lengthSamples: number, isOutro: boolean) => {
    for (let i = 0; i < lengthSamples; i++) {
      const idx = startSample + i;
      if (idx < 0 || idx >= totalSamples) continue;
      const t = i / SAMPLE_RATE;
      const progress = i / Math.max(1, lengthSamples);
      const env = isOutro
        ? Math.sin(Math.min(1, progress * 2.2) * (Math.PI / 2)) * (1 - Math.pow(progress, 3))
        : Math.min(1, i / (SAMPLE_RATE * 0.8)) * Math.pow(1 - progress, 1.6);

      let pad = 0;
      for (let fIdx = 0; fIdx < freqs.length; fIdx++) {
        pad += Math.sin(2 * Math.PI * freqs[fIdx] * t) * (1 / freqs.length);
      }
      const padSample = pad * 0.045 * env;
      const dry = out.readInt16LE(idx * 2) / 32768;
      const mixed = Math.max(-0.99, Math.min(0.99, dry + padSample));
      out.writeInt16LE(Math.round(mixed * 32767), idx * 2);
    }
  };

  applyWindow(0, bedSamples, false);
  if (totalSamples > bedSamples * 2) {
    applyWindow(totalSamples - bedSamples, bedSamples, true);
  }
  return out;
}

export function buildWavBuffer(pcm16Mono: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const evenLen = pcm16Mono.length - (pcm16Mono.length % 2);
  const pcm = evenLen === pcm16Mono.length ? pcm16Mono : pcm16Mono.subarray(0, evenLen);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM = 1
  header.writeUInt16LE(1, 22); // Mono = 1
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  header.writeUInt16LE(2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesizeTurnPcm(
  ai: GoogleGenAI,
  apiKey: string,
  turn: ParsedTurn,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const profile = PROFILES[turn.speaker] || PROFILES.default_caller;
  const notes = profile.notes.replace(/Accent:.*/, `Accent: ${turn.accent}`);
  const prompt = `${profile.profile}\n\n${profile.scene}\n\n${notes}\n\n#### TRANSCRIPT\n${turn.ttsText}\n`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");

    // 1. Try gemini-3.1-flash-tts-preview via Interactions API
    try {
      const res = await fetch(`${API_BASE_URL}/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model: "gemini-3.1-flash-tts-preview",
          input: prompt,
          response_modalities: ["audio"],
          generation_config: {
            speech_config: [{ voice: turn.voice, language: "en-US" }],
          },
          store: false,
        }),
        signal,
      });
      if (res.ok) {
        const data: any = await res.json();
        const steps = Array.isArray(data?.steps) ? data.steps : [];
        for (const step of steps) {
          const content = Array.isArray(step?.content) ? step.content : [];
          for (const item of content) {
            if (
              (item?.type === "audio" || String(item?.mime_type || "").startsWith("audio/")) &&
              typeof item?.data === "string"
            ) {
              const raw = stripWavHeaderIfPresent(Buffer.from(item.data, "base64"));
              if (raw.length > 0) {
                return turn.isCaller ? applyTelephoneFilterPcm16(raw, turn.boost) : raw;
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
    }

    // 2. Fallback to gemini-2.5-flash-preview-tts via generateContent
    try {
      const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ role: "user", parts: [{ text: `Say naturally (${turn.accent}): ${turn.cleanText}` }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: turn.voice },
            },
          },
        },
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        const b64 = part.inlineData?.data;
        if (typeof b64 === "string" && b64.length > 0) {
          const raw = stripWavHeaderIfPresent(Buffer.from(b64, "base64"));
          if (raw.length > 0) {
            return turn.isCaller ? applyTelephoneFilterPcm16(raw, turn.boost) : raw;
          }
        }
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  return null;
}

async function tryGenerateLyriaMusic(
  apiKey: string,
  mood: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const moodKey = mood.toLowerCase().includes("debate")
    ? "debate"
    : mood.toLowerCase().includes("chill")
      ? "chill"
      : "tech";
  const prompt = MOOD_PROMPTS[moodKey] || MOOD_PROMPTS.tech;
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);

  try {
    const res = await fetch(`${API_BASE_URL}/interactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify({
        model: "lyria-3-clip-preview",
        input: prompt,
        store: false,
      }),
      signal: timeoutSignal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    for (const step of Array.isArray(data?.steps) ? data.steps : []) {
      for (const item of Array.isArray(step?.content) ? step.content : []) {
        if (
          (item?.type === "audio" || String(item?.mime_type || "").startsWith("audio/")) &&
          typeof item?.data === "string"
        ) {
          return Buffer.from(item.data, "base64");
        }
      }
    }
  } catch {
    // Lyria is optional; proceed gracefully without it
  }
  return null;
}

async function tryEncodeAndMixWithFfmpeg(
  speechWav: Buffer,
  musicMp3: Buffer | null,
): Promise<{ buffer: Buffer; mimeType: "audio/mp3" } | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "airadio-mix-"));
  try {
    const speechPath = path.join(tmpDir, "speech.wav");
    const outMp3Path = path.join(tmpDir, "ai_radio.mp3");
    fs.writeFileSync(speechPath, speechWav);

    if (musicMp3 && musicMp3.length > 0) {
      const musicPath = path.join(tmpDir, "music.mp3");
      fs.writeFileSync(musicPath, musicMp3);
      const speechDurSec = Math.max(0, speechWav.length - 44) / (SAMPLE_RATE * 2);
      const totalDurSec = speechDurSec + 1.0;
      const outroDelayMs = Math.max(0, Math.round((totalDurSec - 15.0) * 1000));
      const masterFadeOutSt = Math.max(0, Number((totalDurSec - 2.0).toFixed(3)));
      const outroChain =
        outroDelayMs > 0
          ? `[1:a]atrim=0:15,asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=3,afade=t=out:st=14:d=1,adelay=${outroDelayMs}:all=1[outro]`
          : "[1:a]atrim=0:15,asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=3,afade=t=out:st=14:d=1[outro]";
      const filterComplex = `[1:a]atrim=0:15,asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=1,afade=t=out:st=12:d=3[intro];${outroChain};[0:a]apad=pad_dur=1[sp];[sp][intro][outro]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=0.5,afade=t=out:st=${masterFadeOutSt}:d=2`;
      await execFileAsync("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        speechPath,
        "-i",
        musicPath,
        "-filter_complex",
        filterComplex,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        outMp3Path,
      ]);
    } else {
      await execFileAsync("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        speechPath,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        outMp3Path,
      ]);
    }

    if (fs.existsSync(outMp3Path)) {
      const mp3Buf = fs.readFileSync(outMp3Path);
      if (mp3Buf.length > 0) {
        return { buffer: mp3Buf, mimeType: "audio/mp3" };
      }
    }
  } catch {
    // ffmpeg not installed or codec unavailable — caller falls back to WAV
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
  return null;
}

async function generateScriptIfMissing(
  ai: GoogleGenAI,
  researchText: string,
  topic: string,
  durationMinutes: number,
  mood: string,
): Promise<string> {
  const targetWords = Math.max(250, Math.min(900, durationMinutes * 125));
  const prompt = `You are a scriptwriter for "AI Talk Radio", a community radio show for a tech-savvy audience.
Write a ~${durationMinutes}-minute (~${targetWords} words) radio script about "${topic}" with tone/mood "${mood}".
Host: Paul (calm, articulate British moderator from London).
Callers: 2-4 callers from different cities around the world with distinct viewpoints.
Formatting rules:
- Every spoken line MUST start with \`Paul:\` or \`CallerName:\`
- Every caller line MUST start with \`[Male]\` or \`[Female]\` and \`[Accent: <accent>]\` plus an emotion tag like \`[excitedly]\` or \`[skeptically]\`.
- Ground every claim strictly in the research below. Do NOT fabricate facts.

RESEARCH:
${researchText.slice(0, 18000)}`;

  const resp = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });
  return resp.text?.trim() || "";
}

async function generateMetadataFromScript(
  ai: GoogleGenAI,
  scriptText: string,
  topic: string,
  existingNotes: any,
): Promise<{ show_title: string; two_sentence_summary: string }> {
  if (
    existingNotes &&
    typeof existingNotes.show_title === "string" &&
    existingNotes.show_title.trim() &&
    existingNotes.show_title !== "AI Talk Radio Broadcast" &&
    typeof existingNotes.two_sentence_summary === "string" &&
    existingNotes.two_sentence_summary.trim()
  ) {
    return {
      show_title: existingNotes.show_title.trim(),
      two_sentence_summary: existingNotes.two_sentence_summary.trim(),
    };
  }

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Given this radio show script about "${topic}", return ONLY a JSON object with keys "show_title" (catchy episode title, max 6 words) and "two_sentence_summary" (concise two-sentence summary of the discussion):\n\n${scriptText.slice(0, 8000)}`,
      config: {
        responseMimeType: "application/json",
      },
    });
    const parsed = JSON.parse(resp.text || "{}");
    if (typeof parsed.show_title === "string" && typeof parsed.two_sentence_summary === "string") {
      return {
        show_title: parsed.show_title.trim(),
        two_sentence_summary: parsed.two_sentence_summary.trim(),
      };
    }
  } catch {
    // fallback below
  }

  return {
    show_title: existingNotes?.show_title || `AI Radio: ${topic.slice(0, 36)}`,
    two_sentence_summary:
      existingNotes?.two_sentence_summary ||
      `Host Paul and international callers unpack key developments and contrasting viewpoints around ${topic}.`,
  };
}

async function generateCoverPngBase64(
  ai: GoogleGenAI,
  apiKey: string,
  title: string,
  customPrompt?: string,
  signal?: AbortSignal,
): Promise<{ base64: string; mimeType: string } | null> {
  const style = COVER_STYLES[Math.floor(Math.random() * COVER_STYLES.length)];
  const prompt =
    (customPrompt && customPrompt.trim()) ||
    `A professional podcast cover image for a show titled '${title}' on the 'AI Talk Radio' station. The design features the text '${title}' in a bold, stylish font${style} Image must be a 1:1 aspect ratio.`;

  // 1. Try Interactions API image models
  for (const modelName of ["gemini-3.1-flash-image", "gemini-2.5-flash-image"]) {
    if (signal?.aborted) return null;
    try {
      const res = await fetch(`${API_BASE_URL}/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model: modelName,
          input: [{ type: "text", text: prompt }],
          response_format: { type: "image" },
          store: false,
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
          : AbortSignal.timeout(25000),
      });
      if (res.ok) {
        const data: any = await res.json();
        for (const step of Array.isArray(data?.steps) ? data.steps : []) {
          for (const item of Array.isArray(step?.content) ? step.content : []) {
            if (
              (item?.type === "image" || String(item?.mime_type || "").startsWith("image/")) &&
              typeof item?.data === "string"
            ) {
              return {
                base64: item.data,
                mimeType: typeof item.mime_type === "string" ? item.mime_type : "image/png",
              };
            }
          }
        }
      }
    } catch {
      // try next model
    }
  }

  // 2. Fallback to generateContent with gemini-2.5-flash-image
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
      config: {
        responseModalities: ["IMAGE"],
      },
    });
    for (const part of resp.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.data) {
        return {
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "image/png",
        };
      }
    }
  } catch {
    // fallback to default SVG cover on client/server
  }

  return null;
}

function formatMmSs(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export async function synthesizeRadioShowFromSandbox(opts: {
  extractedFiles: Record<string, Buffer>;
  topic: string;
  duration: string | number;
  mood: string;
  apiKey: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}): Promise<any> {
  const { extractedFiles, topic, mood, apiKey, onProgress, signal } = opts;
  const durationNum = Math.max(1, Math.min(15, Number.parseInt(String(opts.duration || "3"), 10) || 3));
  const ai = new GoogleGenAI({ apiKey });

  let scriptText = "";
  let researchText = "";
  let existingShowNotes: any = null;
  let coverPlanPrompt: string | undefined;
  let musicMood = mood || "tech";

  for (const [filePath, buf] of Object.entries(extractedFiles)) {
    const norm = filePath.replace(/^\.\//, "");
    if (norm.endsWith("radio_script.txt") || norm.endsWith("data/script.md") || norm === "script.md") {
      scriptText = buf.toString("utf8");
    } else if (norm.includes("data/research/") && norm.endsWith(".md")) {
      researchText += `\n\n${buf.toString("utf8")}`;
    } else if (norm.endsWith("show_notes.json")) {
      try {
        existingShowNotes = JSON.parse(buf.toString("utf8"));
      } catch {
        // ignore invalid json
      }
    } else if (norm.endsWith("cover_plan.json")) {
      try {
        const plan = JSON.parse(buf.toString("utf8"));
        if (typeof plan?.prompt === "string") coverPlanPrompt = plan.prompt;
      } catch {
        // ignore
      }
    } else if (norm.endsWith("music_plan.json")) {
      try {
        const plan = JSON.parse(buf.toString("utf8"));
        if (typeof plan?.mood === "string") musicMood = plan.mood;
      } catch {
        // ignore
      }
    } else if (norm.endsWith("script_request.json") && !researchText) {
      try {
        const reqPlan = JSON.parse(buf.toString("utf8"));
        if (typeof reqPlan?.research === "string") researchText = reqPlan.research;
      } catch {
        // ignore
      }
    }
  }

  let turns = parseRadioScriptTurns(scriptText);
  if (turns.length < 2) {
    onProgress("Writing radio broadcast script from research...");
    scriptText = await generateScriptIfMissing(
      ai,
      researchText || `Topic: ${topic}`,
      topic,
      Math.min(durationNum, 5),
      mood,
    );
    turns = parseRadioScriptTurns(scriptText);
  }

  if (turns.length === 0) {
    throw new Error("Could not produce a valid speaker script from the research.");
  }

  onProgress(`Generating speech for ${turns.length} speaker turns...`);

  // Synthesize turns with bounded concurrency (4 workers) + start music generation concurrently
  const pcmByTurn = new Array<Buffer | null>(turns.length).fill(null);
  let nextIdx = 0;
  const workerCount = Math.min(4, turns.length);

  const musicPromise = tryGenerateLyriaMusic(apiKey, musicMood, signal);
  const metaPromise = generateMetadataFromScript(ai, scriptText, topic, existingShowNotes);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIdx < turns.length) {
        const current = nextIdx++;
        pcmByTurn[current] = await synthesizeTurnPcm(ai, apiKey, turns[current], signal);
      }
    }),
  );

  // Assemble speech timeline and compute exact per-turn timecodes
  const interTurnPause = Buffer.alloc(Math.floor(SAMPLE_RATE * 0.32) * 2, 0);
  const introLead = Buffer.alloc(Math.floor(SAMPLE_RATE * 0.5) * 2, 0);
  const outroTail = Buffer.alloc(Math.floor(SAMPLE_RATE * 2.0) * 2, 0);

  const chunks: Buffer[] = [introLead];
  let elapsedSamples = Math.floor(introLead.length / 2);
  const timecodedTranscript: Array<{ timecode: string; speaker: string; text: string }> = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const pcm = pcmByTurn[i];
    timecodedTranscript.push({
      timecode: formatMmSs(elapsedSamples / SAMPLE_RATE),
      speaker: turn.speaker,
      text: turn.cleanText,
    });
    if (pcm && pcm.length > 0) {
      chunks.push(pcm);
      elapsedSamples += Math.floor(pcm.length / 2);
      if (i < turns.length - 1) {
        chunks.push(interTurnPause);
        elapsedSamples += Math.floor(interTurnPause.length / 2);
      }
    } else {
      // Fallback 2s silence if an individual TTS turn failed
      const fallbackPause = Buffer.alloc(SAMPLE_RATE * 2 * 2, 0);
      chunks.push(fallbackPause);
      elapsedSamples += SAMPLE_RATE * 2;
    }
  }
  chunks.push(outroTail);
  elapsedSamples += Math.floor(outroTail.length / 2);

  const combinedSpeechPcm = Buffer.concat(chunks);
  if (combinedSpeechPcm.length <= introLead.length + outroTail.length) {
    throw new Error("Speech synthesis produced no audio segments.");
  }

  onProgress("Mixing broadcast audio and studio ambiance...");
  const [lyriaMp3, meta] = await Promise.all([musicPromise, metaPromise]);

  const rawSpeechWav = buildWavBuffer(combinedSpeechPcm, SAMPLE_RATE);
  const ffmpegMixed = await tryEncodeAndMixWithFfmpeg(rawSpeechWav, lyriaMp3);

  let audioDataUri: string;
  if (ffmpegMixed) {
    audioDataUri = `data:${ffmpegMixed.mimeType};base64,${ffmpegMixed.buffer.toString("base64")}`;
  } else {
    const withAmbientPad = mixAmbientIntroOutroPadPcm16(combinedSpeechPcm, musicMood);
    const finalWav = buildWavBuffer(withAmbientPad, SAMPLE_RATE);
    audioDataUri = `data:audio/wav;base64,${finalWav.toString("base64")}`;
  }

  onProgress("Generating cover image...");
  const coverImg = await generateCoverPngBase64(
    ai,
    apiKey,
    meta.show_title,
    coverPlanPrompt,
    signal,
  );

  const totalSeconds = Math.max(1, Math.round(elapsedSamples / SAMPLE_RATE));
  const todayStr = new Date().toISOString().split("T")[0];

  const showNotes: Record<string, unknown> = {
    show_title: meta.show_title,
    show_duration: formatMmSs(totalSeconds),
    two_sentence_summary: meta.two_sentence_summary,
    date_of_generation: existingShowNotes?.date_of_generation || todayStr,
    timecoded_transcript: timecodedTranscript,
    audioUrl: audioDataUri,
    isBase64Encoded: true,
  };

  if (coverImg) {
    showNotes.coverImage = `data:${coverImg.mimeType};base64,${coverImg.base64}`;
  }

  return showNotes;
}
