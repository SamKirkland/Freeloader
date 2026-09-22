/**
 * An active speed test, built out of the site's own static files.
 *
 * Freeloader itself never makes a request — that is the whole point of it. But a
 * claim about accuracy is worth nothing without something to check it against,
 * and on a static host there is no throttled dev server to ask. So this module
 * does what a conventional speed test does: it pulls a known number of real
 * bytes off the real server and times them. The result is the ground truth the
 * passive estimate gets graded against.
 *
 * Nothing here is part of the library. It is the referee, not the player.
 */

/** Files the test may pull. Text is excluded: a CDN gzips it, and the reader
 * below would then count decompressed bytes that never crossed the wire. */
export function measurableFiles(manifest) {
  return manifest.files
    .filter((file) => !file.compressible && file.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * What to pull for the throughput run. Small files are dropped when there are
 * enough large ones: a 40 KB image spends most of its life in request overhead
 * and connection ramp, which measures the round trip rather than the link.
 */
export function downloadFiles(manifest, minimumBytes = 1_000_000) {
  const measurable = measurableFiles(manifest);
  const large = measurable.filter((file) => file.bytes >= minimumBytes);
  return large.length >= 3 ? large : measurable;
}

/** The smallest file on the site, for pinging. */
export function latencyFile(manifest) {
  const measurable = measurableFiles(manifest);
  return measurable[measurable.length - 1] ?? null;
}

export async function loadManifest(url = "assets/manifest.json") {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`manifest unavailable (${response.status})`);
  return response.json();
}

/** A unique URL every time, so nothing is answered from a cache. */
function bust(path, token) {
  return `${path}?speedtest=${token}`;
}

/**
 * Bytes moved inside the best `windowMs` window, expressed as a rate.
 *
 * The average over a whole run is dragged down by the ramp at the start and by
 * whatever the last stream was doing as it drained. The peak sustained window
 * is the closer answer to "what is this link capable of", which is the same
 * quantity Freeloader's `peakBitsPerSecond` reaches for.
 */
function peakWindowBps(events, windowMs) {
  if (events.length < 2) return null;
  let best = 0;
  let start = 0;
  let sum = 0;
  for (let end = 0; end < events.length; end++) {
    sum += events[end].bytes;
    while (events[end].t - events[start].t > windowMs) {
      sum -= events[start].bytes;
      start++;
    }
    const span = events[end].t - events[start].t;
    if (span >= windowMs * 0.5) best = Math.max(best, (sum * 8000) / span);
  }
  return best > 0 ? best : null;
}

/** Bytes that arrived strictly between two timestamps, as a rate. */
function windowBps(events, from, to) {
  if (to - from <= 0) return null;
  let bytes = 0;
  for (const event of events) {
    if (event.t > from && event.t <= to) bytes += event.bytes;
  }
  return bytes > 0 ? (bytes * 8000) / (to - from) : null;
}

/**
 * How long a run has to be before it means anything, and how much of it is
 * spent getting up to speed.
 *
 * Both are really counted in round trips rather than in milliseconds. A link
 * ramps over a handful of RTTs, and a window is long enough once it contains
 * enough of them that no single stalled moment can dominate it. A fixed ten
 * seconds is therefore far more than a fast, close link needs — and on a 2.5
 * Gbps connection every one of those seconds costs about 300 MB.
 */
export function measurementPlan(roundTripMilliseconds) {
  const rtt = roundTripMilliseconds && roundTripMilliseconds > 0 ? roundTripMilliseconds : 40;
  return {
    warmupMs: Math.min(900, Math.max(300, Math.round(rtt * 10))),
    minMeasureMs: Math.min(4_000, Math.max(900, Math.round(rtt * 40))),
  };
}

/**
 * Download as hard as the browser will allow, and report what the link did.
 *
 * `streams` parallel fetches run at once, because a single TCP stream on a fast
 * link is limited by its congestion window long before it is limited by the
 * link — which is exactly why single-stream speed tests read low.
 *
 * `durationMilliseconds` is a ceiling rather than a length. The run ends at whichever
 * arrives first: the reading settling down, the data budget, or the clock.
 * There is no accuracy in the seconds after a link has already shown what it
 * can do, and on a fast connection those seconds are where the gigabytes go.
 */
export async function runDownloadTest({
  files,
  streams = 6,
  durationMilliseconds = 10_000,
  /** A hard ceiling on bytes pulled. The honest cost of measuring a 2.5 Gbps
   * link is 300 MB for every second of it, and somebody pays for that. */
  maxBytes = 300e6,
  roundTripMilliseconds = null,
  warmupMs = null,
  minMeasureMs = null,
  /** How closely the last second has to match the run so far to call it done. */
  tolerance = 0.06,
  onProgress = () => {},
} = {}) {
  if (!files || files.length === 0) throw new Error("no measurable files");

  const plan = measurementPlan(roundTripMilliseconds);
  const warmup = warmupMs ?? plan.warmupMs;
  const minMeasure = minMeasureMs ?? plan.minMeasureMs;

  // The default buffer holds 250 entries; a fast link burns through that in a
  // second, and the cross-check below would have almost nothing left to read.
  performance.setResourceTimingBufferSize?.(10_000);

  const controller = new AbortController();
  const events = [];
  const started = performance.now();
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const urls = [];
  let requested = 0;
  let totalBytes = 0;
  let finished = false;

  // Largest files first: they are the ones that reach full rate. Cycle with a
  // fresh cache-buster each pass, so a short asset set can still fill a long run.
  let cursor = 0;
  const nextUrl = () => {
    const file = files[cursor % files.length];
    const pass = Math.floor(cursor / files.length);
    cursor++;
    const url = bust(file.path, `${token}-${pass}-${cursor}`);
    urls.push(url);
    return url;
  };

  const elapsed = () => performance.now() - started;

  let stopReason = null;
  let agreements = 0;
  let checkedAt = 0;

  /**
   * True once another second of downloading would only repeat what the last
   * one said. Two checks in a row have to agree, so one quiet moment mid-run
   * cannot end the test on a reading that was about to move.
   */
  const settled = (now) => {
    if (now < warmup + minMeasure) return false;
    if (now - checkedAt < 250) return false;
    checkedAt = now;
    const clock = performance.now();
    const recent = windowBps(events, clock - 1000, clock);
    const overall = windowBps(events, started + warmup, clock);
    if (!recent || !overall) return false;
    if (Math.abs(recent - overall) / overall > tolerance) {
      agreements = 0;
      return false;
    }
    agreements += 1;
    return agreements >= 2;
  };

  /** The three ways a run ends. Once one of them fires it stays fired. */
  const stop = () => {
    if (stopReason) return true;
    const now = elapsed();
    if (now >= durationMilliseconds) stopReason = "time";
    else if (totalBytes >= maxBytes) stopReason = "budget";
    else if (settled(now)) stopReason = "settled";
    return stopReason !== null;
  };

  const report = () => {
    const now = elapsed();
    onProgress({
      elapsedMs: now,
      totalBytes,
      // A short trailing window, so the dial moves with the link rather than
      // slowly converging on an average.
      currentBps: windowBps(events, performance.now() - 1000, performance.now()),
      // Whichever ceiling is nearer: on a fast link the bar tracks the budget,
      // on a slow one the clock.
      progress: Math.min(1, Math.max(now / durationMilliseconds, totalBytes / maxBytes)),
    });
  };

  async function pump() {
    while (!finished) {
      if (stop()) return;
      const url = nextUrl();
      requested++;
      let response;
      try {
        response = await fetch(url, { cache: "no-store", signal: controller.signal });
      } catch {
        return; // Aborted, or the network went away mid-test.
      }
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push({ t: performance.now(), bytes: value.byteLength });
          totalBytes += value.byteLength;
          if (stop()) {
            finished = true;
            controller.abort();
            return;
          }
        }
      } catch {
        return; // Abort lands here; the bytes already counted still stand.
      }
    }
  }

  const ticker = setInterval(report, 200);
  try {
    await Promise.all(Array.from({ length: streams }, () => pump()));
  } finally {
    finished = true;
    controller.abort();
    clearInterval(ticker);
  }

  const ended = events.length > 0 ? events[events.length - 1].t : performance.now();
  const measureFrom = started + warmup;
  const measuredMs = Math.max(0, ended - measureFrom);

  // "Best sustained second" has to have had a second to happen in. When the
  // budget cut the run short, report the longest window the run can actually
  // support rather than a second that was never measured.
  const peakWindowMs = measuredMs >= 2_000 ? 1_000 : Math.max(300, Math.round(measuredMs / 2));

  // What the wire actually carried, when the browser will tell us. The reader
  // counts decoded body bytes; Resource Timing also counts headers, and is the
  // more honest figure — but its buffer is finite, and a fast link overruns it,
  // so this is a cross-check on the requests it did keep rather than a total.
  let wireBytes = 0;
  let encodedBytes = 0;
  let covered = 0;
  const origin = location.href;
  for (const url of urls) {
    const entry = performance.getEntriesByName(new URL(url, origin).href).pop();
    if (!entry || !entry.transferSize) continue;
    wireBytes += entry.transferSize;
    encodedBytes += entry.encodedBodySize || 0;
    covered++;
  }

  return {
    at: Date.now(),
    durationMilliseconds: ended - started,
    streams,
    requests: requested,
    bodyBytes: totalBytes,
    /** "settled", "budget" or "time" — why the run stopped when it did. */
    stopReason: stopReason ?? "time",
    budgetBytes: maxBytes,
    warmupMs: warmup,
    measuredMs,
    peakWindowMs,
    /** The budget ran out before the reading had a full window to form in, so
     * what follows is a floor on the link rather than a measure of it. */
    budgetLimited: stopReason === "budget" && measuredMs < minMeasure,
    /** Wire bytes for the subset of requests Resource Timing still remembers. */
    wireBytes: covered > 0 ? wireBytes : null,
    /** Body bytes for that same subset, so the two are comparable. */
    wireEncodedBytes: covered > 0 ? encodedBytes : null,
    wireCoverage: requested > 0 ? covered / requested : 0,
    /** Steady-state average: the run with its opening ramp cut off. */
    averageBitsPerSecond: windowBps(events, measureFrom, ended),
    /** Best sustained window — a second long, when the run was long enough. */
    peakBitsPerSecond: peakWindowBps(events, peakWindowMs),
    /** Everything including the ramp, for comparison. */
    rawBps: windowBps(events, started, ended),
  };
}

