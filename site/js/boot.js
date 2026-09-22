/**
 * Starts Freeloader on every page of the demo and fills in the metrics bar.
 *
 * The integration is the first three lines: import, start, subscribe. The rest
 * fills the bar that sits under the header of every page. Its markup is in the
 * HTML rather than created here, so the page does not shift when the numbers
 * arrive; this only writes values into the slots it finds.
 *
 * The estimate is restored from localStorage before anything has loaded, so the
 * bar is populated on the first frame of a repeat visit and sharpens as the
 * page's own traffic is observed.
 */
import { Freeloader, formatBitsPerSecond, formatMilliseconds } from "../freeloader.js";

const freeloader = Freeloader.start({ storageKey: "freeloader:demo" });

// Exposed so the other demo pages (and the browser console) can read it.
window.freeloader = freeloader;

const slot = (key) => document.querySelector(`[data-metric="${key}"]`);

function set(key, value) {
  const node = slot(key);
  if (node) node.textContent = value;
}

/**
 * `average` is the mean of what was actually observed and `peak` the best
 * single burst. Neither is the library's estimate, which sits above the average
 * on purpose: a passive sample can only ever understate a link.
 */
function render(estimate) {
  const { download, upload, latency } = estimate;

  set("download-average", formatBitsPerSecond(download.averageBitsPerSecond));
  set(
    "download-average-detail",
    download.averageBitsPerSecond
      ? `${download.resources} resources · ${(download.confidence.score * 100).toFixed(0)}% confidence`
      : "waiting for traffic",
  );
  set("download-peak", formatBitsPerSecond(download.peakBitsPerSecond));

  set("upload-average", formatBitsPerSecond(upload.averageBitsPerSecond));
  set("upload-average-detail", upload.averageBitsPerSecond ? `${upload.resources} uploads` : "nothing sent");
  set("upload-peak", formatBitsPerSecond(upload.peakBitsPerSecond));

  set("round-trip", formatMilliseconds(latency.roundTripMilliseconds));
  set("round-trip-detail", latency.jitterMilliseconds === null ? " " : `jitter ${formatMilliseconds(latency.jitterMilliseconds)}`);
}

/**
 * Kept across page loads for the debug page: every change to the estimate, the
 * browser's own timing for every file it downloaded, and Freeloader's timing
 * for every upload.
 */
const HISTORY_KEY = "freeloader:demo:history";
const FILES_KEY = "freeloader:demo:files";
const UPLOADS_KEY = "freeloader:demo:uploads";

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

function write(key, list, limit) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(-limit)));
  } catch {}
}

export const readHistory = () => read(HISTORY_KEY);
export const readFiles = () => read(FILES_KEY);
export const readUploads = () => read(UPLOADS_KEY);

/**
 * Freeloader keeps its own upload samples and hands them back on every page,
 * so clearing remembers when it happened and older uploads stay out.
 */
const CLEARED_KEY = "freeloader:demo:cleared";

export function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(FILES_KEY);
    localStorage.removeItem(UPLOADS_KEY);
    localStorage.setItem(CLEARED_KEY, String(Date.now()));
  } catch {}
}

function remember(estimate) {
  const point = { at: Date.now(), download: estimate.download.bitsPerSecond, upload: estimate.upload.bitsPerSecond };
  const history = readHistory();
  const last = history[history.length - 1];
  if (last && last.download === point.download && last.upload === point.upload) return;
  history.push(point);
  write(HISTORY_KEY, history, 500);
}

remember(freeloader.getEstimate());
freeloader.subscribe(remember);

/**
 * Browsers don't time uploads, but Freeloader does, so each of its upload
 * samples is saved in the same shape as a downloaded file. A sample is stamped
 * when the body finished going out; its start is that less its duration. Its
 * samples also come back from storage on every page, hence the check for ones
 * already saved.
 */
function rememberUploads() {
  const uploads = readUploads();
  const before = uploads.length;
  let cleared = 0;
  try {
    cleared = Number(localStorage.getItem(CLEARED_KEY) ?? 0);
  } catch {}
  for (const sample of freeloader.debug().lastUploadSamples) {
    if (sample.at <= cleared) continue;
    if (uploads.some((u) => u.end === sample.at && u.bytes === sample.bytes)) continue;
    const type = sample.source === "xhr-upload" ? "xmlhttprequest" : "fetch";
    uploads.push({ name: sample.source, type, bytes: sample.bytes, start: sample.at - sample.durationMilliseconds, end: sample.at });
  }
  if (uploads.length > before) write(UPLOADS_KEY, uploads, 500);
}

rememberUploads();
freeloader.subscribe(rememberUploads);

/**
 * Each file's size and when it was requested and finished, in epoch
 * milliseconds. From the request rather than the first byte: a small file
 * often arrives in one packet, and timing only its arrival would make it look
 * impossibly fast. Cache hits moved nothing and cross-origin files without
 * Timing-Allow-Origin hide their size, so both are left out.
 */
function rememberFiles(entries) {
  const files = readFiles();
  const epoch = (t) => Math.round((performance.timeOrigin + t) * 10) / 10;
  for (const entry of entries) {
    const start = epoch(entry.requestStart || entry.startTime);
    const end = epoch(entry.responseEnd);
    if (!(entry.transferSize > 0) || !(end > start)) continue;
    // The page's own entry is reported again once it finishes loading.
    if (files.some((f) => f.start === start && f.name === entry.name)) continue;
    files.push({ name: entry.name, type: entry.initiatorType, bytes: entry.transferSize, start, end });
  }
  write(FILES_KEY, files, 1500);
}

try {
  const observer = new PerformanceObserver((list) => rememberFiles(list.getEntries()));
  observer.observe({ type: "navigation", buffered: true });
  observer.observe({ type: "resource", buffered: true });
} catch {}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => render(freeloader.getEstimate()));
} else {
  render(freeloader.getEstimate());
}
freeloader.subscribe(render);

// Mark the current page in the nav. Compared by file name rather than by full
// path, because the site is served from a subdirectory on GitHub Pages and from
// the root locally.
const page = location.pathname.split("/").pop() || "index.html";
for (const link of document.querySelectorAll("nav.site a")) {
  if (new URL(link.href).pathname.split("/").pop() === page) link.setAttribute("aria-current", "page");
}
