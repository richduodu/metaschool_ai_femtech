import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ARTICLE_CHARS = 7500;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "broadcasthost",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc >>> 0;
}

function inCidr4(ipInt: number, base: string, prefixLen: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

export function isSafePublicIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const version = net.isIP(clean);
  if (version === 4) {
    const ipInt = ipv4ToInt(clean);
    if (ipInt === null) return false;
    const blockedRanges: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
      ["255.255.255.255", 32],
    ];
    for (const [base, prefix] of blockedRanges) {
      if (inCidr4(ipInt, base, prefix)) return false;
    }
    return true;
  }

  if (version === 6) {
    const lower = clean.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (net.isIP(mapped) === 4) {
        return isSafePublicIp(mapped);
      }
      // Hex form ::ffff:7f00:1
      const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
      if (hexMatch) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isSafePublicIp(v4);
      }
      return false;
    }
    // Block unique local (fc00::/7 -> fc.. or fd..), link-local (fe80::/10 -> fe8..feb),
    // multicast (ff00::/8), documentation (2001:db8::/32), 6to4/Teredo/loopback embeddings
    if (
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff") ||
      lower.startsWith("2001:db8:") ||
      lower.startsWith("2001:0db8:") ||
      lower.startsWith("64:ff9b:")
    ) {
      return false;
    }
    return true;
  }

  return false;
}

async function resolveSafePublicHost(urlStr: string): Promise<{
  parsed: URL;
  address: string;
  family: 4 | 6;
}> {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials in URL are not allowed");
  }
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new Error(`Non-standard port blocked: ${parsed.port}`);
  }

  const hostLower = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostLower ||
    BLOCKED_HOSTNAMES.has(hostLower) ||
    hostLower.endsWith(".localhost") ||
    hostLower.endsWith(".local") ||
    hostLower.endsWith(".internal") ||
    hostLower.endsWith(".home.arpa")
  ) {
    throw new Error(`Blocked hostname: ${hostLower}`);
  }

  const literalFamily = net.isIP(hostLower);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isSafePublicIp(hostLower)) {
      throw new Error(`Blocked non-public IP literal: ${hostLower}`);
    }
    return { parsed, address: hostLower, family: literalFamily };
  }

  const records = await dns.promises.lookup(hostLower, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error(`DNS resolution returned no records for ${hostLower}`);
  }
  for (const rec of records) {
    if (!isSafePublicIp(rec.address)) {
      throw new Error(`Blocked private/reserved DNS resolution for ${hostLower}`);
    }
  }
  const chosen = records.find((r) => r.family === 4) || records[0];
  return {
    parsed,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

export async function safeFetchPublicText(
  initialUrl: string,
  signal?: AbortSignal,
): Promise<{ finalUrl: string; contentType: string; body: string }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    const { parsed, address, family } = await resolveSafePublicHost(currentUrl);
    const mod = parsed.protocol === "https:" ? https : http;

    const result = await new Promise<{
      statusCode: number;
      location?: string;
      contentType: string;
      body: string;
    }>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: "GET",
          servername: parsed.hostname,
          headers: {
            "User-Agent": "AI-Radio/1.0 (Public Article Reader)",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
            "Accept-Encoding": "identity",
            Connection: "close",
          },
          lookup: (_host, _opts, cb) => {
            cb(null, address, family);
          },
          timeout: FETCH_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const loc = Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location;
          const ct = String(res.headers["content-type"] || "").toLowerCase();

          if (status >= 300 && status < 400 && loc) {
            res.resume();
            resolve({ statusCode: status, location: loc, contentType: ct, body: "" });
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }

          if (
            ct &&
            !ct.includes("text/") &&
            !ct.includes("json") &&
            !ct.includes("xml") &&
            !ct.includes("xhtml")
          ) {
            res.destroy();
            reject(new Error(`Unsupported content-type: ${ct}`));
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            const remaining = MAX_RESPONSE_BYTES - total;
            if (remaining <= 0) {
              res.destroy();
              return;
            }
            const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            chunks.push(slice);
            total += slice.length;
            if (total >= MAX_RESPONSE_BYTES) {
              res.destroy();
            }
          });
          const done = () => {
            resolve({
              statusCode: status,
              contentType: ct,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          };
          res.on("end", done);
          res.on("close", done);
          res.on("error", (err) => {
            if (chunks.length > 0) done();
            else reject(err);
          });
        },
      );

      const onAbort = () => {
        req.destroy(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.on("timeout", () => req.destroy(new Error("Timeout fetching URL")));
      req.on("error", reject);
      req.end();
    });

    if (result.location) {
      currentUrl = new URL(result.location, parsed).toString();
      continue;
    }

    return {
      finalUrl: currentUrl,
      contentType: result.contentType,
      body: result.body,
    };
  }

  throw new Error("Too many redirects");
}

