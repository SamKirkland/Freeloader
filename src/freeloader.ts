/** Where a sample came from. Useful for debugging and for weighting. */
export type SampleSource =
  | "navigation"
  | "resource"
  | "burst"
  | "xhr-upload"
  | "fetch-upload";

/** One observation of "N bytes moved in M milliseconds". */
export interface ThroughputSample {
  /** Bytes actually moved over the wire (headers included where known). */
  bytes: number;
  /** Wall-clock milliseconds the transfer occupied. */
  durationMilliseconds: number;
  /** bytes*8/seconds, precomputed for convenience. */
  bitsPerSecond: number;
  /** How many transfers were in flight; 1 means a lone request. */
  concurrency: number;
  /** How many resources this sample is made of. A burst merges several. */
  resources: number;
  /**
   * Share of the bytes that arrived over newly opened connections, 0..1.
   * Only those bytes paid the TCP slow-start ramp, so only they get corrected
   * for it.
   */
  freshFraction: number;
  /** Epoch milliseconds when the sample finished. */
  at: number;
  source: SampleSource;
}

/** One observation of round-trip-ish delay. */
interface LatencySample {
  /** Time to first byte, minus connection setup when it was measurable. */
  timeToFirstByteMilliseconds: number;
  /** TCP+TLS handshake time, when the entry exposed it. */
  handshakeMilliseconds: number | null;
  /** DNS resolution time, when the entry exposed it. */
  domainLookupMilliseconds: number | null;
  /**
   * True when another transfer was in flight while this request waited for its
   * first byte. Such a request queued behind the page's own traffic, so its
   * delay describes the page, not the link.
   */
  contended: boolean;
  at: number;
  source: SampleSource;
}

/** How much to trust a number, and why. */
export interface Confidence {
  /** 0..1. Rises with sample count, total bytes and agreement between samples. */
  score: number;
  /** Number of usable samples behind the estimate. */
  samples: number;
  /** Total bytes observed for this direction. */
  bytes: number;
  /** Relative spread of the usable samples (0 = identical, 1 = wild). */
  spread: number;
}

export interface DirectionEstimate {
  /** Best estimate, bits per second. `null` until at least one usable sample. */
  bitsPerSecond: number | null;
  /** Convenience: bitsPerSecond / 1e6. */
  megabitsPerSecond: number | null;
  /** How many resources the estimate is built from. */
  resources: number;
  confidence: Confidence;
  /** Largest single sustained rate seen, bits per second. */
  peakBitsPerSecond: number | null;
  /**
   * Weighted mean of the observed samples, bits per second.
   *
   * A plain average of what was actually seen, which is *not* the estimate:
   * every passive sample is a lower bound, so the average sits below the link
   * while `bitsPerSecond` reaches for the top of the distribution. Useful as "what this
   * page typically got", next to `peakBitsPerSecond` as "the best it ever managed".
   */
  averageBitsPerSecond: number | null;
  /** Rate implied by a regression of duration on size, bits per second. */
  regressionBitsPerSecond: number | null;
}

export interface LatencyEstimate {
  /** Lower-bound round trip, milliseconds. Min-filtered to drop server think time. */
  roundTripMilliseconds: number | null;
  /** Median time to first byte, milliseconds. */
  timeToFirstByteMilliseconds: number | null;
  /** Mean absolute deviation of time to first byte, milliseconds. */
  jitterMilliseconds: number | null;
  /** How many resources the estimate is built from. */
  resources: number;
  confidence: Confidence;
}

export interface NetworkEstimate {
  download: DirectionEstimate;
  upload: DirectionEstimate;
  latency: LatencyEstimate;
  /** Epoch ms of the most recent sample folded in. */
  updatedAt: number;
}

export interface FreeloaderOptions {
  /** localStorage key. Default `freeloader`. */
  storageKey?: string;
  /** Persist to localStorage. Default true. */
  persist?: boolean;
  /** Ignore stored state older than this, milliseconds. Default 7 days. */
  maximumAgeMilliseconds?: number;
  /** Sample weight halves every this many milliseconds. Default 24 hours. */
  halfLifeMilliseconds?: number;
  /** Transfers smaller than this are ignored for download and upload speed. They still count for latency. Default 32768 bytes. */
  minimumSampleBytes?: number;
  /** Quantile of the weighted sample distribution used as the estimate. Default 0.9. */
  quantile?: number;
  /** Maximum download and upload samples kept. Default 100. */
  maximumSamples?: number;
  /** Maximum latency samples kept. Default 100. */
  maximumLatencySamples?: number;
  /** Merge transfers whose windows overlap (or nearly do) into one burst. Default true. */
  mergeBursts?: boolean;
  /** Gap, in milliseconds, still treated as part of the same burst. Default 30. */
  burstGapMilliseconds?: number;
  /**
   * How much of the TCP slow-start ramp to subtract from each transfer, 0..1.
   * Default 1. Lower it if your traffic mostly rides warm, already-open
   * connections, where there is no ramp to remove.
   */
  slowStartCorrection?: number;
  /** Patch fetch/XMLHttpRequest to time request bodies. Default true. */
  instrumentUploads?: boolean;
  /** Only observe these origins. Default: every origin the page already talks to. */
  origins?: string[];
  /** Called whenever the estimate changes. */
  onUpdate?: (estimate: NetworkEstimate) => void;
  /** Epoch-millisecond clock. Defaults to `Date.now`; override in tests. */
  now?: () => number;
  /**
   * Epoch millisecond that the performance clock's zero corresponds to.
   * Defaults to `performance.timeOrigin`; override in tests.
   */
  timeOrigin?: number;
}

interface PersistedState {
  version: 1;
  updatedAt: number;
  download: ThroughputSample[];
  upload: ThroughputSample[];
  latency: LatencySample[];
  /** Cumulative counters that survive sample eviction. */
  totals: { downloadBytes: number; uploadBytes: number; samples: number };
}

/** Human-readable bits per second, e.g. `42.3 Mbps`. */
export function formatBitsPerSecond(bitsPerSecond: number | null | undefined): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "—";
  if (bitsPerSecond >= 1e9) return `${(bitsPerSecond / 1e9).toFixed(2)} Gbps`;
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(1)} Mbps`;
  if (bitsPerSecond >= 1e3) return `${(bitsPerSecond / 1e3).toFixed(0)} kbps`;
  return `${bitsPerSecond.toFixed(0)} bps`;
}

/** Human-readable milliseconds, e.g. `18.4 ms`. */
export function formatMilliseconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(1)} ms`;
}

/**
 * Human-readable byte counts, e.g. `3.4 MB`.
 *
 * Decimal, not binary: a KB here is 1000 bytes. Everything else in this library
 * is decimal — a megabit is 1e6 bits — and mixing the two would mean a file the
 * operating system calls 7.8 MB showing up as 7.5 MB beside a rate in Mbps.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Small numeric helpers. No dependencies, no globals, safe to run anywhere. */

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Mean absolute deviation from the median: a jitter measure that ignores outliers. */
function meanAbsoluteDeviation(values: readonly number[]): number | null {
  const mid = median(values);
  if (mid === null) return null;
  let total = 0;
  for (const value of values) total += Math.abs(value - mid);
  return total / values.length;
}

interface Weighted {
  value: number;
  weight: number;
}

