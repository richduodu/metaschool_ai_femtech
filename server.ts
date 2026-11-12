import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { createInteraction, streamInteraction, API_BASE_URL } from "./server/lib/agentClient.ts";
import { extractJsonBlocks } from "./server/lib/jsonExtractor.ts";
import { prefetchTopicAndHnArticles } from "./server/lib/urlPrefetch.ts";
import { synthesizeRadioShowFromSandbox } from "./server/lib/radioSynthesizer.ts";
import { exec } from 'child_process';
import util from 'util';
import fs from "fs";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import admin from "firebase-admin";
import { Transform } from "stream";

const execAsync = util.promisify(exec);

function getGcsBucketName(): string | null {
  const bucket = process.env.GCS_BUCKET_NAME;
  if (!bucket || typeof bucket !== "string" || bucket.trim() === "" || bucket.trim() === "undefined" || bucket.trim() === "null") {
    return null;
  }
  return bucket.trim();
}

function extractTarInMemory(tarBuffer: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    let isEnd = true;
    for (let i = 0; i < 512; i++) {
      if (tarBuffer[offset + i] !== 0) {
        isEnd = false;
        break;
      }
    }
    if (isEnd) break;

    let name = "";
    for (let i = 0; i < 100; i++) {
      const charCode = tarBuffer[offset + i];
      if (charCode === 0) break;
      name += String.fromCharCode(charCode);
    }
    name = name.trim();

    let prefix = "";
    for (let i = 345; i < 500; i++) {
      const charCode = tarBuffer[offset + i];
      if (charCode === 0) break;
      prefix += String.fromCharCode(charCode);
    }
    prefix = prefix.trim();
    if (prefix && name) {
      name = `${prefix}/${name}`;
    }

    let sizeStr = "";
    for (let i = 124; i < 136; i++) {
      const charCode = tarBuffer[offset + i];
      if (charCode === 0 || charCode === 32) continue;
      sizeStr += String.fromCharCode(charCode);
    }
    const size = parseInt(sizeStr, 8);

    const typeflag = tarBuffer[offset + 156];
    const isRegularFile = typeflag === 0 || typeflag === 48;

    offset += 512; // skip header

    if (name && isRegularFile && !isNaN(size) && size > 0) {
      if (offset + size <= tarBuffer.length) {
        files[name] = tarBuffer.subarray(offset, offset + size);
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;
  }

  return files;
}


function loadAgentFiles(dir: string, basePath: string): Array<{type: string, content: string, target: string}> {
  let files: Array<{type: string, content: string, target: string}> = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const targetPath = path.posix.join(basePath, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(loadAgentFiles(fullPath, targetPath));
    } else {
      files.push({
        type: "inline",
        content: fs.readFileSync(fullPath, "utf-8"),
        target: targetPath
      });
    }
  }
  return files;
}