/**
 * Where uploads are sent. Nothing accepts them — a static host answers a POST
 * with 405 — and nothing needs to: the browser reports the body going out over
 * the wire whatever comes back.
 */
export const UPLOAD_TARGET = "assets/sink.txt";

/** Incompressible bytes, so the link is what limits the upload and not a gzip. */
function payload(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer.subarray(0, Math.min(bytes, 65536)));
  for (let offset = 65536; offset < bytes; offset += 65536) {
    buffer.copyWithin(offset, 0, Math.min(65536, bytes - offset));
  }
  return buffer;
}

/** One buffer per size, kept for the run. Re-POSTing a body costs nothing;
 * filling 32 MB with random bytes again for every request does not. */
function payloadCache() {
  const buffers = new Map();
  return (bytes) => {
    let buffer = buffers.get(bytes);
    if (!buffer) {
      buffer = payload(bytes);
      buffers.set(bytes, buffer);
    }
    return buffer;
  };
}

/**
 * Upload as hard as the browser will allow, and report what the link did.
 *
 * `XMLHttpRequest` is used rather than fetch because its upload object fires
 * progress events, which is the only view a browser gives of a request body
 * leaving. That view has a hard limit: `loaded` counts bytes handed to the
 * socket rather than bytes the far end acknowledged, and it arrives in lumps as
 * buffers drain.
 *
 * Which is why there is an average here and deliberately no peak. Against a link
 * throttled to exactly 100 Mbps, the total across a run lands within about a
 * tenth of the truth, while the best window reads +160% at one second, +98% at
 * two, +37% at four and +16% at six — converging only by turning into the
 * average. No window is both short enough to mean "peak" and long enough to be
 * true, so the honest figure is total bytes over total time, which is anchored
 * at both ends by something real.
 *
 * Only bytes from requests that finished are counted. A host that refuses the
 * body part way through and closes the socket would otherwise have its first
 * burst measured over and over — which would report the size of a send buffer
 * as the speed of the link.
 *
 * Like the download, `durationMilliseconds` is a ceiling and the run stops as soon as it
 * has an answer. The body size is not fixed either: it starts small and doubles
 * while requests keep finishing too fast to time, which is how a 2.5 Gbps link
 * avoids measuring four megabytes of request overhead over and over.
 */