/**
 * Quantile of a weighted sample set, interpolating between the two samples
 * that straddle the target mass. Weight zero samples are ignored.
 */
function weightedQuantile(samples: readonly Weighted[], q: number): number | null {
  const usable = samples.filter((s) => s.weight > 0 && Number.isFinite(s.value));
  if (usable.length === 0) return null;
  if (usable.length === 1) return (usable[0] as Weighted).value;

  const sorted = [...usable].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  const target = clamp(q, 0, 1) * total;

  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i] as Weighted;
    const next = cumulative + current.weight;
    if (next >= target) {
      const previous = sorted[i - 1];
      if (!previous || current.weight === 0) return current.value;
      // Interpolate across the current sample's slice of the mass.
      const within = clamp((target - cumulative) / current.weight, 0, 1);
      return previous.value + (current.value - previous.value) * within;
    }
    cumulative = next;
  }
  return (sorted[sorted.length - 1] as Weighted).value;
}

function weightedMean(samples: readonly Weighted[]): number | null {
  let weight = 0;
  let total = 0;
  for (const sample of samples) {
    if (!(sample.weight > 0) || !Number.isFinite(sample.value)) continue;
    weight += sample.weight;
    total += sample.value * sample.weight;
  }
  return weight > 0 ? total / weight : null;
}

interface Regression {
  slope: number;
  intercept: number;
  /** Coefficient of determination, 0..1. */
  r2: number;
  n: number;
}

/**
 * Weighted least squares fit of y on x.
 *
 * Transfers obey `duration ≈ overhead + bytes / rate`, so fitting duration
 * against bytes recovers the rate as `1 / slope` with the per-request overhead
 * (handshake, time to first byte, slow start) falling out into the intercept.
 */
function linearRegression(
  points: readonly { x: number; y: number; weight?: number }[],
): Regression | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let n = 0;

  for (const point of points) {
    const weight = point.weight ?? 1;
    if (!(weight > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    sw += weight;
    sx += weight * point.x;
    sy += weight * point.y;
    sxx += weight * point.x * point.x;
    sxy += weight * point.x * point.y;
    n++;
  }
  if (n < 3 || sw <= 0) return null;

  const meanX = sx / sw;
  const meanY = sy / sw;
  const varianceX = sxx / sw - meanX * meanX;
  if (!(varianceX > 0)) return null;

  const covariance = sxy / sw - meanX * meanY;
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;

  let ssTotal = 0;
  let ssResidual = 0;
  for (const point of points) {
    const weight = point.weight ?? 1;
    if (!(weight > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const predicted = intercept + slope * point.x;
    ssTotal += weight * (point.y - meanY) ** 2;
    ssResidual += weight * (point.y - predicted) ** 2;
  }
  const r2 = ssTotal > 0 ? clamp(1 - ssResidual / ssTotal, 0, 1) : 0;

  return { slope, intercept, r2, n };
}

/** Exponential decay so old observations fade instead of being cliff-edged out. */
function decayWeight(ageMs: number, halfLifeMilliseconds: number): number {
  if (!(halfLifeMilliseconds > 0)) return 1;
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMilliseconds);
}

interface TransferWindow {
  start: number;
  end: number;
  bytes: number;
  /** True when this transfer opened a brand new connection. */
  fresh?: boolean;
}

interface MergedWindow {
  start: number;
  end: number;
  bytes: number;
  /** How many source windows fell into this burst. */
  count: number;
  /** Sum of the source durations divided by the burst duration. */
  concurrency: number;
  /** Bytes that arrived over connections opened for this transfer. */
  freshBytes: number;
  /** The windows that went into this burst, for re-buffering unfinished ones. */
  members: TransferWindow[];
}

/**
 * Collapse overlapping transfer windows into bursts.
 *
 * Six images downloading in parallel each look slow on their own, because each
 * one is only getting a slice of the link. Summing their bytes over the union
 * of their time windows recovers what the link actually did.
 */
function mergeWindows(windows: readonly TransferWindow[], gapMilliseconds = 0): MergedWindow[] {
  const valid = windows
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.bytes > 0)
    .sort((a, b) => a.start - b.start);
  if (valid.length === 0) return [];

  const merged: MergedWindow[] = [];
  let current: MergedWindow | null = null;
  let busyMs = 0;

  for (const window of valid) {
    if (current && window.start <= current.end + gapMilliseconds) {
      current.end = Math.max(current.end, window.end);
      current.bytes += window.bytes;
      current.count += 1;
      if (window.fresh) current.freshBytes += window.bytes;
      current.members.push(window);
      busyMs += window.end - window.start;
    } else {
      if (current) current.concurrency = busyMs / Math.max(1, current.end - current.start);
      busyMs = window.end - window.start;
      current = {
        start: window.start,
        end: window.end,
        bytes: window.bytes,
        count: 1,
        concurrency: 1,
        freshBytes: window.fresh ? window.bytes : 0,
        members: [window],
      };
      merged.push(current);
    }
  }
  if (current) current.concurrency = busyMs / Math.max(1, current.end - current.start);
  return merged;
}

/** The minimal slice of localStorage we need; makes the store trivially fakeable. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    // Private-mode Safari hands you a storage object that throws on write.
    const probe = "freeloader:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function isThroughputSample(value: unknown): value is ThroughputSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample["bytes"] === "number" &&
    typeof sample["durationMilliseconds"] === "number" &&
    typeof sample["bitsPerSecond"] === "number" &&
    typeof sample["resources"] === "number" &&
    typeof sample["at"] === "number" &&
    Number.isFinite(sample["bitsPerSecond"]) &&
    (sample["bitsPerSecond"] as number) > 0
  );
}

function isLatencySample(value: unknown): value is LatencySample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample["timeToFirstByteMilliseconds"] === "number" &&
    Number.isFinite(sample["timeToFirstByteMilliseconds"]) &&
    typeof sample["at"] === "number"
  );
}

function emptyState(now: number): PersistedState {
  return {
    version: 1,
    updatedAt: now,
    download: [],
    upload: [],
    latency: [],
    totals: { downloadBytes: 0, uploadBytes: 0, samples: 0 },
  };
}

/**
 * Parse stored state, discarding anything that is malformed, from another
 * schema version, or simply too old to describe the connection the user has
 * right now.
 */
function loadState(
  storage: StorageLike | null,
  key: string,
  maximumAgeMilliseconds: number,
  now: number,
): PersistedState {
  const fresh = emptyState(now);
  if (!storage) return fresh;

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fresh;
  }
  if (!raw) return fresh;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!parsed || typeof parsed !== "object") return fresh;

  const state = parsed as Partial<PersistedState>;
  if (state.version !== 1) return fresh;
  if (typeof state.updatedAt !== "number" || now - state.updatedAt > maximumAgeMilliseconds) return fresh;

  const cutoff = now - maximumAgeMilliseconds;
  const keepThroughput = (list: unknown): ThroughputSample[] =>
    Array.isArray(list) ? list.filter(isThroughputSample).filter((s) => s.at >= cutoff) : [];
  const totals = state.totals;

  return {
    version: 1,
    updatedAt: state.updatedAt,
    download: keepThroughput(state.download),
    upload: keepThroughput(state.upload),
    latency: Array.isArray(state.latency)
      ? state.latency
          .filter(isLatencySample)
          .filter((s) => s.at >= cutoff)
          .map((s) => ({ ...s, contended: s.contended === true }))
      : [],
    totals: {
      downloadBytes: typeof totals?.downloadBytes === "number" ? totals.downloadBytes : 0,
      uploadBytes: typeof totals?.uploadBytes === "number" ? totals.uploadBytes : 0,
      samples: typeof totals?.samples === "number" ? totals.samples : 0,
    },
  };
}

