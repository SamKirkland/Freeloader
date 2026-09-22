/**
 * Charts for the debug page, drawn from what boot.js saves on every page.
 *
 * One hump per transfer, stacked. Downloads come from the browser's own
 * Resource Timing and span from the request to the last byte; uploads come
 * from Freeloader, which times each body going out. A hump's area is its size,
 * so the top edge of the stack is everything moving at that moment. The shape
 * inside each hump is a guess; timing only says when things started and
 * finished. Freeloader's estimate is drawn over each chart as a dashed line.
 *
 * Both charts share one time window: the last two minutes by default, following
 * the clock. Scroll to zoom, drag to pan.
 */
import { formatBitsPerSecond, formatBytes } from "../freeloader.js";
import { clearHistory, readFiles, readHistory, readUploads } from "./boot.js";
import { UPLOAD_TARGET, loadManifest, measurableFiles } from "./speedtest.js";

const SVG = "http://www.w3.org/2000/svg";
const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 76 };
const DEFAULT_SPAN = 2 * 60_000;
const MIN_SPAN = 10;
const MAX_SPAN = 24 * 3_600_000;
/** No hump is drawn narrower than this; see drawHumps. */
const MIN_HUMP_PX = 6;
/** Tick spacings for the time axis, in milliseconds. */
const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000,
];

/**
 * The visible window, in epoch milliseconds. `want` is the width asked for and
 * `span` what is shown, which is less while there isn't that much history.
 * While `live`, the window tracks now. `earliest` is the oldest record.
 */
const view = { end: Date.now(), span: DEFAULT_SPAN, want: DEFAULT_SPAN, live: true, earliest: Date.now() };

/**
 * Never narrower than the margins plus some plot area. A hidden or collapsed
 * page can report a tiny width, and a negative plot width would make the
 * sampling loop step backwards forever.
 */
function chartWidth(svg) {
  return Math.max(320, svg.clientWidth);
}

function el(name, attributes, text) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A round step giving about `count` ticks up to `max`: 1, 2 or 5 times a power of ten. */
function niceStep(max, count) {
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw);
}

function timeLabel(at, step) {
  const date = new Date(at);
  const text = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: step < 60_000 ? "2-digit" : undefined });
  return step < 1000 ? `${text.replace(/\s?[AP]M$/i, "")}.${String(date.getMilliseconds()).padStart(3, "0")}` : text;
}

/**
 * Clears the SVG and draws both axes for the current window. Returns the
 * mappings and a group, clipped to the plot area, to draw the data into.
 */
function frame(svg, maxValue) {
  const width = chartWidth(svg);
  const start = view.end - view.span;
  svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
  svg.replaceChildren();

  // At least 1 Mbps, with headroom above the highest point.
  const top = Math.max(1e6, maxValue) * 1.1;
  const yStep = niceStep(top, 4);
  const yMax = yStep * Math.ceil(top / yStep);
  const y = (v) => HEIGHT - MARGIN.bottom - (v / yMax) * (HEIGHT - MARGIN.top - MARGIN.bottom);
  const x = (at) => MARGIN.left + ((at - start) / view.span) * (width - MARGIN.left - MARGIN.right);

  for (let v = 0; v <= yMax + yStep / 2; v += yStep) {
    svg.append(el("line", { class: "grid", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(v), y2: y(v) }));
    svg.append(el("text", { class: "tick", x: MARGIN.left - 8, y: y(v) + 4, "text-anchor": "end" }, v ? formatBitsPerSecond(v) : "0"));
  }
  const step = TIME_STEPS.find((s) => s >= view.span / Math.max(2, Math.floor(width / 130))) ?? 86_400_000;
  for (let at = Math.ceil(start / step) * step; at <= view.end; at += step) {
    svg.append(el("text", { class: "tick", x: x(at), y: HEIGHT - 6, "text-anchor": "middle" }, timeLabel(at, step)));
  }

  const id = `clip-${svg.closest(".chart").dataset.series}`;
  const clip = el("clipPath", { id });
  clip.append(el("rect", { x: MARGIN.left, y: 0, width: width - MARGIN.left - MARGIN.right, height: HEIGHT - MARGIN.bottom }));
  const plot = el("g", { "clip-path": `url(#${id})` });
  svg.append(clip, plot);
  return { x, y, plot, width, start };
}

function empty(svg, message) {
  const width = chartWidth(svg);
  svg.append(el("text", { class: "tick", x: (width + MARGIN.left) / 2, y: HEIGHT / 2, "text-anchor": "middle" }, message));
}