export async function runUploadTest({
  target = UPLOAD_TARGET,
  streams = 4,
  durationMilliseconds = 10_000,
  /** Where the body size starts. It grows from here — see `pump` below. */
  chunkBytes = 2e6,
  maxChunkBytes = 32e6,
  // A ceiling on total bytes, because the other end of this is somebody's
  // static host and a fast link would otherwise post gigabytes at it.
  maxBytes = 200e6,
  roundTripMilliseconds = null,
  minMeasureMs = null,
  tolerance = 0.08,
  onProgress = () => {},
} = {}) {
  // An upload has no warm-up to discard — the average is taken over the whole
  // run, both ends of it anchored in something real — so the run itself has to
  // be long enough that the ramp is a small part of it. A longer floor than the
  // download's, which gets to throw its ramp away.
  const minMeasure = minMeasureMs ?? Math.max(1_500, measurementPlan(roundTripMilliseconds).minMeasureMs);
  const bufferFor = payloadCache();
  const events = [];
  const started = performance.now();
  const inFlight = new Set();
  let chunk = Math.min(chunkBytes, maxChunkBytes);
  let committedBytes = 0;
  // Everything handed to a socket, refused requests included. This is what the
  // run actually costs, so it is what the budget is spent against.
  let sentBytes = 0;
  let requests = 0;
  let completed = 0;
  let refused = 0;
  let finished = false;

  const elapsed = () => performance.now() - started;

  let stopReason = null;
  let agreements = 0;
  let checkedAt = 0;

  /** The download's rule, applied to a lumpier signal: stop once the last
   * second only repeats what the run has already said. */
  const settled = (now) => {
    if (now < minMeasure) return false;
    if (now - checkedAt < 250) return false;
    checkedAt = now;
    const clock = performance.now();
    const recent = windowBps(events, clock - 1000, clock);
    const overall = windowBps(events, started, clock);
    if (!recent || !overall) return false;
    if (Math.abs(recent - overall) / overall > tolerance) {
      agreements = 0;
      return false;
    }
    agreements += 1;
    return agreements >= 2;
  };

  const done = () => {
    if (finished || stopReason) return true;
    const now = elapsed();
    if (now >= durationMilliseconds) stopReason = "time";
    else if (sentBytes >= maxBytes) stopReason = "budget";
    else if (settled(now)) stopReason = "settled";
    return stopReason !== null;
  };

  /** One POST, resolving when its body is out, refused, or cut short by us. */
  function send(size) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      inFlight.add(xhr);
      requests++;

      // Held aside until the request finishes: bytes from a refused upload say
      // more about the refusal than about the link.
      const pending = [];
      const startedAt = performance.now();
      let last = 0;
      let ourAbort = false;

      const settle = (keep) => {
        inFlight.delete(xhr);
        if (keep) {
          for (const event of pending) events.push(event);
          committedBytes += last;
        }
        resolve({ ms: performance.now() - startedAt, whole: last >= size });
      };

      xhr.upload.addEventListener("progress", (event) => {
        const delta = event.loaded - last;
        last = event.loaded;
        if (delta > 0) {
          pending.push({ t: performance.now(), bytes: delta });
          sentBytes += delta;
        }
        if (done() && !ourAbort) {
          ourAbort = true;
          xhr.abort();
        }
      });
      // The body is out. Whatever the server answers is beside the point.
      xhr.upload.addEventListener("load", () => {
        completed++;
        settle(true);
      });
      // Our own deadline, so the bytes that did go out still count.
      xhr.upload.addEventListener("abort", () => settle(ourAbort));
      xhr.upload.addEventListener("error", () => {
        refused++;
        settle(false);
      });
      xhr.addEventListener("error", () => settle(false));

      try {
        xhr.open("POST", target);
        xhr.send(bufferFor(size));
      } catch {
        settle(false);
      }
    });
  }

  async function pump() {
    while (!done()) {
      const size = chunk;
      const outcome = await send(size);
      // A request that was over before it began measured the round trip, not
      // the link. Grow the body until one takes long enough to time — and only
      // on a body that actually made it out, so a refusal cannot drive this.
      if (outcome.whole && outcome.ms < 400 && chunk < maxChunkBytes) {
        chunk = Math.min(maxChunkBytes, chunk * 2);
      }
    }
  }

  const ticker = setInterval(() => {
    onProgress({
      elapsedMs: elapsed(),
      totalBytes: sentBytes,
      currentBps: windowBps(events, performance.now() - 1000, performance.now()),
      progress: Math.min(1, Math.max(elapsed() / durationMilliseconds, sentBytes / maxBytes)),
    });
  }, 200);

  try {
    await Promise.all(Array.from({ length: streams }, () => pump()));
  } finally {
    finished = true;
    for (const xhr of inFlight) xhr.abort();
    clearInterval(ticker);
  }

  const ended = events.length > 0 ? events[events.length - 1].t : performance.now();
  const runMs = ended - started;

  return {
    at: Date.now(),
    durationMilliseconds: runMs,
    streams,
    requests,
    completed,
    refused,
    /** Bytes the rate below is computed from: the ones that finished. */
    bytes: committedBytes,
    /** Bytes the run actually cost, which is the larger and less useful number. */
    sentBytes,
    /** Where the body size ended up after ramping. */
    chunkBytes: chunk,
    stopReason: stopReason ?? "time",
    budgetBytes: maxBytes,
    /** The budget ran out before the run was long enough for the ramp to stop
     * mattering, so the rate below is a floor rather than a measure. */
    budgetLimited: stopReason === "budget" && runMs < minMeasure,
    /** Total bytes over the whole run: both ends of it are real. */
    averageBitsPerSecond: runMs > 0 && committedBytes > 0 ? (committedBytes * 8000) / runMs : null,
    /** Deliberately absent; see the note above. */
    peakBitsPerSecond: null,
    /** True when nothing finished, so there is no figure rather than a wrong one. */
    unmeasurable: committedBytes === 0,
  };
}