function saveState(storage: StorageLike | null, key: string, state: PersistedState): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled: estimates simply stop surviving reloads.
  }
}

function clearState(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/**
 * The parts of PerformanceResourceTiming we read. Declared structurally so the
 * parsing logic can be exercised without a browser.
 */
export interface TimingEntryLike {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  requestStart?: number;
  responseStart?: number;
  responseEnd?: number;
  domainLookupStart?: number;
  domainLookupEnd?: number;
  connectStart?: number;
  connectEnd?: number;
  secureConnectionStart?: number;
  deliveryType?: string;
  initiatorType?: string;
}

interface ParsedEntry {
  /** Download window on the performance clock, or null when unusable. */
  window: TransferWindow | null;
  /**
   * Latency observation, or null when the entry hid its timings. Contention is
   * decided later, once the surrounding transfers are known.
   */
  latency: Omit<LatencySample, "at" | "contended"> | null;
  /** The request's wait for its first byte, on the performance clock. */
  wait: { start: number; end: number } | null;
  /**
   * When the body itself was arriving, on the performance clock. Narrower than
   * `window`, and the honest answer to "was the link busy?".
   */
  body: { start: number; end: number } | null;
  /** Why the entry was skipped, for the debug panel. */
  skipped: string | null;
}

/** Below this, timer resolution and header overhead swamp the measurement. */
const MIN_WINDOW_MS = 2;

interface ParseOptions {
  /**
   * The fastest first byte ever observed, in milliseconds after a request went
   * out. Not the round trip, which is smaller.
   *
   * It decides where a transfer's clock starts. See `parseTimingEntry`.
   */
  firstByteFloorMilliseconds?: number | null;
}

/**
 * Read one resource timing entry.
 *
 * Two things routinely make an entry useless: a cache hit (no bytes crossed the
 * network, `transferSize` is 0) and a cross-origin response without a
 * `Timing-Allow-Origin` header (the browser zeroes every detailed timestamp).
 * Both are common, so they are detected rather than allowed to poison the data.
 *
 * The transfer's clock starts no later than the fastest first byte this page has
 * ever seen, rather than always at `responseStart`. The two are the same thing
 * on an ordinary transfer, whose first byte turns up as promptly as any other.
 *
 * They come apart when something between the browser and the server holds a
 * whole response and releases it in one go — which is what DevTools network
 * throttling does, and what some proxies and shapers do. The time the bytes
 * really spent on the wire then sits inside the wait, leaving a body window of
 * a few milliseconds that reads as gigabit on a throttled link. A response that
 * took far longer to start than every other response was not waiting on the
 * server; it was waiting on the link, and it is charged for it.
 *
 * The floor is the fastest observed first byte rather than the round trip,
 * which is smaller. A server's own thinking time is present in every response
 * it sends, so it belongs in the floor instead of being charged to the link.
 */
function parseTimingEntry(entry: TimingEntryLike, options: ParseOptions = {}): ParsedEntry {
  const transferSize = entry.transferSize ?? 0;
  const responseStart = entry.responseStart ?? 0;
  const responseEnd = entry.responseEnd ?? 0;
  const requestStart = entry.requestStart ?? 0;

  if (entry.deliveryType === "cache") {
    return { window: null, latency: null, wait: null, body: null, skipped: "cache-hit" };
  }
  if (transferSize <= 0) {
    // Either served from cache, or opaque to us for lack of Timing-Allow-Origin.
    return { window: null, latency: null, wait: null, body: null, skipped: "no-transfer-size" };
  }
  if (requestStart <= 0 || responseStart <= 0 || responseEnd <= 0) {
    return { window: null, latency: null, wait: null, body: null, skipped: "opaque-timings" };
  }

  const dns =
    entry.domainLookupEnd && entry.domainLookupStart && entry.domainLookupEnd > entry.domainLookupStart
      ? entry.domainLookupEnd - entry.domainLookupStart
      : null;
  const handshake =
    entry.connectEnd && entry.connectStart && entry.connectEnd > entry.connectStart
      ? entry.connectEnd - entry.connectStart
      : null;

  const wait = { start: requestStart, end: responseStart };
  const body = { start: responseStart, end: responseEnd };
  const latency: Omit<LatencySample, "at" | "contended"> = {
    timeToFirstByteMilliseconds: Math.max(0, responseStart - requestStart),
    handshakeMilliseconds: handshake,
    domainLookupMilliseconds: dns,
    source: entry.entryType === "navigation" ? "navigation" : "resource",
  };

  // Where the transfer's clock starts. With nothing to compare against yet,
  // the body window stands.
  const floor = options.firstByteFloorMilliseconds;
  const start =
    floor === null || floor === undefined || !Number.isFinite(floor)
      ? responseStart
      : Math.min(responseStart, requestStart + Math.max(0, floor));

  const durationMilliseconds = responseEnd - start;
  if (durationMilliseconds < MIN_WINDOW_MS) {
    return { window: null, latency, wait, body, skipped: "window-too-short" };
  }

  return {
    // A measurable handshake means this transfer opened its own connection and
    // therefore started from a cold congestion window.
    window: {
      start,
      end: responseEnd,
      bytes: transferSize,
      fresh: handshake !== null && handshake > 0,
    },
    latency,
    wait,
    body,
    skipped: null,
  };
}

interface BurstOptions {
  /** Windows separated by less than this are treated as one burst. */
  gapMilliseconds: number;
  /** Stop buffering beyond this many windows. */
  maximumPending: number;
}

/**
 * Buffers download windows and reports the bursts they form.
 *
 * The buffer is deliberately not consumed as it is read. A browser only reports
 * a transfer once it has *finished*, so a 12-second download arrives long after
 * the short ones it was running alongside — and it belongs in the same burst as
 * all of them. Recomputing the grouping from everything still buffered is what
 * keeps six parallel images from each looking like a slow, lonely transfer.
 */
class BurstAggregator {
  private windows: TransferWindow[] = [];

  constructor(private readonly options: BurstOptions) {}

  add(window: TransferWindow): void {
    this.windows.push(window);
    if (this.windows.length > this.options.maximumPending) {
      this.windows.splice(0, this.windows.length - this.options.maximumPending);
    }
  }

  get pendingCount(): number {
    return this.windows.length;
  }

  /** Every burst that can no longer grow, recomputed from the whole buffer. */
  closed(nowPerf: number): MergedWindow[] {
    if (this.windows.length === 0) return [];
    const cutoff = nowPerf - this.options.gapMilliseconds;
    return mergeWindows(this.windows, this.options.gapMilliseconds).filter((burst) => burst.end <= cutoff);
  }

  /** Bursts still open, which may yet be joined by a transfer not reported. */
  open(nowPerf: number): MergedWindow[] {
    if (this.windows.length === 0) return [];
    const cutoff = nowPerf - this.options.gapMilliseconds;
    return mergeWindows(this.windows, this.options.gapMilliseconds).filter((burst) => burst.end > cutoff);
  }

  /**
   * Drop the windows of bursts that ended before `horizon`. Their measurements
   * are settled: nothing still in flight can reach back that far.
   */
  prune(horizon: number): MergedWindow[] {
    if (this.windows.length === 0) return [];
    const merged = mergeWindows(this.windows, this.options.gapMilliseconds);
    const settled = merged.filter((burst) => burst.end < horizon);
    if (settled.length === 0) return [];
    const keep = new Set<TransferWindow>();
    for (const burst of merged) {
      if (burst.end >= horizon) for (const window of burst.members) keep.add(window);
    }
    this.windows = this.windows.filter((window) => keep.has(window));
    return settled;
  }

  clear(): MergedWindow[] {
    const merged = mergeWindows(this.windows, this.options.gapMilliseconds);
    this.windows = [];
    return merged;
  }
}

/** Convert a burst into a throughput sample on the epoch clock. */
function burstToSample(
  burst: MergedWindow,
  timeOrigin: number,
  /** Label for a burst made of a single transfer. */
  source: SampleSource = "resource",
): ThroughputSample | null {
  const durationMilliseconds = burst.end - burst.start;
  if (!(durationMilliseconds >= MIN_WINDOW_MS) || !(burst.bytes > 0)) return null;
  const bitsPerSecond = (burst.bytes * 8 * 1000) / durationMilliseconds;
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  return {
    bytes: burst.bytes,
    durationMilliseconds,
    bitsPerSecond,
    concurrency: burst.concurrency,
    resources: burst.count,
    freshFraction: burst.bytes > 0 ? burst.freshBytes / burst.bytes : 0,
    at: timeOrigin + burst.end,
    source: burst.count > 1 ? "burst" : source,
  };
}

/**
 * Byte length of a request body, without copying it.
 *
 * Only sizes are ever inspected — never contents — and anything whose size
 * cannot be known up front (FormData, a streaming body) returns null so it is
 * skipped rather than guessed at.
 */
function measureBodySize(body: unknown): number | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return utf8Length(body);
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body as ArrayBufferView)) return (body as ArrayBufferView).byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return utf8Length(body.toString());
  }
  return null;
}