/** A half-sine hump with the file's bytes as its area: bits = peak × duration × 2/π. */
function rate(file, t) {
  if (t <= file.start || t >= file.end) return 0;
  const seconds = (file.end - file.start) / 1000;
  return ((file.bytes * 8 * Math.PI) / 2 / seconds) * Math.sin((Math.PI * (t - file.start)) / (file.end - file.start));
}

/**
 * One hump per transfer, stacked in start order, with Freeloader's estimate
 * over time as a dashed line on top. `records` are files or uploads, in the
 * shape boot.js saves them; `series` picks the estimate to draw.
 */
function drawHumps(section, records, series, noun) {
  const svg = section.querySelector("svg");
  const start = view.end - view.span;
  const width = chartWidth(svg);
  const perPixel = view.span / (width - MARGIN.left - MARGIN.right);

  // Zoomed out, most transfers last less than a pixel and would be drawn as
  // invisible slivers as tall as their instant rate. Widen those to a few
  // pixels around their middle, keeping the area (the bytes), so the top edge
  // shows the rate averaged over what a pixel can show. Zoom in for the shape.
  const minimum = MIN_HUMP_PX * perPixel;
  const shown = records
    .map((record) => {
      if (record.end - record.start >= minimum) return { ...record, actual: record };
      const middle = (record.start + record.end) / 2;
      return { ...record, start: middle - minimum / 2, end: middle + minimum / 2, actual: record };
    })
    .filter((r) => r.end > start && r.start < view.end)
    .sort((a, b) => a.start - b.start);

  // Sample every couple of pixels, plus each hump's ends and middle. Sweeping
  // in time order keeps an ordered list of what is in flight; each sits on the
  // ones that started before it.
  const times = new Set(shown.flatMap((r) => [r.start, r.end, (r.start + r.end) / 2]));
  for (let t = start; t <= view.end; t += 2 * perPixel) times.add(t);
  const bands = new Map(shown.map((r) => [r, []]));
  let next = 0;
  let active = [];
  let highest = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    while (next < shown.length && shown[next].start <= t) active.push(shown[next++]);
    active = active.filter((r) => r.end >= t);
    let base = 0;
    for (const record of active) {
      const top = base + rate(record, t);
      bands.get(record).push([t, base, top]);
      base = top;
    }
    highest = Math.max(highest, base);
  }

  // The estimate: every change inside the window, plus the one in force as it opens.
  const history = readHistory().filter((p) => p[series] !== null);
  const estimate = history.filter(
    (p, i) => p.at <= view.end && (p.at >= start || !(history[i + 1]?.at < start)),
  );

  const { x, y, plot } = frame(svg, Math.max(highest, ...estimate.map((p) => p[series])));
  const total = shown.reduce((sum, r) => sum + r.bytes, 0);
  const latest = history[history.length - 1];
  section.querySelector(".value").textContent = [
    shown.length ? `${shown.length} ${noun} · ${formatBytes(total)} in view` : "",
    latest ? `estimate ${formatBitsPerSecond(latest[series])}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  for (const [record, points] of bands) {
    const upper = points.map(([t, , top]) => `${x(t).toFixed(1)},${y(top).toFixed(1)}`);
    const lower = points.map(([t, base]) => `${x(t).toFixed(1)},${y(base).toFixed(1)}`).reverse();
    const hump = el("polygon", { class: `hump type-${record.type}`, points: [...upper, ...lower].join(" ") });
    // The real timing, not the widened one it may be drawn with.
    const { actual } = record;
    const average = (actual.bytes * 8) / ((actual.end - actual.start) / 1000);
    const name = actual.name.split("?")[0].split("/").pop() || actual.name;
    hump.append(el("title", {}, `${name} (${actual.type})\n${formatBytes(actual.bytes)} in ${(actual.end - actual.start).toFixed(0)} ms, ${formatBitsPerSecond(average)}`));
    plot.append(hump);
  }

  if (estimate.length > 0) {
    let path = `M ${x(estimate[0].at)} ${y(estimate[0][series])}`;
    for (const p of estimate.slice(1)) path += ` H ${x(p.at)} V ${y(p[series])}`;
    plot.append(el("path", { class: "estimate", d: `${path} H ${x(Math.min(Date.now(), view.end))}` }));
  }
  if (shown.length === 0 && estimate.length === 0) empty(svg, `No ${noun} in this window`);
}

const downloadChart = document.querySelector('[data-series="download"]');
const uploadChart = document.querySelector('[data-series="upload"]');
let queued = false;
/** At most one redraw per frame, however many wheel or pointer events arrive. */
function draw() {
  if (queued) return;
  queued = true;
  const run = () => {
    queued = false;
    const files = readFiles();
    const uploads = readUploads();
    const history = readHistory();
    view.earliest = Math.min(Date.now(), ...files.map((f) => f.start), ...uploads.map((u) => u.start), ...history.map((p) => p.at));
    settle();
    drawHumps(downloadChart, files, "download", "files");
    drawHumps(uploadChart, uploads, "upload", "uploads");
  };
  // Frames don't fire in a hidden tab; draw straight away so it's current when shown.
  if (document.hidden) run();
  else requestAnimationFrame(run);
}

// Zoom around the cursor with the wheel; pan with a sideways scroll or a drag.
function plotFraction(svg, clientX) {
  const box = svg.getBoundingClientRect();
  const left = (MARGIN.left / (chartWidth(svg))) * box.width;
  const right = (MARGIN.right / (chartWidth(svg))) * box.width;
  return Math.min(1, Math.max(0, (clientX - box.left - left) / (box.width - left - right)));
}

/**
 * Keeps the window over data that exists: no wider than from the oldest record
 * to now, and never past either end. While there is less history than asked
 * for, the window shows all of it and widens as more arrives.
 */
function settle() {
  const now = Date.now();
  view.span = Math.min(view.want, Math.max(MIN_SPAN, now - view.earliest));
  if (view.live) view.end = now;
  view.end = Math.min(now, Math.max(view.end, view.earliest + view.span));
}

function setView(end, span) {
  if (!Number.isFinite(end) || !Number.isFinite(span)) return;
  view.want = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
  view.end = end;
  // Back at the present: follow the clock again.
  view.live = view.end >= Date.now() - view.want * 0.01;
  settle();
  // Zooming out past the data stops at the data, rather than being remembered.
  view.want = view.span;
  draw();
}

for (const svg of document.querySelectorAll(".chart svg")) {
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        setView(view.end + (event.deltaX / chartWidth(svg)) * view.span, view.span);
        return;
      }
      const anchor = view.end - view.span + plotFraction(svg, event.clientX) * view.span;
      const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, view.span * Math.exp(event.deltaY * 0.002)));
      setView(anchor + (view.end - anchor) * (span / view.span), span);
    },
    { passive: false },
  );

  let dragFrom = null;
  svg.addEventListener("pointerdown", (event) => {
    dragFrom = { x: event.clientX, end: view.end };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    const box = svg.getBoundingClientRect();
    const msPerPx = view.span / (box.width * (1 - (MARGIN.left + MARGIN.right) / (chartWidth(svg))));
    setView(dragFrom.end - (event.clientX - dragFrom.x) * msPerPx, view.span);
  });
  const release = () => {
    dragFrom = null;
  };
  svg.addEventListener("pointerup", release);
  svg.addEventListener("pointercancel", release);
}

document.getElementById("live").addEventListener("click", () => {
  view.want = DEFAULT_SPAN;
  view.live = true;
  draw();
});

draw();
// boot.js observes first, so new files and estimates are already saved when these run.
new PerformanceObserver(draw).observe({ type: "resource" });
window.freeloader.subscribe(draw);
// While following the clock, keep the window moving between changes.
setInterval(() => view.live && draw(), 1000);
addEventListener("resize", draw);
// Other tabs of the demo write to the same history.
addEventListener("storage", draw);

document.getElementById("clear").addEventListener("click", () => {
  clearHistory();
  draw();
});

// Something to watch: pull one of the site's files, uncached.
const button = document.getElementById("traffic");
const status = document.getElementById("traffic-status");
const files = loadManifest().then(measurableFiles);
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const list = await files;
    const file = list[Math.floor(Math.random() * list.length)];
    status.textContent = `Downloading ${file.path.split("/").pop()}…`;
    await (await fetch(`${file.path}?debug=${Date.now()}`, { cache: "no-store" })).arrayBuffer();
    status.textContent = `Downloaded ${file.path.split("/").pop()}.`;
  } catch (error) {
    status.textContent = `Failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

// Nothing accepts the body, but the browser still reports it going out, which
// is all Freeloader times. Random bytes, so nothing can compress it on the way.
const uploadButton = document.getElementById("upload");
uploadButton.addEventListener("click", async () => {
  uploadButton.disabled = true;
  const body = new Uint8Array(2_000_000);
  // getRandomValues fills at most 64 KB per call.
  for (let i = 0; i < body.length; i += 65_536) crypto.getRandomValues(body.subarray(i, i + 65_536));
  status.textContent = "Uploading 2 MB…";
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("loadend", resolve);
    xhr.open("POST", UPLOAD_TARGET);
    xhr.send(body);
  });
  status.textContent = "Uploaded 2 MB.";
  uploadButton.disabled = false;
});