/**
 * Round trip and jitter, measured the same way the library defines them, so the
 * two numbers can honestly be put side by side: round trip is the *minimum*
 * time to first byte (queuing can only inflate a reading, never deflate it),
 * and jitter is the mean absolute deviation of time to first byte around its
 * median.
 *
 * Requests are serial and the asset is tiny, so nothing is ever contending.
 */
export async function runLatencyTest({ file, count = 6, onProgress = () => {} } = {}) {
  if (!file) throw new Error("no file for the latency test");
  const ttfbs = [];
  const handshakes = [];
  const token = Date.now().toString(36);
  // Small, but it is still traffic this test caused, so it is counted.
  let bytes = 0;

  for (let i = 0; i < count; i++) {
    const url = bust(file.path, `ping-${token}-${i}`);
    const wallStart = performance.now();
    try {
      const response = await fetch(url, { cache: "no-store" });
      await response.arrayBuffer();
    } catch {
      continue;
    }
    const wall = performance.now() - wallStart;
    const entry = performance.getEntriesByName(new URL(url, location.href).href).pop();
    // requestStart..responseStart is time to first byte with the connection
    // setup already excluded, which is the number we want. Fall back to the
    // wall clock when the entry is missing.
    bytes += entry?.transferSize || file.bytes || 0;
    if (entry && entry.responseStart > 0 && entry.requestStart > 0) {
      ttfbs.push(entry.responseStart - entry.requestStart);
      if (entry.connectEnd > entry.connectStart) handshakes.push(entry.connectEnd - entry.connectStart);
    } else {
      ttfbs.push(wall);
    }
    onProgress({ done: i + 1, count });
    // A breath between pings, so one does not queue behind the last. Long
    // enough for the previous connection to go quiet, and no longer: this runs
    // before the download and every millisecond of it is dead time.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (ttfbs.length === 0) return { samples: 0, bytes, roundTripMilliseconds: null, timeToFirstByteMilliseconds: null, jitterMilliseconds: null };

  const sorted = ttfbs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviation = ttfbs.reduce((sum, value) => sum + Math.abs(value - median), 0) / ttfbs.length;

  // Half a handshake is a cleaner round trip than a time to first byte, which
  // also contains however long the server took to think — so take whichever of
  // the two is smaller. Both are minimums; neither can undershoot the truth.
  const fromHandshake = handshakes.length > 0 ? Math.min(...handshakes) / 2 : null;

  return {
    at: Date.now(),
    samples: ttfbs.length,
    bytes,
    roundTripMilliseconds: fromHandshake === null ? sorted[0] : Math.min(sorted[0], fromHandshake),
    timeToFirstByteMilliseconds: median,
    jitterMilliseconds: deviation,
  };
}

/** Where the last run is kept, so other pages can show the comparison too. */
export const RESULT_KEY = "freeloader:speed-test-result";

export function saveResult(result) {
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify(result));
  } catch {
    // Private browsing, or a full quota. The page still works without it.
  }
}

export function loadResult() {
  try {
    const raw = localStorage.getItem(RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