/** UTF-8 byte count without allocating an encoder or a copy of the string. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // Surrogate pair: consume both halves as one 4-byte sequence.
      i++;
    } else bytes += 3;
  }
  return bytes;
}

interface UploadHost {
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

interface UploadInstrumentationOptions {
  /** Called for every usable upload observation. */
  onSample: (sample: ThroughputSample) => void;
  /** Current round-trip estimate, subtracted from fetch-derived timings. */
  getRoundTripMilliseconds?: () => number | null;
  now?: () => number;
  epochNow?: () => number;
  /** Bodies smaller than this are not worth timing. Default 4096. */
  minimumBytes?: number;
}

/**
 * Time request bodies as the page sends them.
 *
 * XMLHttpRequest is the good case: its upload object fires real progress
 * events, so the duration measured is genuinely the body going out. fetch has
 * no upload progress, so its samples cover "request sent to response headers
 * received" with the round trip subtracted — noisier, and weighted as such by
 * the size gate in the estimator.
 *
 * Uninstalling turns the wrappers into pass-throughs and puts the originals
 * back only if nothing has wrapped on top of them since. Restoring blindly
 * would throw away whatever wrapped later (another instance, an error
 * tracker), or, once that later wrapper restores in turn, reinstall a patch
 * belonging to an instance that has stopped.
 */
function installUploadInstrumentation(
  host: UploadHost,
  options: UploadInstrumentationOptions,
): () => void {
  const now = options.now ?? (() => performance.now());
  const epochNow = options.epochNow ?? (() => Date.now());
  const minimumBytes = options.minimumBytes ?? 4096;
  const undo: (() => void)[] = [];
  let active = true;

  const emit = (bytes: number, durationMilliseconds: number, source: ThroughputSample["source"]): void => {
    if (bytes < minimumBytes || !(durationMilliseconds > 1)) return;
    const bitsPerSecond = (bytes * 8 * 1000) / durationMilliseconds;
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return;
    // Nothing here says whether the connection was new, so freshFraction stays
    // 0 and the slow-start correction leaves upload samples alone.
    options.onSample({
      bytes,
      durationMilliseconds,
      bitsPerSecond,
      concurrency: 1,
      resources: 1,
      freshFraction: 0,
      at: epochNow(),
      source,
    });
  };

  if (typeof host.XMLHttpRequest === "function") {
    const Original = host.XMLHttpRequest;
    const originalSend = Original.prototype.send;

    Original.prototype.send = function patchedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const bytes = active ? measureBodySize(body) : null;
      if (bytes !== null && bytes >= minimumBytes && this.upload) {
        let started = now();
        const onStart = (): void => {
          started = now();
        };
        const onDone = (event: ProgressEvent): void => {
          const sent = event.lengthComputable && event.loaded > 0 ? event.loaded : bytes;
          emit(sent, now() - started, "xhr-upload");
          cleanup();
        };
        const onFail = (): void => cleanup();
        const cleanup = (): void => {
          this.upload.removeEventListener("loadstart", onStart);
          this.upload.removeEventListener("load", onDone);
          this.upload.removeEventListener("error", onFail);
          this.upload.removeEventListener("abort", onFail);
        };
        this.upload.addEventListener("loadstart", onStart);
        this.upload.addEventListener("load", onDone);
        this.upload.addEventListener("error", onFail);
        this.upload.addEventListener("abort", onFail);
      }
      return originalSend.call(this, body ?? null);
    };

    const patchedSend = Original.prototype.send;
    undo.push(() => {
      if (Original.prototype.send === patchedSend) Original.prototype.send = originalSend;
    });
  }

  if (typeof host.fetch === "function") {
    const originalFetch = host.fetch;

    host.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const bytes = active ? measureBodySize(init?.body) : null;
      if (bytes === null || bytes < minimumBytes) {
        return originalFetch.call(host as unknown as typeof globalThis, input, init);
      }
      const started = now();
      return originalFetch.call(host as unknown as typeof globalThis, input, init).then(
        (response) => {
          // Headers are back, so the body is certainly out. Take off one round
          // trip; whatever the server spent thinking stays in and makes this a
          // conservative (low) upload figure.
          const rtt = options.getRoundTripMilliseconds?.() ?? 0;
          emit(bytes, now() - started - (rtt ?? 0), "fetch-upload");
          return response;
        },
        (error: unknown) => {
          throw error;
        },
      );
    } as typeof fetch;

    const patchedFetch = host.fetch;
    undo.push(() => {
      if (host.fetch === patchedFetch) host.fetch = originalFetch;
    });
  }

  return () => {
    active = false;
    for (const restore of undo.reverse()) restore();
  };
}

interface EstimatorConfig {
  minimumSampleBytes: number;
  quantile: number;
  halfLifeMilliseconds: number;
  /** Round trip used to undo slow start; null disables the correction. */
  roundTripMilliseconds?: number | null;
  /** How much of the computed ramp to remove, 0..1. */
  slowStartCorrection?: number;
}

/** RFC 6928 initial congestion window: ten full-size segments. */
const INITIAL_WINDOW_BYTES = 10 * 1460;

/**
 * A transfer this many times the size gate - a megabyte at the default gate -
 * is comfortably larger than the burst allowance a shaper hands out, so its
 * rate is close to sustained capacity rather than to the burst.
 */