const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const ENV_ID_RE = /^(?!remote$)[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/;
const INTERACTION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/;
const GEN_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;
const MAX_TRACKED_ENTRIES = 500;

const ownedEnvironments = new Map<string, string>();
const ownedInteractions = new Map<string, string>();
const activeGenerations = new Map<string, { controller: AbortController; clientId: string }>();

function getClientId(req: express.Request): string | null {
  const raw = req.headers["x-client-id"];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return CLIENT_ID_RE.test(trimmed) ? trimmed : null;
}

function recordBoundedOwner(map: Map<string, string>, key: string, clientId: string): void {
  if (!key || key === "remote" || !clientId) return;
  if (map.has(key)) map.delete(key);
  map.set(key, clientId);
  while (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const DEFAULT_SERVER_COVER_SVG_DATA_URI =
  "data:image/svg+xml;base64," +
  Buffer.from(
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
    </svg>`,
    "utf-8",
  ).toString("base64");

// Share ids are generated server-side as `show-<16 hex>`; reject anything that could escape `shares/`.
const SHARE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SHARE_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_SHARE_COVER_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_PROXY_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_PROXY_ALLOWED_TYPES = new Set(["audio/mpeg", "audio/wav", "image/png", "image/jpeg", "application/json"]);

class PayloadTooLargeError extends Error {}

// Streams the request body into a new GCS object, aborting once maxBytes is exceeded.
// ifGenerationMatch: 0 guarantees an existing object is never overwritten.
function uploadRequestToGcs(req: express.Request, file: any, contentType: string, maxBytes: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(new PayloadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
      return;
    }
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(new PayloadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
          return;
        }
        callback(null, chunk);
      }
    });
    const writeStream = file.createWriteStream({
      contentType,
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 }
    });
    counter.on("error", (err) => {
      req.unpipe(counter);
      writeStream.destroy(err);
      finish(err);
    });
    writeStream.on("error", (err: unknown) => finish(err));
    writeStream.on("finish", () => finish());
    req.on("aborted", () => {
      const err = new Error("Client aborted upload");
      writeStream.destroy(err);
      finish(err);
    });
    req.pipe(counter).pipe(writeStream);
  });
}

function sendUploadError(req: express.Request, res: express.Response, err: any, label: string) {
  if (err instanceof PayloadTooLargeError) {
    res.setHeader("Connection", "close");
    res.status(413).json({ error: err.message });
    res.on("finish", () => req.destroy());
    return;
  }
  if (err?.code === 412) {
    res.status(409).json({ error: `Share ${label} already uploaded` });
    return;
  }
  res.status(500).json({ error: err?.message || "Upload failed" });
}

function cleanUpOldGenerations() {
  const outputDir = path.join(process.cwd(), 'output');
  if (!fs.existsSync(outputDir)) return;

  const maxAgeMs = 1 * 60 * 60 * 1000; // 1 hour threshold
  const now = Date.now();

  try {
    const items = fs.readdirSync(outputDir);
    for (const item of items) {
      if (item.startsWith('.')) continue; // ignore hidden items
      if (item === 'shares') continue; // DO NOT CLEAN UP SHARED EPISODES!
      const itemPath = path.join(outputDir, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isDirectory()) {
        const age = now - stats.mtimeMs;
        if (age > maxAgeMs) {
          console.log(`[cleanup] Directory ${item} is older than 1 hour (${Math.round(age / 1000 / 60)} mins). Deleting to prevent storage bloat.`);
          try {
            fs.rmSync(itemPath, { recursive: true, force: true });
            const zipPath = `${itemPath}.zip`;
            if (fs.existsSync(zipPath)) {
              fs.unlinkSync(zipPath);
            }
          } catch (itemErr) {
            console.error(`[cleanup] Failed to delete ${itemPath}:`, itemErr);
          }
        }
      }
    }
  } catch (err) {
    console.error("[cleanup] Error cleaning up old generations:", err);
  }
}

function getCallerKey(req: any): string {
  const raw = req?.headers?.['x-client-id'];
  const cid = Array.isArray(raw) ? raw[0] : raw;
  if (typeof cid === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(cid.trim())) {
    return `cid:${cid.trim()}`;
  }
  const xffParts = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const xff = xffParts.length >= 2 ? xffParts[xffParts.length - 2] : (xffParts[0] || '');
  return `ip:${xff || req?.ip || req?.socket?.remoteAddress || 'unknown'}`;
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 2);
  const PORT = 3000;

  // Run initial cleanup on startup
  cleanUpOldGenerations();

  app.use(express.json({ limit: '50mb' }));
  const OUTPUT_ALLOWED_EXT = new Set([".mp3", ".wav", ".png", ".jpg", ".jpeg", ".svg", ".json"]);
  app.get("/output/*", (req, res) => {
    let relPath = "";
    try {
      relPath = decodeURIComponent(req.path.slice("/output/".length));
    } catch {
      return res.status(400).end();
    }
    if (!relPath || relPath.includes("\0") || relPath.includes("\\") || relPath.includes("..")) {
      return res.status(400).end();
    }
    const segs = relPath.split("/").filter(Boolean);
    const validShape =
      (segs.length === 2 && /^[a-zA-Z0-9_-]{1,128}$/.test(segs[0]) && !segs[0].startsWith("tmp_zip_")) ||
      (segs.length === 3 && /^[a-zA-Z0-9_-]{1,128}$/.test(segs[0]) && segs[1] === "charts");
    if (!validShape) {
      return res.status(404).end();
    }
    const fileName = segs[segs.length - 1];
    const ext = path.extname(fileName).toLowerCase();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(fileName) || fileName === "quota_cache.json" || !OUTPUT_ALLOWED_EXT.has(ext)) {
      return res.status(404).end();
    }
    const outputRoot = path.resolve(process.cwd(), "output");
    const candidate = path.resolve(outputRoot, ...segs);
    if (!candidate.startsWith(outputRoot + path.sep) || !fs.existsSync(candidate)) {
      return res.status(404).end();
    }
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) {
      return res.status(404).end();
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
    );
    return res.sendFile(candidate);
  });

  // API routes FIRST
  app.post("/api/share", async (req, res) => {
    try {
      const { title, summary, transcript, prompt, duration, host, isBase64Encoded, date } = req.body;
      if (!title) {
        return res.status(400).json({ error: "Missing required metadata: title" });
      }

      const bucketName = getGcsBucketName();
      if (!bucketName) {
        console.log("[api/share] GCS_BUCKET_NAME is not configured. Sharing is disabled.");
        return res.status(400).json({ error: "Sharing is disabled because Google Cloud Storage is not configured." });
      }

      // Generate a deterministic 'shareId' based on content to check if it already exists
      const contentString = JSON.stringify({
        title,
        summary: summary || "",
        prompt: prompt || "",
        duration: duration || 0,
        host: host || "",
        transcript: transcript || []
      });
      const hash = crypto.createHash('sha256').update(contentString).digest('hex');
      const shareId = `show-${hash.substring(0, 16)}`;

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);

      // Check if json metadata, audio stream, and cover image already exist
      const file = bucket.file(`shares/${shareId}.json`);
      const audioFile = bucket.file(`shares/${shareId}.mp3`);
      const coverFile = bucket.file(`shares/${shareId}.png`);

      let jsonExists = false;
      let audioExists = false;
      let coverExists = false;
      try {
        [jsonExists] = await file.exists();
        [audioExists] = await audioFile.exists();
        [coverExists] = await coverFile.exists();
      } catch (checkErr: any) {
        console.log(`[api/share] Pre-existence check bypassed on GCS: ${checkErr.message}`);
      }

      const alreadyExists = jsonExists && audioExists && coverExists;

      if (alreadyExists) {
        console.log(`[api/share] Show ${shareId} is already fully uploaded to GCS. Reusing existing files.`);
        return res.json({
          isSharingEnabled: true,
          useGcs: true,
          shareId,
          alreadyExists: true,
          audioAlreadyUploaded: true,
          coverAlreadyUploaded: true,
          uploadUrl: `/api/shares/${shareId}/upload/audio`,
          uploadCoverUrl: `/api/shares/${shareId}/upload/cover`,
          playbackUrl: `/api/shares/${shareId}/audio`,
          coverUrl: `/api/shares/${shareId}/cover`
        });
      }

      // Save the show metadata JSON directly to GCS.
      // IMPORTANT: Do NOT write `coverImage: /api/shares/${shareId}/cover` until the `.png` object actually exists!
      const payload: Record<string, unknown> = {
        shareId,
        title,
        summary,
        transcript,
        prompt: prompt || "",
        duration: duration || 0,
        host: host || "",
        isBase64Encoded: isBase64Encoded || false,
        date: date || new Date().toLocaleDateString(),
        audioUrl: `/api/shares/${shareId}/audio`,
        ...(coverExists ? { coverImage: `/api/shares/${shareId}/cover` } : {}),
        createdAt: new Date().toISOString()
      };

      await file.save(JSON.stringify(payload, null, 2), {
        contentType: "application/json",
        resumable: false
      });

      console.log(`[api/share] Successfully created metadata on GCS for share ${shareId}`);
      res.json({
        isSharingEnabled: true,
        useGcs: true,
        shareId,
        alreadyExists: false,
        audioAlreadyUploaded: audioExists,
        coverAlreadyUploaded: coverExists,
        uploadUrl: `/api/shares/${shareId}/upload/audio`,
        uploadCoverUrl: `/api/shares/${shareId}/upload/cover`,
        playbackUrl: `/api/shares/${shareId}/audio`,
        coverUrl: `/api/shares/${shareId}/cover`
      });
    } catch (err: any) {
      console.error(`[api/share] Error initializing GCS dynamic stream or check:`, err);
      res.status(500).json({ error: `GCS publication failed: ${err.message || err}` });
    }
  });

  // Validate share ids on every /api/shares/:id* route before they reach GCS object keys.
  app.param("id", (req, res, next, id) => {
    if (typeof id !== "string" || !SHARE_ID_RE.test(id)) {
      res.status(400).json({ error: "Invalid share id" });
      return;
    }
    next();
  });

  // Proxy upload route for audio file
  app.put("/api/shares/:id/upload/audio", async (req, res) => {
    try {
      const { id } = req.params;
      const bucketName = getGcsBucketName();
      if (!bucketName) {
        return res.status(400).json({ error: "GCS bucket not configured" });
      }

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);
      const [metadataExists] = await bucket.file(`shares/${id}.json`).exists();
      if (!metadataExists) {
        return res.status(404).json({ error: "Share not found" });
      }
      const file = bucket.file(`shares/${id}.mp3`);
      const reqType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const audioContentType = reqType === "audio/wav" ? "audio/wav" : "audio/mpeg";

      console.log(`[Proxy GCS Upload] Starting direct audio stream for ${id} (${audioContentType})...`);
      await uploadRequestToGcs(req, file, audioContentType, MAX_SHARE_AUDIO_BYTES);
      console.log(`[Proxy GCS Upload] Audio save completed for share ${id}`);

      res.json({ success: true, useGcs: true });
    } catch (err: any) {
      console.error(`[Proxy GCS Upload] Handled error in audio:`, err);
      sendUploadError(req, res, err, "audio");
    }
  });

  // Proxy upload route for cover image
  app.put("/api/shares/:id/upload/cover", async (req, res) => {
    try {
      const { id } = req.params;
      const bucketName = getGcsBucketName();
      if (!bucketName) {
        return res.status(400).json({ error: "GCS bucket not configured" });
      }

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);
      const metaFile = bucket.file(`shares/${id}.json`);
      const [metadataExists] = await metaFile.exists();
      if (!metadataExists) {
        return res.status(404).json({ error: "Share not found" });
      }
      const file = bucket.file(`shares/${id}.png`);

      console.log(`[Proxy GCS Upload] Starting direct cover image stream for ${id}...`);
      try {
        await uploadRequestToGcs(req, file, "image/png", MAX_SHARE_COVER_BYTES);
      } catch (uploadErr: any) {
        if (uploadErr?.code !== 412) {
          throw uploadErr;
        }
        // Object already exists on GCS; still ensure metadata JSON records coverImage below.
        req.resume();
      }
      console.log(`[Proxy GCS Upload] Cover save completed for share ${id}`);

      // Now that shares/${id}.png is guaranteed present on GCS, record coverImage in shares/${id}.json
      try {
        const [metaBuffer] = await metaFile.download();
        const metaJson = JSON.parse(metaBuffer.toString("utf-8"));
        if (metaJson && typeof metaJson === "object" && metaJson.coverImage !== `/api/shares/${id}/cover`) {
          metaJson.coverImage = `/api/shares/${id}/cover`;
          await metaFile.save(JSON.stringify(metaJson, null, 2), {
            contentType: "application/json",
            resumable: false,
          });
        }
      } catch (metaErr: any) {
        console.warn(`[Proxy GCS Upload] Warning updating coverImage in shares/${id}.json:`, metaErr?.message || metaErr);
      }

      res.json({ success: true, useGcs: true });
    } catch (err: any) {
      console.error(`[Proxy GCS Upload] Handled error in cover:`, err);
      sendUploadError(req, res, err, "cover");
    }
  });

  // Stream proxy for playing audio
  app.get("/api/shares/:id/audio", async (req, res) => {
    try {
      const { id } = req.params;
      const bucketName = getGcsBucketName();
      if (!bucketName) {
        return res.status(400).send("GCS bucket not configured");
      }

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(`shares/${id}.mp3`);

      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).send("Audio file not found or still uploading");
      }

      let storedContentType = "audio/mpeg";
      try {
        const [metadata] = await file.getMetadata();
        if (metadata.size) {
          res.setHeader("Content-Length", metadata.size);
        }
        if (metadata.contentType === "audio/wav" || metadata.contentType === "audio/mpeg") {
          storedContentType = metadata.contentType;
        }
      } catch (e) {}

      res.setHeader("Content-Type", storedContentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache audio aggressively
      file.createReadStream().pipe(res);
    } catch (err: any) {
      console.error(`[Proxy GCS Read] Audio streaming error:`, err);
      res.status(500).send("Error reading audio file from GCS");
    }
  });

  // Stream proxy for loading cover images
  app.get("/api/shares/:id/cover", async (req, res) => {
    try {
      const { id } = req.params;
      const bucketName = getGcsBucketName();
      if (!bucketName) {
        return res.status(400).send("GCS bucket not configured");
      }

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(`shares/${id}.png`);

      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).send("Cover image not found");
      }

      try {
        const [metadata] = await file.getMetadata();
        res.setHeader("Content-Length", metadata.size);
      } catch (e) {}

      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache image aggressively
      file.createReadStream().pipe(res);
    } catch (err: any) {
      console.error(`[Proxy GCS Read] Cover image streaming error:`, err);
      res.status(500).send("Error reading cover image from GCS");
    }
  });

  app.post("/api/shares", (req, res) => {
    return res.status(403).json({ error: "Local sharing fallback has been completely disabled for security and GCS compliance." });
  });

  app.get("/api/shares/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const bucketName = getGcsBucketName();
      if (!bucketName) {
        return res.status(400).json({ error: "Sharing is disabled. No GCS bucket configured." });
      }

      const storage = new Storage();
      const bucket = storage.bucket(bucketName);
      const file = bucket.file(`shares/${id}.json`);
      const [exists] = await file.exists();
      if (exists) {
        const [buffer] = await file.download();
        const showData = JSON.parse(buffer.toString("utf-8"));
        return res.json(showData);
      }

      return res.status(404).json({ error: "Shared show not found on GCS." });
    } catch (err: any) {
      console.log(`[api/shares] Error retrieving GCS share ${req.params.id}:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const handleCancelGeneration = (req: express.Request, res: express.Response, rawGenId: unknown) => {
    const clientId = getClientId(req);
    if (!clientId) {
      return res.status(403).json({ error: "Missing or invalid x-client-id header" });
    }
    if (typeof rawGenId !== "string" || !GEN_ID_RE.test(rawGenId)) {
      return res.status(400).json({ error: "Invalid generationId" });
    }
    const entry = activeGenerations.get(rawGenId);
    if (!entry) {
      return res.status(404).json({ error: "Not found or already completed" });
    }
    if (entry.clientId !== clientId) {
      return res.status(403).json({ error: "Forbidden: generation belongs to another client session" });
    }
    console.log(`[cancel-show] Client ${clientId} requested abort for ${rawGenId}`);
    entry.controller.abort();
    activeGenerations.delete(rawGenId);
    return res.json({ success: true });
  };

  app.post("/api/cancel-show", (req, res) => {
    handleCancelGeneration(req, res, req.body?.generationId);
  });

  app.post("/api/abort/:generationId", (req, res) => {
    handleCancelGeneration(req, res, req.params.generationId);
  });

  app.get("/api/download-proxy", async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl || typeof targetUrl !== "string") {
      res.status(400).send("Missing url parameter");
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      res.status(400).send("Invalid url parameter");
      return;
    }
    const host = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname;
    const shareBucket = getGcsBucketName();
    // Only this app's own share objects and its bundled default-show assets may be proxied.
    const allowedTarget =
      !pathname.includes("..") &&
      !pathname.includes("%") &&
      ((shareBucket !== null &&
        ((host === "storage.googleapis.com" && pathname.startsWith(`/${shareBucket}/shares/`)) ||
          (host === `${shareBucket.toLowerCase()}.storage.googleapis.com` && pathname.startsWith("/shares/")))) ||
        (host === "www.gstatic.com" && pathname.startsWith("/aistudio/starter-apps/assets/ai_radio/")));
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.port !== "" ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      !allowedTarget
    ) {
      res.status(403).send("Forbidden: Domain not allowed");
      return;
    }
    try {
      const response = await fetch(parsedUrl.toString(), { redirect: "error" });
      if (!response.ok) {
        res.status(response.status).send("Failed to fetch media");
        return;
      }
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_PROXY_BYTES) {
        await response.body?.cancel();
        res.status(413).send("Media too large");
        return;
      }
      const upstreamType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      res.setHeader("Content-Type", DOWNLOAD_PROXY_ALLOWED_TYPES.has(upstreamType) ? upstreamType : "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Cache-Control", "private, no-store");

      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_PROXY_BYTES) {
          await reader.cancel();
          if (!res.headersSent) {
            res.status(413).send("Media too large");
          } else {
            res.destroy();
          }
          return;
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
          if (res.destroyed) {
            await reader.cancel();
            return;
          }
        }
      }
      res.end();
    } catch (err) {
      console.error("Download proxy failed:", err);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      } else {
        res.destroy();
      }
    }
  });

  const QUOTA_CACHE_FILE = path.join('/tmp', 'ai_radio_quota_cache.json');
  const DEFAULT_QUOTA_LIMIT = 3;

  function getQuotaLimit(): number {
    const limitStr = process.env.DAILY_QUOTA_LIMIT;
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    return DEFAULT_QUOTA_LIMIT;
  }

  function getTodayStr(): string {
    return new Date().toISOString().split('T')[0];
  }

  let isFirebaseAdminInitialized = false;

  function ensureFirebaseAdmin() {
    if (!isFirebaseAdminInitialized) {
      try {
        admin.initializeApp();
        isFirebaseAdminInitialized = true;
        console.log("Firebase Admin initialized successfully (Application Default Credentials).");
      } catch (err: any) {
        console.warn("Could not retrieve Firebase Admin environment configuration from ADC:", err.message);
        try {
          const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            admin.initializeApp({
              projectId: config.projectId
            });
            isFirebaseAdminInitialized = true;
            console.log("Initialized Firebase Admin with project ID from config layout.");
          }
        } catch (innerErr: any) {
          console.error("Failed to initialize Firebase Admin with local config fallback:", innerErr.message);
        }
      }
    }
  }

  async function getUserHash(req: express.Request): Promise<string | null> {
    const authHeader = req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        ensureFirebaseAdmin();
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        if (uid && typeof uid === 'string' && uid.trim() !== '') {
          return crypto.createHash("sha256").update(uid.trim()).digest("hex");
        }
      } catch (err: any) {
        console.error("Error verifying Firebase ID token:", err.message);
      }
    }
    return crypto.createHash("sha256").update(getCallerKey(req)).digest("hex");
  }

  function getQuotaCount(userHash: string | null): number {
    if (!userHash) return 0;
    try {
      const outputDir = path.dirname(QUOTA_CACHE_FILE);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      if (fs.existsSync(QUOTA_CACHE_FILE)) {
        const data = fs.readFileSync(QUOTA_CACHE_FILE, "utf-8");
        const cache = JSON.parse(data);
        const cacheKey = `${getTodayStr()}_${userHash}`;
        return cache[cacheKey] || 0;
      }
    } catch (err) {
      console.error("Error reading quota cache:", err);
    }
    return 0;
  }

  function incrementQuotaCount(userHash: string | null): void {
    if (!userHash) return;
    try {
      const outputDir = path.dirname(QUOTA_CACHE_FILE);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      let cache: Record<string, number> = {};
      if (fs.existsSync(QUOTA_CACHE_FILE)) {
        try {
          const data = fs.readFileSync(QUOTA_CACHE_FILE, "utf-8");
          cache = JSON.parse(data);
        } catch (e) {
          console.error("Error parsing quota file cache on increment:", e);
        }
      }
      const cacheKey = `${getTodayStr()}_${userHash}`;
      cache[cacheKey] = (cache[cacheKey] || 0) + 1;
      fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch (err) {
      console.error("Error incrementing quota cache:", err);
    }
  }

  app.get("/api/quota", async (req, res) => {
    if (process.env.NODE_ENV !== "production") {
      return res.json({ used: 0, limit: 999999 });
    }
    const userHash = await getUserHash(req);
    const limit = getQuotaLimit();
    if (!userHash) {
      return res.json({ used: 0, limit });
    }
    const count = getQuotaCount(userHash);
    return res.json({ used: count, limit });
  });

  app.post("/api/generate-show", async (req, res) => {
    if (activeGenerations.size >= 32) {
      return res.status(429).json({ error: "Too many concurrent generations. Please retry shortly." });
    }
    // Run background cleanup list whenever a new show is request to optimize disk space
    cleanUpOldGenerations();

    const {
      topic,
      duration = "15",
      mood = "Informative",
      generationId,
      environmentId: requestedEnvId,
      previousInteractionId: requestedPrevInteractionId,
    } = req.body || {};

    const clientId = getClientId(req);
    const safeGenId =
      typeof generationId === "string" && GEN_ID_RE.test(generationId) ? generationId : undefined;

    if (safeGenId) {
      const existingGen = activeGenerations.get(safeGenId);
      if (existingGen && existingGen.clientId !== (clientId || "")) {
        return res.status(409).json({ error: "Generation ID is already in use by another session." });
      }
    }

    if (requestedEnvId !== undefined && requestedEnvId !== null && requestedEnvId !== "") {
      if (
        typeof requestedEnvId !== "string" ||
        !ENV_ID_RE.test(requestedEnvId) ||
        !clientId ||
        ownedEnvironments.get(requestedEnvId) !== clientId
      ) {
        return res.status(403).json({ error: "Forbidden: environment is not owned by this client session." });
      }
    }

    if (
      requestedPrevInteractionId !== undefined &&
      requestedPrevInteractionId !== null &&
      requestedPrevInteractionId !== ""
    ) {
      if (
        typeof requestedPrevInteractionId !== "string" ||
        !INTERACTION_ID_RE.test(requestedPrevInteractionId) ||
        !clientId ||
        ownedInteractions.get(requestedPrevInteractionId) !== clientId
      ) {
        return res.status(403).json({ error: "Forbidden: previous interaction is not owned by this client session." });
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`[generate-show] Running in dev mode, skipping daily quota tracking.`);
    } else {
      const userHash = await getUserHash(req);
      if (userHash) {
        const count = getQuotaCount(userHash);
        const limit = getQuotaLimit();
        if (count >= limit) {
          return res.status(429).json({ error: `Daily limit of ${limit} shows reached. Please check back tomorrow!` });
        }
        // Deduct (increment) the quota immediately before starting the generation to prevent concurrent bypasses
        incrementQuotaCount(userHash);
      }
    }

    const prompt = `Generate a radio station about: ${topic}. Target duration: ${duration} minutes. Set the tone and style of the show to: ${mood}. Follow the workflow in AGENTS.md to research the topic thoroughly, write the multi-speaker broadcast script to radio_script.txt, and prepare the show metadata and cover plan in show_notes.json and cover_plan.json so the host studio server can synthesize the broadcast audio and cover artwork.`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Send a heartbeat every 15 seconds to keep the connection alive
    // (useful for proxies like VS Code port forwarding that drop idle connections)
    const heartbeatInterval = setInterval(() => {
      res.write(`:\n\n`); // SSE comment/ping
    }, 15000);

    let isFinished = false;
    const abortController = new AbortController();

    if (safeGenId && clientId) {
      if (activeGenerations.has(safeGenId)) activeGenerations.delete(safeGenId);
      activeGenerations.set(safeGenId, { controller: abortController, clientId });
      while (activeGenerations.size > MAX_TRACKED_ENTRIES) {
        const oldest = activeGenerations.keys().next().value;
        if (oldest === undefined) break;
        activeGenerations.delete(oldest);
      }
    }

    req.on('aborted', () => {
      if (!isFinished) {
        console.log(`[generate-show] Client aborted request. Agent will continue running in background unless explicitly cancelled.`);
      }
      clearInterval(heartbeatInterval);
    });
    req.on('close', () => {
      clearInterval(heartbeatInterval);
    });

    try {
      const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || "").trim();
      console.log(`[generate-show] Request received for topic: "${topic}", duration: "${duration}", mood: "${mood}", generationId: "${safeGenId}"`);
      console.log(`[generate-show] GEMINI_API_KEY presence verified: ${!!apiKey}`);
      if (!apiKey) {
        sendEvent({ type: "error", message: "GEMINI_API_KEY is not configured on the server." });
        res.end();
        return;
      }

      sendEvent({ type: "info", message: "Provisioning environment..." });

      console.log(`[generate-show] Loading agent files from filesystem path: ${path.join(process.cwd(), "agent")}`);
      const agentFiles = loadAgentFiles(path.join(process.cwd(), "agent"), "/.agents");
      console.log(`[generate-show] Finished loading agent files recursively. Count: ${agentFiles.length}`);

      try {
        const prefetchedFiles = await prefetchTopicAndHnArticles(String(topic || ""), abortController.signal);
        if (prefetchedFiles.length > 0) {
          agentFiles.push(...prefetchedFiles);
          console.log(`[generate-show] Added ${prefetchedFiles.length} SSRF-validated prefetched article files to workspace.`);
        }
      } catch (prefetchErr: any) {
        console.warn(`[generate-show] Optional URL prefetch skipped:`, prefetchErr?.message || prefetchErr);
      }

      console.log(`[generate-show] Calling createInteraction with prompt: "${prompt.substring(0, 100)}..."`);
      const response = await createInteraction({
        prompt,
        environmentId: typeof requestedEnvId === "string" && ENV_ID_RE.test(requestedEnvId) ? requestedEnvId : undefined,
        previousInteractionId:
          typeof requestedPrevInteractionId === "string" && INTERACTION_ID_RE.test(requestedPrevInteractionId)
            ? requestedPrevInteractionId
            : undefined,
        stream: true,
        inlineSources: agentFiles.length > 0 ? agentFiles : undefined,
        signal: abortController.signal
      });

      console.log(`[generate-show] Gemini API responded. HTTP Status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[generate-show] Gemini API Non-2xx response. Error Payload: ${errorText}`);

        let displayMessage = `Agent API error: ${response.status} - ${errorText}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed?.error?.message) {
            displayMessage = parsed.error.message;
          }
        } catch (e) {
          // ignore parsing error, stick to default
        }

        const isQuotaError = 
          response.status === 429 || 
          errorText.toLowerCase().includes("quota") || 
          errorText.toLowerCase().includes("too_many_requests") || 
          errorText.toLowerCase().includes("resource_exhausted") ||
          displayMessage.toLowerCase().includes("quota") ||
          displayMessage.toLowerCase().includes("too_many_requests");

        if (isQuotaError) {
          displayMessage = `Gemini API Quota Limit Reached: ${displayMessage}. The shared free-tier Google Gemini API Key has run out of request quota. To resolve this, go to Settings > Secrets inside AI Studio to verify your personal Gemini API key or set up billing.`;
        }

        sendEvent({ type: "error", message: displayMessage });
        res.end();
        return;
      }

      console.log(`[generate-show] Response remains ok. Constructing SSE stream reader...`);
      let accumulatedText = "";
      let envId: string | undefined;
      let interactionId: string | undefined;

      const captureSessionIds = (interactionObj: Record<string, unknown> | undefined) => {
        if (!interactionObj || typeof interactionObj !== "object") return;
        const candidateInteractionId =
          (typeof interactionObj.id === "string" ? interactionObj.id : undefined) ||
          (typeof interactionObj.interaction_id === "string" ? interactionObj.interaction_id : undefined);
        if (candidateInteractionId && INTERACTION_ID_RE.test(candidateInteractionId)) {
          interactionId = candidateInteractionId;
          if (clientId) {
            recordBoundedOwner(ownedInteractions, candidateInteractionId, clientId);
          }
        }
        const envObj = interactionObj.environment as Record<string, unknown> | undefined;
        const candidateEnvId =
          (typeof envObj?.env_id === "string" ? envObj.env_id : undefined) ||
          (typeof envObj?.environment_id === "string" ? envObj.environment_id : undefined) ||
          (typeof interactionObj.environment_id === "string" ? interactionObj.environment_id : undefined);
        if (candidateEnvId && ENV_ID_RE.test(candidateEnvId)) {
          envId = candidateEnvId;
          if (clientId) {
            recordBoundedOwner(ownedEnvironments, candidateEnvId, clientId);
          }
        }
      };

      let eventCount = 0;
      for await (const event of streamInteraction(response)) {
        eventCount++;
        console.log(`[generate-show] SSE yields streaming event #${eventCount}: type="${event.type}"`);
        if (event.type === "done") {
          console.log(`[generate-show] Received explicit "done" marker from interaction stream.`);
          break;
        }
        if (event.type === "interaction") {
          captureSessionIds(event.interaction);
          continue;
        }
        if (event.type === "complete") {
          captureSessionIds(event.interaction);
          console.log(`[generate-show] Interaction completed. Extracted environment ID: "${envId}", interaction ID: "${interactionId}"`);
          const usage = event.interaction?.usage as any;
          if (usage) {
            console.log(`[agent] Token usage: ${usage.total_tokens} total tokens (${usage.total_input_tokens} input, ${usage.total_output_tokens} output, ${usage.total_thought_tokens || 0} thought, ${usage.total_cached_tokens || 0} cached)`);
          }

          // Fallback extraction: iterate and combine text from all elements of the steps array 
          const stepsObj = event.interaction?.steps as any[];
          if (Array.isArray(stepsObj)) {
            let combinedStepsText = "";
            for (const step of stepsObj) {
              const isReasoningStep = step.type === 'thinking' || step.type === 'thought' || step.type === 'reasoning';
              if (!isReasoningStep && Array.isArray(step.content)) {
                for (const part of step.content) {
                  if (part && typeof part === 'object') {
                    if (part.type === 'text' && part.text) {
                      combinedStepsText += part.text;
                    } else if (part.text && part.type !== 'thought') {
                      combinedStepsText += part.text;
                    }
                  } else if (typeof part === 'string') {
                    combinedStepsText += part;
                  }
                }
              }
            }
            if (combinedStepsText && combinedStepsText.length > accumulatedText.length) {
              console.log(`[generate-show] Dynamic steps recovery: Reconstructed text of length ${combinedStepsText.length} exceeds accumulated text of length ${accumulatedText.length}. Restoring fallback text.`);
              accumulatedText = combinedStepsText;
            }
          }
        }

        // Log events to the terminal as well
        if (event.type === "thinking") console.log(`[agent] thinking delta: ${event.text?.substring(0, 30)}...`);
        else if (event.type === "tool_call") {
          console.log(`[agent] tool_call: ${event.name}`);
          console.log(`[agent] args:`, JSON.stringify(event.arguments, null, 2));
        }
        else if (event.type === "tool_result") {
          console.log(`[agent] tool_result for tool: ${event.name}`);
        }
        else if (event.type === "text") {
          console.log(`[agent] text output segment: ${event.text?.substring(0, 30)}...`);
        }

        sendEvent(event);

        if (event.type === "text" && event.text) {
          accumulatedText += event.text;
        }
      }

      // Recover envId from GET /interactions/:id if the SSE stream closed before emitting env_id
      if (!envId && interactionId && INTERACTION_ID_RE.test(interactionId)) {
        try {
          const pollRes = await fetch(`${API_BASE_URL}/interactions/${encodeURIComponent(interactionId)}`, {
            headers: { "x-goog-api-key": apiKey, "Api-Revision": "2026-05-20" },
            signal: abortController.signal,
          });
          if (pollRes.ok) {
            const pollData = (await pollRes.json()) as Record<string, unknown>;
            captureSessionIds(pollData);
          }
        } catch (pollErr: any) {
          console.warn("[generate-show] Optional interaction env_id recovery failed:", pollErr?.message || pollErr);
        }
      }

      let showDataEmitted = false;

      if (envId && ENV_ID_RE.test(envId)) {
        sendEvent({ type: "info", message: "Downloading script and research snapshot from sandbox..." });
        try {
          const downloadUrl = `${API_BASE_URL}/files/environment-${encodeURIComponent(envId)}:download?alt=media`;
          let snapRes: Response | null = null;
          for (let attempt = 0; attempt < 4; attempt++) {
            snapRes = await fetch(downloadUrl, {
              headers: { "x-goog-api-key": apiKey },
              signal: abortController.signal,
            });
            if (snapRes.ok) break;
            if (![404, 409, 425, 503].includes(snapRes.status) || attempt === 3) break;
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }

          if (snapRes && snapRes.ok) {
            const arrayBuffer = await snapRes.arrayBuffer();
            const tarBuffer = Buffer.from(arrayBuffer);
            const extractedFiles = extractTarInMemory(tarBuffer);

            const showNotes = await synthesizeRadioShowFromSandbox({
              extractedFiles,
              topic: String(topic || ""),
              duration,
              mood,
              apiKey,
              onProgress: (msg) => sendEvent({ type: "info", message: msg }),
              signal: abortController.signal,
            });

            sendEvent({ type: "show_data", data: showNotes });
            showDataEmitted = true;
          } else {
            const errBody = snapRes ? await snapRes.text() : "No response";
            console.error("Failed to download snapshot:", errBody);
            sendEvent({ type: "error", message: `Failed to retrieve files from simulation: ${errBody}` });
          }
        } catch (err: any) {
          if (err?.name === "AbortError") throw err;
          console.error("Error synthesizing show from sandbox snapshot:", err);
          sendEvent({ type: "error", message: `Error synthesizing show files: ${err.message}` });
        }
      } else if (accumulatedText) {
        // Fallback synthesis directly from accumulated agent text if sandbox environment snapshot was unavailable
        try {
          const syntheticFiles: Record<string, Buffer> = {
            "research.md": Buffer.from(accumulatedText, "utf-8"),
          };
          const showNotes = await synthesizeRadioShowFromSandbox({
            extractedFiles: syntheticFiles,
            topic: String(topic || ""),
            duration,
            mood,
            apiKey,
            onProgress: (msg) => sendEvent({ type: "info", message: msg }),
            signal: abortController.signal,
          });
          sendEvent({ type: "show_data", data: showNotes });
          showDataEmitted = true;
        } catch (fallbackErr: any) {
          if (fallbackErr?.name === "AbortError") throw fallbackErr;
          console.error("Fallback synthesis from accumulated text failed:", fallbackErr);
        }
      }

      if (!showDataEmitted && accumulatedText) {
        try {
          const blocks = extractJsonBlocks(accumulatedText);
          const validBlock = [...blocks]
            .reverse()
            .find((b: any) => b && typeof b === "object" && Array.isArray(b.timecoded_transcript));
          if (validBlock) {
            sendEvent({ type: "show_data", data: validBlock });
          }
        } catch (e) {
          console.error("Failed to parse JSON blocks fallback from accumulated text:", e);
        }
      }

      isFinished = true;
      sendEvent({ type: "status", status: "completed" });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[generate-show] Agent interaction aborted successfully.`);
      } else {
        console.error(`[generate-show] Error:`, err);
        sendEvent({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
      }
    } finally {
      isFinished = true;
      clearInterval(heartbeatInterval);
      if (safeGenId) {
        activeGenerations.delete(safeGenId);
      }
      res.end();
    }
  });

  app.get("/api/download-zip", async (req, res) => {
    const { notesUrl, audioUrl, coverUrl } = req.query;

    if (!audioUrl || typeof audioUrl !== 'string') {
      return res.status(400).send("Missing audioUrl");
    }

    const outputRoot = path.resolve(process.cwd(), 'output');
    const showsRoot = path.resolve(process.cwd(), 'public', 'shows');
    const getFilePath = (url: string) => {
      if (!url || typeof url !== 'string' || !url.startsWith('/') || url.includes('\0')) return null;
      let decodedUrl: string;
      try {
        decodedUrl = decodeURIComponent(url);
      } catch {
        return null;
      }
      if (decodedUrl.includes('\0') || decodedUrl.includes('\\')) return null;
      let resolved: string | null = null;
      if (decodedUrl.startsWith('/output/')) {
        resolved = path.resolve(outputRoot, '.' + decodedUrl.slice('/output'.length));
        if (!resolved.startsWith(outputRoot + path.sep)) return null;
      } else if (decodedUrl.startsWith('/shows/')) {
        resolved = path.resolve(showsRoot, '.' + decodedUrl.slice('/shows'.length));
        if (!resolved.startsWith(showsRoot + path.sep)) return null;
      } else {
        return null;
      }
      if (!fs.existsSync(resolved)) return null;
      const st = fs.lstatSync(resolved);
      if (st.isSymbolicLink() || !st.isFile()) return null;
      return resolved;
    };

    const audioPath = getFilePath(audioUrl as string);
    if (!audioPath) {
      return res.status(400).send("Invalid audioUrl");
    }
    const notesPath = notesUrl ? getFilePath(notesUrl as string) : null;
    const coverPath = coverUrl ? getFilePath(coverUrl as string) : null;

    const tmpDir = path.join('/tmp', `ai_radio_tmp_zip_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      let hasFiles = false;
      if (notesPath && fs.existsSync(notesPath)) {
        fs.copyFileSync(notesPath, path.join(tmpDir, 'show_notes.json'));
        hasFiles = true;
      }
      if (audioPath && fs.existsSync(audioPath)) {
        fs.copyFileSync(audioPath, path.join(tmpDir, 'ai_radio.mp3'));
        hasFiles = true;
      }
      if (coverPath && fs.existsSync(coverPath)) {
        fs.copyFileSync(coverPath, path.join(tmpDir, 'cover.png'));
        hasFiles = true;
      }

      if (!hasFiles) {
        return res.status(404).send("No files found to zip");
      }

      const zipPath = `${tmpDir}.zip`;
      await execAsync(`zip -j "${zipPath}" "${tmpDir}"/*`);

      res.download(zipPath, 'radio-show.zip', (err) => {
        // Cleanup
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        } catch (e) {
          console.error("Cleanup error:", e);
        }
      });
    } catch (err) {
      console.error("Zip error:", err);
      res.status(500).send("Error creating zip");
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  app.get("/api/shows", (req, res) => {
    // Run cleanup on library list check
    cleanUpOldGenerations();

    const showsDir = path.join(process.cwd(), 'public', 'shows');
    const shows: any[] = [];

    if (fs.existsSync(showsDir)) {
      const entries = fs.readdirSync(showsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const showPath = path.join(showsDir, entry.name);
          const showNotesPath = path.join(showPath, 'show_notes.json');

          if (fs.existsSync(showNotesPath)) {
            try {
              const showNotes = JSON.parse(fs.readFileSync(showNotesPath, 'utf-8'));
              const folderFiles = fs.readdirSync(showPath);
              const mp3File = folderFiles.find(f => f.endsWith('.mp3'));
              const coverFile = folderFiles.find(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'));

              showNotes.audioUrl = `/shows/${entry.name}/${mp3File || 'ai_radio.mp3'}`;
              showNotes.coverImage = coverFile ? `/shows/${entry.name}/${coverFile}` : '/shows/lesson-placeholder.svg';
              showNotes.notesUrl = `/shows/${entry.name}/show_notes.json`;
              shows.push(showNotes);
            } catch (err) {
              console.error(`Error reading show notes for ${entry.name}:`, err);
            }
          }
        }
      }
    }
    res.json(shows);
  });

  app.get("/api/share/config", (req, res) => {
    res.json({
      isSharingEnabled: !!process.env.GCS_BUCKET_NAME
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development (with a robust fallback to dev middleware if dist/index.html is missing)
  const distPath = path.join(process.cwd(), 'dist');
  const indexHtmlExists = fs.existsSync(path.join(distPath, 'index.html'));

  if (process.env.NODE_ENV !== "production" || !indexHtmlExists) {
    if (process.env.NODE_ENV === "production") {
      console.warn("Production mode enabled, but dist/index.html not found. Falling back to Vite dev server middleware to ensure app stays operational.");
    }
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(["/server.cjs", "/server.cjs.map"], (_req: any, res: any) => res.status(404).end());
    app.use(express.static(distPath));
    // Express 5 format for catch-all (if using express 5) or Express 4. Let's use *all for v5 or * for v4.
    // We can use default express 4 catch-all
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const startListening = (port: number) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${port}`);
    }).on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is in use, trying ${port + 1}...`);
        startListening(port + 1);
      } else {
        console.error(err);
      }
    });

    // Disable timeouts for long-running agent interactions
    server.setTimeout(0);
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
  };

  startListening(PORT);
}

startServer();