function htmlToReadableMarkdown(html: string): {
  title: string;
  description: string;
  text: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";

  const descMatch =
    /<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i.exec(html) ||
    /<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i.exec(html);
  const rawDesc = descMatch ? descMatch[1].trim() : "";

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<(br|p|div|article|section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const entities: Array<[RegExp, string]> = [
    [/&amp;/g, "&"],
    [/&lt;/g, "<"],
    [/&gt;/g, ">"],
    [/&quot;/g, '"'],
    [/&#39;|&#x27;/g, "'"],
    [/&nbsp;/g, " "],
    [/&mdash;/g, "—"],
    [/&ndash;/g, "–"],
  ];
  for (const [re, val] of entities) {
    text = text.replace(re, val);
  }

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > MAX_ARTICLE_CHARS) {
    text = `${text.slice(0, MAX_ARTICLE_CHARS)}\n\n*(article text truncated at ${MAX_ARTICLE_CHARS} chars)*`;
  }

  return {
    title: rawTitle.replace(/\s+/g, " ").slice(0, 240),
    description: rawDesc.replace(/\s+/g, " ").slice(0, 400),
    text,
  };
}

export interface PrefetchedArticle {
  url: string;
  finalUrl: string;
  hnStoryId?: number;
  title: string;
  description: string;
  markdown: string;
  targetFile: string;
}

const OFF_LIMITS_RE =
  /\b(trump|biden|election|senate|congress|parliament|war|gaza|ukraine|israel|russia|sanctions|immigration|abortion|religion|church|mosque)\b/i;

export async function prefetchTopicAndHnArticles(
  topic: string,
  signal?: AbortSignal,
): Promise<Array<{ type: "inline"; content: string; target: string }>> {
  const inlineFiles: Array<{ type: "inline"; content: string; target: string }> = [];
  if (!topic || typeof topic !== "string") return inlineFiles;

  const urlMatches = topic.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  const candidateUrls: Array<{ url: string; hnStoryId?: number }> = [];
  const seenUrls = new Set<string>();

  for (const raw of urlMatches.slice(0, 4)) {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (seenUrls.has(cleaned)) continue;
    seenUrls.add(cleaned);

    // Check if it's a Hacker News item link
    const hnItemMatch = /news\.ycombinator\.com\/item\?id=(\d+)/i.exec(cleaned);
    if (hnItemMatch) {
      const storyId = Number(hnItemMatch[1]);
      try {
        const itemRes = await safeFetchPublicText(
          `https://hacker-news.firebaseio.com/v0/item/${storyId}.json`,
          signal,
        );
        const story = JSON.parse(itemRes.body);
        if (story?.url && typeof story.url === "string" && !seenUrls.has(story.url)) {
          seenUrls.add(story.url);
          candidateUrls.push({ url: story.url, hnStoryId: storyId });
        }
      } catch {
        // ignore HN item lookup error
      }
      continue;
    }

    // GitHub repo roots are already handled natively in the sandbox via api.github.com
    if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/?$/i.test(cleaned)) {
      continue;
    }

    candidateUrls.push({ url: cleaned });
  }

  // If prompt mentions Hacker News / HN, prefetch linked external articles for top safe tech stories
  if (/\b(hacker\s*news|hn|ycombinator)\b/i.test(topic)) {
    try {
      const topRes = await safeFetchPublicText(
        "https://hacker-news.firebaseio.com/v0/topstories.json",
        signal,
      );
      const topIds: number[] = JSON.parse(topRes.body);
      if (Array.isArray(topIds)) {
        const checkIds = topIds.slice(0, 10);
        const stories = await Promise.all(
          checkIds.map(async (sid) => {
            try {
              const sRes = await safeFetchPublicText(
                `https://hacker-news.firebaseio.com/v0/item/${sid}.json`,
                signal,
              );
              return JSON.parse(sRes.body);
            } catch {
              return null;
            }
          }),
        );
        let addedHn = 0;
        for (const s of stories) {
          if (addedHn >= 5) break;
          if (!s || typeof s.url !== "string" || !s.title) continue;
          if (OFF_LIMITS_RE.test(String(s.title))) continue;
          if (seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);
          candidateUrls.push({ url: s.url, hnStoryId: Number(s.id) });
          addedHn++;
        }
      }
    } catch (err) {
      console.warn("[urlPrefetch] HN topstories article prefetch skipped:", err);
    }
  }

  if (candidateUrls.length === 0) return inlineFiles;

  const prefetched: PrefetchedArticle[] = [];
  await Promise.all(
    candidateUrls.slice(0, 6).map(async (entry, idx) => {
      try {
        const fetched = await safeFetchPublicText(entry.url, signal);
        const parsed = fetched.contentType.includes("json")
          ? {
              title: entry.url,
              description: "JSON payload",
              text: fetched.body.slice(0, MAX_ARTICLE_CHARS),
            }
          : htmlToReadableMarkdown(fetched.body);
        if (!parsed.text || parsed.text.length < 40) return;

        const safeSlug = entry.url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
        const fileName = `article_${idx + 1}_${safeSlug}.md`;
        const mdLines = [
          `# Linked Article Content: ${parsed.title || entry.url}`,
          `- **Source URL**: ${entry.url}`,
          ...(fetched.finalUrl !== entry.url ? [`- **Resolved URL**: ${fetched.finalUrl}`] : []),
          ...(entry.hnStoryId ? [`- **HN Story ID**: ${entry.hnStoryId}`] : []),
          ...(parsed.description ? [`- **Description**: ${parsed.description}`] : []),
          "",
          "## Extracted Article Body",
          "",
          parsed.text,
          "",
          "---",
        ].join("\n");

        prefetched.push({
          url: entry.url,
          finalUrl: fetched.finalUrl,
          hnStoryId: entry.hnStoryId,
          title: parsed.title || entry.url,
          description: parsed.description,
          markdown: mdLines,
          targetFile: `/.agents/prefetched_research/${fileName}`,
        });
      } catch (err: any) {
        console.warn(`[urlPrefetch] Skipped ${entry.url}: ${err?.message || err}`);
      }
    }),
  );

  if (prefetched.length === 0) return inlineFiles;

  const manifest: Record<
    string,
    { file: string; title: string; finalUrl: string; hnStoryId?: number }
  > = {};
  for (const item of prefetched) {
    inlineFiles.push({
      type: "inline",
      content: item.markdown,
      target: item.targetFile,
    });
    manifest[item.url] = {
      file: item.targetFile,
      title: item.title,
      finalUrl: item.finalUrl,
      hnStoryId: item.hnStoryId,
    };
    if (item.finalUrl !== item.url) {
      manifest[item.finalUrl] = manifest[item.url];
    }
    if (item.hnStoryId) {
      manifest[`hn:${item.hnStoryId}`] = manifest[item.url];
    }
  }

  inlineFiles.push({
    type: "inline",
    content: JSON.stringify(manifest, null, 2),
    target: "/.agents/prefetched_research/manifest.json",
  });

  return inlineFiles;
}