const LARGE_SAMPLE_MULTIPLE = 32;

/**
 * Remove the slow-start ramp from a transfer's duration.
 *
 * A connection does not start at full speed: its window doubles every round
 * trip until it saturates the link. Integrating that ramp shows the lost time
 * is a constant for a given link, `rtt * (log2(rtt * rate / IW) - log2 e)`, so
 * it can be subtracted to recover what the link would have done at full tilt.
 * Short transfers that never escaped the initial window are left alone, and the
 * correction is capped at half the observed duration so it can never run away.
 */
function correctSlowStart(
  bytes: number,
  durationMilliseconds: number,
  concurrency: number,
  roundTripMilliseconds: number | null | undefined,
  strength = 1,
): number {
  if (!roundTripMilliseconds || !(roundTripMilliseconds > 0) || strength <= 0 || !(durationMilliseconds > 0)) return durationMilliseconds;

  // Parallel connections each get their own initial window, so a burst of six
  // ramps roughly six times as fast as a lone request.
  const initialWindow = INITIAL_WINDOW_BYTES * Math.max(1, Math.round(concurrency));
  let corrected = durationMilliseconds;

  for (let i = 0; i < 3; i++) {
    const bytesPerMs = bytes / corrected;
    const windowBytes = bytesPerMs * roundTripMilliseconds;
    if (windowBytes <= initialWindow) return durationMilliseconds; // Never left the initial window.
    const rounds = Math.log2(windowBytes / initialWindow) - Math.LOG2E;
    if (!(rounds > 0)) return durationMilliseconds;
    corrected = durationMilliseconds - Math.min(rounds * roundTripMilliseconds * strength, durationMilliseconds * 0.5);
  }
  return corrected;
}

const EMPTY_CONFIDENCE: Confidence = { score: 0, samples: 0, bytes: 0, spread: 1 };

const EMPTY_DIRECTION: DirectionEstimate = {
  bitsPerSecond: null,
  megabitsPerSecond: null,
  resources: 0,
  confidence: EMPTY_CONFIDENCE,
  peakBitsPerSecond: null,
  averageBitsPerSecond: null,
  regressionBitsPerSecond: null,
};

const EMPTY_LATENCY: LatencyEstimate = {
  roundTripMilliseconds: null,
  timeToFirstByteMilliseconds: null,
  jitterMilliseconds: null,
  resources: 0,
  confidence: EMPTY_CONFIDENCE,
};

/**
 * A transfer's weight grows with its size but only logarithmically: a 4 MB
 * video segment is a much better probe than a 32 KB icon, but it is not 128
 * times better, and letting one huge file own the estimate makes it brittle.
 */
function sizeWeight(bytes: number, minimumSampleBytes: number): number {
  return Math.log2(1 + bytes / Math.max(1, minimumSampleBytes));
}

function scoreConfidence(
  samples: readonly ThroughputSample[],
  values: readonly number[],
  gatePenalty: number,
): Confidence {
  if (samples.length === 0) return EMPTY_CONFIDENCE;

  const bytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  const middle = median(values);
  const deviation = meanAbsoluteDeviation(values);
  const spread = middle && middle > 0 && deviation !== null ? clamp(deviation / middle, 0, 1) : 1;

  const sampleScore = 1 - Math.exp(-samples.length / 6);
  const byteScore = clamp(Math.log10(1 + bytes / 1e5) / 1.5, 0, 1);
  const agreement = 1 - spread;

  const score = clamp(
    (sampleScore * 0.35 + byteScore * 0.4 + agreement * 0.25) * gatePenalty,
    0,
    1,
  );
  return { score, samples: samples.length, bytes, spread };
}

/**
 * Turn raw transfer observations into a capacity estimate.
 *
 * Every passive sample is a *lower* bound on the link: a transfer can be slowed
 * by slow start, a busy server or a page that simply stopped asking for bytes,
 * but nothing makes it look faster than the link. So the estimate reaches for
 * the top of the observed distribution rather than its middle, and cross-checks
 * that against a regression that models per-request overhead explicitly.
 */
function estimateDirection(
  allSamples: readonly ThroughputSample[],
  config: EstimatorConfig,
  now: number,
): DirectionEstimate {
  if (allSamples.length === 0) return EMPTY_DIRECTION;

  const gated = allSamples.filter((s) => s.bytes >= config.minimumSampleBytes);
  const usable = gated.length > 0 ? gated : allSamples;
  // Samples below the size gate are latency-dominated, and the figure they
  // produce is a floor rather than a measurement: ten 304 revalidations are ten
  // consistent, numerous samples totalling three kilobytes, which the sample
  // count and agreement terms would otherwise reward. When nothing at all
  // cleared the gate the penalty has to be heavy enough to keep the score
  // low, because that is the honest answer.
  const gatePenalty = gated.length > 0 ? 1 : 0.25;

  const weighted: Weighted[] = [];
  const points: { x: number; y: number; weight: number }[] = [];
  const values: number[] = [];
  let peak = 0;
  let resources = 0;
  // Fastest rate seen over a transfer too large to ride a burst allowance.
  let sustainedCeiling = 0;
  const largeBytes = config.minimumSampleBytes * LARGE_SAMPLE_MULTIPLE;

  for (const sample of usable) {
    const age = Math.max(0, now - sample.at);
    const weight = decayWeight(age, config.halfLifeMilliseconds) * sizeWeight(sample.bytes, config.minimumSampleBytes);
    if (!(weight > 0) || !(sample.bitsPerSecond > 0)) continue;

    const durationMilliseconds = correctSlowStart(
      sample.bytes,
      sample.durationMilliseconds,
      sample.concurrency,
      config.roundTripMilliseconds,
      // Bytes on a reused connection never paid the ramp, so correcting them
      // would invent speed that was not there.
      (config.slowStartCorrection ?? 1) * clamp(sample.freshFraction ?? 0, 0, 1),
    );
    const bitsPerSecond = (sample.bytes * 8 * 1000) / durationMilliseconds;

    weighted.push({ value: bitsPerSecond, weight });
    resources += sample.resources;
    // Only lone transfers obey `duration = overhead + bytes / rate`. When six
    // requests share the link, each one's duration says more about how the
    // capacity was divided than about the capacity itself.
    if (sample.concurrency <= 1.5) {
      points.push({ x: sample.bytes, y: durationMilliseconds, weight });
    }
    values.push(bitsPerSecond);
    if (bitsPerSecond > peak) peak = bitsPerSecond;
    if (sample.bytes >= largeBytes && bitsPerSecond > sustainedCeiling) sustainedCeiling = bitsPerSecond;
  }
  if (weighted.length === 0) return EMPTY_DIRECTION;

  const quantileBps = weightedQuantile(weighted, config.quantile);

  // Regression across differently sized transfers separates fixed per-request
  // overhead from the marginal cost of a byte; the marginal cost is the link.
  let regressionBitsPerSecond: number | null = null;
  const xs = points.map((p) => p.x);
  const spreadOk = xs.length > 0 && Math.max(...xs) / Math.min(...xs) >= 2;
  const fit = spreadOk ? linearRegression(points) : null;
  if (fit && fit.slope > 0 && fit.r2 >= 0.75 && fit.n >= 4) {
    const candidate = 8000 / fit.slope;
    // Only believe the fit if it lands in the same neighbourhood as the samples.
    // A fit that lands wildly away from everything observed is noise, not
    // insight. The window is wide because removing per-request overhead
    // legitimately lifts the figure above every individual sample.
    if (quantileBps && candidate > quantileBps * 0.4 && candidate <= peak * 4) {
      regressionBitsPerSecond = candidate;
    }
  }

  let bitsPerSecond = quantileBps;
  if (bitsPerSecond !== null && regressionBitsPerSecond !== null && fit) {
    const trust = clamp((fit.r2 - 0.75) / 0.25, 0, 1) * 0.6;
    bitsPerSecond = bitsPerSecond * (1 - trust) + regressionBitsPerSecond * trust;
  }
  if (bitsPerSecond === null) return EMPTY_DIRECTION;

  // Links hand out a burst allowance: a few hundred kilobytes at line rate
  // before any shaping engages. Small transfers ride it and look far faster
  // than the link can sustain, and both the quantile and a regression fitted
  // only to small transfers would happily report that burst as the speed.
  //
  // A transfer large enough to outrun the allowance cannot be flattered that
  // way, and being large it is also the one least distorted by per-request
  // overhead. So when such a transfer exists, the fastest of them is the
  // ceiling. It is a maximum over real observations, so it never drags the
  // figure below what the link was actually seen doing; when no transfer was
  // that large, there is nothing to anchor against and the estimate stands.
  if (sustainedCeiling > 0 && bitsPerSecond > sustainedCeiling) bitsPerSecond = sustainedCeiling;

  const averageBitsPerSecond = weightedMean(weighted);

  return {
    bitsPerSecond,
    megabitsPerSecond: bitsPerSecond / 1e6,
    resources,
    confidence: scoreConfidence(usable, values, gatePenalty),
    peakBitsPerSecond: peak > 0 ? peak : null,
    averageBitsPerSecond: averageBitsPerSecond !== null && averageBitsPerSecond > 0 ? averageBitsPerSecond : null,
    regressionBitsPerSecond,
  };
}

