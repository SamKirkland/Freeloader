#!/usr/bin/env node
/**
 * Static dev server for the demo site.
 *
 * By default it does nothing but hand out files, exactly as GitHub Pages does —
 * the deployed site needs no server at all, and this one should not pretend
 * otherwise. Two optional extras exist for development:
 *
 *   --base <path>   serve under a subdirectory, the way a project site is
 *                   served from /<repo>/, so that case can be checked locally
 *   --mbps N        push every response through one shared token bucket, so the
 *                   whole browser really is limited to that rate and the
 *                   library's estimate can be compared against a known number
 *
 *   node tools/dev-server.mjs --port 8080
 *   node tools/dev-server.mjs --base SpeedTest
 *   node tools/dev-server.mjs --mbps 25 --latency 40 --jitter 8
 *
 * It serves no routes at all. The demo needs none: even measuring an upload only
 * needs somewhere to send a body, not something to accept it.
 *
 * Nothing here is part of the library, which is frontend-only.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "site");

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 8080);
// GitHub Pages serves a project site from /<repo>/, so the demo has to work
// from a subdirectory as well as from the root. Passing --base reproduces that
// locally, which is the only honest way to check it before deploying.
const BASE = normalizeBase(args.base);
const MBPS = args.mbps === undefined ? null : Number(args.mbps);
// Hold each response for as long as it would have taken to arrive, then send it
// in one go. That is what DevTools network throttling does to Resource Timing:
// the transfer time lands in the wait instead of in the body window. Used to
// check that the library is not fooled by it.
const BUFFER = args.buffer !== undefined;
const LATENCY_MS = Number(args.latency ?? 0);
const JITTER_MS = Number(args.jitter ?? 0);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * One bucket for the whole server, so six parallel downloads share the link
 * exactly as they would on a real connection.
 */
class TokenBucket {
  constructor(bytesPerSecond) {
    this.rate = bytesPerSecond;
    // Two competing pressures. Too generous and a single image slips through
    // faster than the configured rate, making the comparison lie; too small and
    // the server sleeps constantly, and on Windows a sleep rounds up to ~15 ms,
    // which caps the whole server at a few tens of Mbps.
    this.capacity = Math.max(262_144, bytesPerSecond * 0.02);
    this.tokens = this.capacity;
    this.last = performance.now();
  }

  #refill() {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  async take(bytes) {
    let remaining = bytes;
    while (remaining > 0) {
      this.#refill();
      if (this.tokens >= 1) {
        const spend = Math.min(this.tokens, remaining);
        this.tokens -= spend;
        remaining -= spend;
      }
      if (remaining > 0) {
        const waitMs = Math.max(2, ((Math.min(remaining, this.capacity) + 1) / this.rate) * 1000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
}

const bucket = MBPS ? new TokenBucket((MBPS * 1e6) / 8) : null;

/** "/SpeedTest", "SpeedTest/" and "/SpeedTest/" all mean the same thing. */
function normalizeBase(value) {
  if (!value || value === true) return "";
  const trimmed = String(value).replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Round trip and its variation, applied before the first byte goes out. */
async function applyLatency() {
  const jitter = JITTER_MS > 0 ? (Math.random() * 2 - 1) * JITTER_MS : 0;
  const total = LATENCY_MS + jitter;
  if (total > 0) await delay(total);
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, relative);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

async function resolveFile(pathname) {
  let target = safePath(pathname);
  if (!target) return null;
  try {
    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target);
    }
    return { path: target, size: info.size, modified: info.mtime };
  } catch {
    // Allow extension-less URLs like /gallery.
    if (!extname(pathname)) {
      const withHtml = safePath(`${pathname}.html`);
      try {
        const info = await stat(withHtml);
        return { path: withHtml, size: info.size, modified: info.mtime };
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Stream a file out through the shared bucket, honouring Range requests. */
async function sendFile(req, res, file, headers) {
  // Revalidated caching: the browser keeps its copy but asks each time, so an
  // edit shows up on the next load and an unchanged file comes back as a 304.
  if (headers["Cache-Control"] === "no-cache") {
    headers["Last-Modified"] = file.modified.toUTCString();
    const since = Date.parse(req.headers["if-modified-since"] ?? "");
    // HTTP dates have whole seconds; compare at that precision.
    if (since >= Math.floor(file.modified.getTime() / 1000) * 1000) {
      await applyLatency();
      res.writeHead(304, { "Cache-Control": "no-cache", "Last-Modified": headers["Last-Modified"], "Timing-Allow-Origin": "*" });
      res.end();
      return;
    }
  }
  const range = req.headers.range;
  let start = 0;
  let end = file.size - 1;
  let status = 200;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : file.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= file.size) {
        res.writeHead(416, { "Content-Range": `bytes */${file.size}` });
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    }
  }

  headers["Content-Length"] = String(end - start + 1);
  headers["Accept-Ranges"] = "bytes";
  await applyLatency();
  if (BUFFER && bucket) {
    // Pay the whole transfer up front, before a single byte is sent.
    await bucket.take(end - start + 1);
  }
  res.writeHead(status, headers);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  // Large chunks keep the number of throttle sleeps down; see TokenBucket.
  const stream = createReadStream(file.path, { start, end, highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    if (bucket && !BUFFER) await bucket.take(chunk.length);
    if (!res.write(chunk)) {
      await new Promise((r) => res.once("drain", r));
    }
  }
  res.end();
}


const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Everything below this line sees root-relative paths, exactly as it would
  // without a base.
  let pathname = url.pathname;
  if (BASE) {
    if (pathname === BASE) {
      res.writeHead(302, { Location: `${BASE}/` });
      res.end();
      return;
    }
    if (!pathname.startsWith(`${BASE}/`)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found — the site is served from ${BASE}/`);
      return;
    }
    pathname = pathname.slice(BASE.length);
  }

  try {
    // Refused exactly as a static host refuses it, after draining the body so
    // that an upload being measured still crosses the network.
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const chunk of req) {
        if (bucket) await bucket.take(chunk.length); // Uploads share the link too.
      }
      await applyLatency();
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("405 Method Not Allowed");
      return;
    }

    const file = await resolveFile(pathname === "/" ? "/index.html" : pathname);
    if (!file) {
      await applyLatency();
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("404 Not Found");
      return;
    }

    const ext = extname(file.path).toLowerCase();
    const isGenerated = file.path.includes(`${sep}generated${sep}`);
    // The library itself is rebuilt constantly during development; caching it
    // would serve stale code straight after a build.
    const isLibrary = file.path.endsWith(`${sep}freeloader.js`);
    // Pages change constantly during development too.
    const isPage = ext === ".html";
    await sendFile(req, res, file, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // Heavy assets stay uncached so the demo keeps seeing real network bytes.
      // The site's own small files are cached but revalidated on every load,
      // so edits show up at once and unchanged files exercise Freeloader's
      // handling of 304s.
      "Cache-Control": isGenerated || isLibrary || isPage ? "no-store" : "no-cache",
      "Timing-Allow-Origin": "*",
    });
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("500 Internal Server Error");
    } else {
      res.end();
    }
    console.error(`  ! ${req.method} ${req.url}: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Freeloader demo -> http://localhost:${PORT}${BASE}/`);
  console.log(
    MBPS
      ? `  throttled to ${MBPS} Mbps (shared), latency ${LATENCY_MS} ms +/- ${JITTER_MS} ms${
          BUFFER ? ", buffered (transfer time lands in the wait)" : ""
        }`
      : "  unthrottled (pass --mbps 25 to simulate a known link)",
  );
});