/**
 * Drop the extreme tenth at each end before measuring spread.
 *
 * A page that queues a request behind a big download sees a time to first byte
 * of seconds, which says nothing about the network's stability. Trimming keeps
 * jitter a measure of the link rather than of the server's busiest moment.
 */
function trimmed(values: readonly number[], fraction = 0.1): number[] {
  if (values.length < 5) return [...values];
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * fraction);
  return sorted.slice(cut, sorted.length - cut);
}

/**
 * Latency from ordinary page loads. Time to first byte mixes network round trip
 * with however long the server thought about the request, so the round-trip
 * figure is min-filtered (the fastest response had the least thinking) while
 * jitter comes from the trimmed spread of the rest.
 */
function estimateLatency(
  samples: readonly LatencySample[],
  config: EstimatorConfig,
  now: number,
): LatencyEstimate {
  const usable = samples.filter((s) => Number.isFinite(s.timeToFirstByteMilliseconds) && s.timeToFirstByteMilliseconds >= 0);
  if (usable.length === 0) return EMPTY_LATENCY;

  // A request that waited while the page was already pulling bytes tells us
  // about queuing, not about the link, so the median and the jitter are taken
  // from the quiet moments when there are enough of them. The round trip is a
  // minimum, and queuing can only ever inflate a sample, so that one keeps
  // looking at everything.
  const quiet = usable.filter((s) => !s.contended);
  const fresh = quiet.length >= 3 ? quiet : usable;
  const contentionPenalty = quiet.length >= 3 ? 1 : 0.7;

  const ttfbValues = fresh.map((s) => s.timeToFirstByteMilliseconds);
  const handshakes = usable
    .map((s) => s.handshakeMilliseconds)
    .filter((value): value is number => value !== null && value > 0);

  // A fresh TCP+TLS handshake is roughly two round trips, so it is a cleaner
  // RTT probe than TTFB when the page happened to open a new connection.
  const fromHandshake = handshakes.length > 0 ? Math.min(...handshakes) / 2 : null;
  const fromTtfb = Math.min(...usable.map((s) => s.timeToFirstByteMilliseconds));
  const roundTripMilliseconds = fromHandshake !== null ? Math.min(fromHandshake, fromTtfb) : fromTtfb;

  const weighted: Weighted[] = fresh.map((sample) => ({
    value: sample.timeToFirstByteMilliseconds,
    weight: decayWeight(Math.max(0, now - sample.at), config.halfLifeMilliseconds),
  }));

  const middle = weightedQuantile(weighted, 0.5);
  const jitter = meanAbsoluteDeviation(trimmed(ttfbValues));
  const spread = middle && middle > 0 && jitter !== null ? clamp(jitter / middle, 0, 1) : 1;
  const sampleScore = 1 - Math.exp(-fresh.length / 8);

  return {
    roundTripMilliseconds,
    timeToFirstByteMilliseconds: middle,
    jitterMilliseconds: jitter,
    resources: usable.length,
    confidence: {
      score: clamp((sampleScore * 0.6 + (1 - spread) * 0.4) * contentionPenalty, 0, 1),
      samples: fresh.length,
      bytes: 0,
      spread,
    },
  };
}

const DEFAULTS = {
  storageKey: "freeloader",
  persist: true,
  maximumAgeMilliseconds: 7 * 24 * 60 * 60 * 1000,
  halfLifeMilliseconds: 24 * 60 * 60 * 1000,
  minimumSampleBytes: 32 * 1024,
  quantile: 0.9,
  maximumSamples: 100,
  maximumLatencySamples: 100,
  mergeBursts: true,
  burstGapMilliseconds: 30,
  instrumentUploads: true,
  slowStartCorrection: 1,
} as const;

/**
 * How long a burst stays open to revision. A transfer is reported only when it
 * ends, so one that started minutes ago can still turn out to belong with
 * bursts already measured; after this long, nothing plausibly can.
 */
const SETTLE_MS = 60_000;

type ResolvedOptions = Required<
  Omit<FreeloaderOptions, "origins" | "onUpdate" | "now" | "timeOrigin">
> &
  Pick<FreeloaderOptions, "origins" | "onUpdate" | "now" | "timeOrigin">;

export interface FreeloaderDebug {
  running: boolean;
  pendingWindows: number;
  /** Download samples that are settled and persisted. */
  downloadSamples: number;
  /** Download samples from bursts still open to revision. */
  liveDownloadSamples: number;
  uploadSamples: number;
  latencySamples: number;
  /** How many latency samples were taken while the page was busy downloading. */
  contendedLatency: number;
  totals: { downloadBytes: number; uploadBytes: number; samples: number };
  /** Count of entries ignored, keyed by reason. */
  skipped: Record<string, number>;
  /** The most recent download samples, oldest first. */
  lastSamples: ThroughputSample[];
  /** The most recent upload samples, oldest first. */
  lastUploadSamples: ThroughputSample[];
}

/**
 * Passive network measurement.
 *
 * Freeloader never issues a request of its own. It watches the traffic the page
 * was going to make anyway - images, scripts, video segments, API calls - and
 * infers throughput, round trip and jitter from how those transfers behaved.
 * The estimate is therefore free, but it is also a lower bound: the link is at
 * least this fast, and the figure sharpens the more the user browses.
 */
export class Freeloader {
  private readonly options: ResolvedOptions;
  private readonly storage: StorageLike | null;
  private readonly aggregator: BurstAggregator;
  private readonly listeners = new Set<(estimate: NetworkEstimate) => void>();
  private readonly skipped: Record<string, number> = {};

  /** Latency observations awaiting a contention verdict. */
  private pendingLatency: { sample: Omit<LatencySample, "contended">; start: number; end: number }[] = [];
  /** Recent body windows, used to decide whether a request had the link to itself. */
  private recentWindows: { start: number; end: number }[] = [];
  /**
   * Latency samples from this page view, with the wait window each one came
   * from, so a transfer reported later can still be recognised as having
   * competed with them.
   */
  private latencyWaits: { sample: LatencySample; start: number; end: number }[] = [];

  /**
   * Samples whose bursts are still open to revision. They count toward the
   * estimate but are not settled, and are recomputed on every flush.
   */
  private liveSamples: ThroughputSample[] = [];

  private state: PersistedState;
  private estimate: NetworkEstimate;
  private observer: PerformanceObserver | null = null;
  private uninstallUploads: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * Entries the observer has delivered, kept across stop/start. Deliberately
   * not cleared by `reset()`: forgetting the page's old traffic means not
   * counting it again either.
   */
  private observed = new Set<string>();

  constructor(options: FreeloaderOptions = {}, storage?: StorageLike | null) {
    this.options = { ...DEFAULTS, ...options };
    this.storage = storage !== undefined ? storage : this.options.persist ? defaultStorage() : null;

    const now = this.now();
    this.state = loadState(this.storage, this.options.storageKey, this.options.maximumAgeMilliseconds, now);
    this.aggregator = new BurstAggregator({
      gapMilliseconds: this.options.mergeBursts ? this.options.burstGapMilliseconds : -1,
      maximumPending: 256,
    });
    this.estimate = this.recompute(now);
  }

  /** Construct and start in one call. */
  static start(options: FreeloaderOptions = {}): Freeloader {
    const freeloader = new Freeloader(options);
    freeloader.start();
    return freeloader;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin observing. Safe to call twice; the second call does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (typeof PerformanceObserver === "function") {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // A restart replays the whole buffer, so skip what was already seen.
            const key = `${entry.entryType} ${entry.name} ${entry.startTime}`;
            if (this.observed.has(key)) continue;
            this.observed.add(key);
            this.ingest(entry as unknown as TimingEntryLike);
          }
          this.scheduleFlush();
        });
        // `buffered` replays everything that loaded before this script ran,
        // which is exactly the page's heaviest and most informative moment.
        this.observer.observe({ type: "resource", buffered: true });
        this.observer.observe({ type: "navigation", buffered: true });
      } catch {
        this.observer = null;
      }
    }

    if (this.options.instrumentUploads) {
      this.uninstallUploads = installUploadInstrumentation(globalThis as never, {
        onSample: (sample) => this.addUploadSample(sample),
        getRoundTripMilliseconds: () => this.estimate.latency.roundTripMilliseconds,
        minimumBytes: 4096,
      });
    }
  }

  /** Stop observing, un-patch fetch/XHR, and write the final state out. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.flush();
    this.settleAll();
    this.persist();

    this.observer?.disconnect();
    this.observer = null;
    this.uninstallUploads?.();
    this.uninstallUploads = null;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }  }

  /** Current estimate. Cheap: it is recomputed on change, not on read. */
  getEstimate(): NetworkEstimate {
    return this.estimate;
  }

  /** Subscribe to estimate changes. Returns an unsubscribe function. */
  subscribe(listener: (estimate: NetworkEstimate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Throw away everything learned so far, including the stored copy. */
  reset(): void {
    const now = this.now();
    this.state = emptyState(now);
    this.liveSamples = [];
    this.aggregator.clear();
    this.latencyWaits = [];
    clearState(this.storage, this.options.storageKey);
    this.publish(now);
  }

  debug(): FreeloaderDebug {
    return {
      running: this.running,
      pendingWindows: this.aggregator.pendingCount,
      downloadSamples: this.state.download.length,
      liveDownloadSamples: this.liveSamples.length,
      uploadSamples: this.state.upload.length,
      latencySamples: this.state.latency.length,
      contendedLatency: this.state.latency.filter((sample) => sample.contended).length,
      totals: { ...this.state.totals },
      skipped: { ...this.skipped },
      lastSamples: [...this.state.download, ...this.liveSamples].slice(-8),
      lastUploadSamples: this.state.upload.slice(-8),
    };
  }

  /**
   * The fastest first byte seen so far: how promptly requests are answered when
   * there is nothing to wait for.
   *
   * Deliberately not the round trip, which is smaller. A server's own thinking
   * time is present in every response it sends, so counting it here keeps it
   * from being charged to the link. Read from the samples rather than from the
   * published estimate, which only moves on a flush — the first entries of a
   * page would otherwise be parsed before anything was known. It is a minimum,
   * so a slow request cannot raise it, and stored samples carry it in from
   * previous page views.
   */
  private firstByteFloorMilliseconds(): number | null {
    let floor: number | null = null;
    const consider = (value: number) => {
      if (Number.isFinite(value) && value >= 0 && (floor === null || value < floor)) floor = value;
    };
    for (const sample of this.state.latency) consider(sample.timeToFirstByteMilliseconds);
    for (const pending of this.pendingLatency) consider(pending.sample.timeToFirstByteMilliseconds);
    return floor;
  }

  /**
   * Feed one performance entry in by hand. The observer calls this, and so do
   * the tests; it is also the escape hatch for apps that buffer entries
   * themselves.
   */
  ingest(entry: TimingEntryLike): void {
    if (!this.matchesOrigin(entry.name)) {
      this.skipped["foreign-origin"] = (this.skipped["foreign-origin"] ?? 0) + 1;
      return;
    }
    // The round trip decides where a transfer's clock starts; see
    // `parseTimingEntry`.
    const parsed = parseTimingEntry(entry, { firstByteFloorMilliseconds: this.firstByteFloorMilliseconds() });
    if (parsed.skipped) {
      this.skipped[parsed.skipped] = (this.skipped[parsed.skipped] ?? 0) + 1;
    }
    if (parsed.latency && parsed.wait) {
      this.pendingLatency.push({
        sample: { ...parsed.latency, at: this.epochFromPerf(entry.responseEnd ?? entry.startTime) },
        start: parsed.wait.start,
        end: parsed.wait.end,
      });
      if (this.pendingLatency.length > 256) this.pendingLatency.shift();
    }
    if (parsed.window) {
      this.aggregator.add(parsed.window);
      // Contention asks whether the link was carrying bytes, so it reads the
      // body window rather than the widened measurement window.
      const window = parsed.body ?? { start: parsed.window.start, end: parsed.window.end };
      this.recentWindows.push(window);
      if (this.recentWindows.length > 256) this.recentWindows.shift();
      // A transfer is only reported once it finishes, so it may well arrive
      // after the requests it was competing with. Contention only ever becomes
      // true, so applying it backwards is safe and converges.
      this.markContention(window);
      this.state.totals.downloadBytes += parsed.window.bytes;
    }
  }

  /**
   * Close out any bursts that can no longer grow and fold them in.
   *
   * `nowPerf` defaults to the real performance clock; passing it explicitly
   * lets tests drive a simulated clock.
   */
  flush(nowPerf?: number): void {
    const now = (nowPerf ?? this.perfNow()) + 1;
    let changed = this.resolveLatency() > 0;

    // Settle the bursts that are old enough to be beyond revision, moving their
    // samples into the persisted set.
    for (const burst of this.aggregator.prune(now - SETTLE_MS)) {
      const sample = burstToSample(burst, this.timeOrigin());
      if (!sample) continue;
      this.addSample(this.state.download, sample);
      changed = true;
    }

    // Recompute everything still buffered. A transfer reported just now may
    // belong to a burst that was already measured, in which case that
    // measurement is replaced rather than duplicated.
    const live: ThroughputSample[] = [];
    for (const burst of this.aggregator.closed(now)) {
      const sample = burstToSample(burst, this.timeOrigin());
      if (sample) live.push(sample);
    }
    if (live.length !== this.liveSamples.length || changed) changed = true;
    else changed = live.some((sample, i) => sample.bitsPerSecond !== (this.liveSamples[i] as ThroughputSample).bitsPerSecond);
    this.liveSamples = live;

    if (changed) this.publish(this.now());
  }

  /**
   * Settle every open burst. Called by `stop()`, so that what was learned is
   * saved rather than lost mid-burst.
   */
  private settleAll(): void {
    for (const burst of this.aggregator.clear()) {
      const sample = burstToSample(burst, this.timeOrigin());
      if (sample) this.addSample(this.state.download, sample);
    }
    this.liveSamples = [];
  }

  /**
   * Decide, now that the surrounding transfers are known, which requests were
   * waiting on a quiet link and which were queued behind the page's own bytes.
   */
  private resolveLatency(): number {
    if (this.pendingLatency.length === 0) return 0;
    const pending = this.pendingLatency;
    this.pendingLatency = [];

    for (const item of pending) {
      // A transfer's own body window starts exactly where its wait ends, so it
      // never counts as competing with itself.
      const contended = this.recentWindows.some((window) => this.overlaps(window, item));
      const sample: LatencySample = { ...item.sample, contended };
      this.addLatencySample(sample);
      this.latencyWaits.push({ sample, start: item.start, end: item.end });
    }
    if (this.latencyWaits.length > this.options.maximumLatencySamples) {
      this.latencyWaits.splice(0, this.latencyWaits.length - this.options.maximumLatencySamples);
    }
    return pending.length;
  }

  private overlaps(window: { start: number; end: number }, wait: { start: number; end: number }): boolean {
    return window.start < wait.end && window.end > wait.start;
  }

  /** Flag any already-recorded latency sample this transfer was competing with. */
  private markContention(window: { start: number; end: number }): void {
    for (const item of this.latencyWaits) {
      if (!item.sample.contended && this.overlaps(window, item)) item.sample.contended = true;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const delay = Math.max(20, this.options.burstGapMilliseconds * 2);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
    // Never hold a Node process (or a test runner) open just for this.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private addUploadSample(sample: ThroughputSample): void {
    this.state.totals.uploadBytes += sample.bytes;
    this.addSample(this.state.upload, sample);
    this.publish(this.now());
  }

  private addLatencySample(sample: LatencySample): void {
    this.state.latency.push(sample);
    if (this.state.latency.length > this.options.maximumLatencySamples) {
      this.state.latency.splice(0, this.state.latency.length - this.options.maximumLatencySamples);
    }
    this.state.totals.samples += 1;
  }

  private addSample(list: ThroughputSample[], sample: ThroughputSample): void {
    list.push(sample);
    this.state.totals.samples += 1;
    const overflow = list.length - this.options.maximumSamples;
    if (overflow > 0) {
      // Drop the oldest, but keep the fastest of the departing group: the best
      // sample seen is the closest thing we have to the link's real ceiling.
      const departing = list.splice(0, overflow + 1);
      let best = departing[0] as ThroughputSample;
      for (const candidate of departing) if (candidate.bitsPerSecond > best.bitsPerSecond) best = candidate;
      list.unshift(best);
    }
  }

  private matchesOrigin(url: string): boolean {
    const allowed = this.options.origins;
    if (!allowed || allowed.length === 0) return true;
    try {
      const base = globalThis.location?.href ?? "http://localhost";
      return allowed.includes(new URL(url, base).origin);
    } catch {
      return false;
    }
  }

  private estimatorConfig(roundTripMilliseconds: number | null): EstimatorConfig {
    return {
      minimumSampleBytes: this.options.minimumSampleBytes,
      quantile: this.options.quantile,
      halfLifeMilliseconds: this.options.halfLifeMilliseconds,
      roundTripMilliseconds,
      slowStartCorrection: this.options.slowStartCorrection,
    };
  }

  private recompute(now: number): NetworkEstimate {
    // Latency first: the round trip is what makes the slow-start correction
    // on the throughput samples possible.
    const latencyConfig = this.estimatorConfig(null);
    const latency = this.state.latency.length
      ? estimateLatency(this.state.latency, latencyConfig, now)
      : EMPTY_LATENCY;
    const config = this.estimatorConfig(latency.roundTripMilliseconds);
    const downloadSamples =
      this.liveSamples.length > 0 ? [...this.state.download, ...this.liveSamples] : this.state.download;
    const download = downloadSamples.length
      ? estimateDirection(downloadSamples, config, now)
      : EMPTY_DIRECTION;
    const upload = this.state.upload.length
      ? estimateDirection(this.state.upload, config, now)
      : EMPTY_DIRECTION;

    return {
      download,
      upload,
      latency,
      updatedAt: now,
    };
  }

  private publish(now: number): void {
    this.state.updatedAt = now;
    this.estimate = this.recompute(now);
    this.persist();
    this.options.onUpdate?.(this.estimate);
    for (const listener of this.listeners) {
      try {
        listener(this.estimate);
      } catch {
        // A broken subscriber must not stop measurement.
      }
    }
  }

  /**
   * Persist settled and still-open samples together.
   *
   * Keeping the two apart in memory is what lets a burst be revised; on the way
   * out they are the same thing, so a page that is closed mid-burst still keeps
   * what it measured.
   */
  private persist(): void {
    if (!this.options.persist) return;
    const download =
      this.liveSamples.length > 0
        ? [...this.state.download, ...this.liveSamples].slice(-this.options.maximumSamples)
        : this.state.download;
    saveState(this.storage, this.options.storageKey, { ...this.state, download });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private perfNow(): number {
    return typeof performance !== "undefined" ? performance.now() : 0;
  }

  private timeOrigin(): number {
    if (this.options.timeOrigin !== undefined) return this.options.timeOrigin;
    if (typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)) {
      return performance.timeOrigin;
    }
    return this.now() - this.perfNow();
  }

  private epochFromPerf(value: number): number {
    return this.timeOrigin() + value;
  }
}

// Exported for the test suite only. `npm run build` removes everything from this line down.
export {
  BurstAggregator,
  burstToSample,
  clamp,
  clearState,
  correctSlowStart,
  decayWeight,
  emptyState,
  estimateDirection,
  estimateLatency,
  installUploadInstrumentation,
  linearRegression,
  loadState,
  meanAbsoluteDeviation,
  measureBodySize,
  median,
  mergeWindows,
  parseTimingEntry,
  saveState,
  utf8Length,
  weightedMean,
  weightedQuantile,
};
export type { EstimatorConfig, LatencySample, PersistedState, UploadHost };
