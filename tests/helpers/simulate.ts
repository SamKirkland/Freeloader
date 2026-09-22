import type { TimingEntryLike } from "../../src/freeloader.js";

/**
 * A deterministic network simulator.
 *
 * It exists so accuracy can be asserted against a link whose real capacity is
 * known exactly. The model covers the things that actually bias passive
 * measurement: a fixed pool of connections that the browser reuses, a
 * congestion window that ramps on each connection and then stays warm, a round
 * trip and some server think time before the first byte, and per-request jitter.
 */

export interface LinkProfile {
  /** True capacity of the link, bits per second. */
  capacityBps: number;
  /** Round trip to first byte, milliseconds. */
  roundTripMilliseconds: number;
  /** How long the server spends before the first byte, milliseconds. */
  serverThinkMs: number;
  /** Parallel connections the browser will open. */
  maxConcurrent: number;
  /** Peak +/- variation applied to each request's first byte, milliseconds. */
  jitterMilliseconds: number;
  /** Seed for the deterministic generator. */
  seed?: number;
  /** Start every connection with a window big enough to saturate the link. */
  noSlowStart?: boolean;
}

export interface ResourceSpec {
  url: string;
  /** Body bytes on the wire. */
  bytes: number;
  /** Milliseconds after the page starts before the browser wants this. */
  requestedAtMs?: number;
  initiatorType?: string;
  /** Served from the browser cache: no bytes cross the network. */
  cached?: boolean;
  /** Cross-origin without Timing-Allow-Origin: timings come back zeroed. */
  opaque?: boolean;
}

const HEADER_BYTES = 320; // Response headers also cross the wire.
const INITIAL_WINDOW_BYTES = 10 * 1460; // RFC 6928 initial congestion window.
const STEP_MS = 0.5;

/** Small deterministic PRNG so every run of the suite sees the same network. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Connection {
  /** Congestion window in bytes; survives between requests, as a real one does. */
  cwndBytes: number;
  opened: boolean;
  busy: boolean;
}

interface Transfer {
  spec: ResourceSpec;
  connection: Connection;
  wireBytes: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  remaining: number;
  connectStart: number;
  connectEnd: number;
  dnsStart: number;
  dnsEnd: number;
}

/**
 * Run one page load and return the resource timing entries a browser would
 * have produced for it. `connections` is carried between calls so a second
 * page visit reuses warm connections, just like a real session.
 */
export function simulatePageLoad(
  profile: LinkProfile,
  resources: readonly ResourceSpec[],
  startClockMs = 0,
  connections?: Connection[],
): TimingEntryLike[] {
  const random = mulberry32(profile.seed ?? 1);
  const bytesPerMs = profile.capacityBps / 8 / 1000;
  const maxCwnd = Math.max(INITIAL_WINDOW_BYTES, bytesPerMs * profile.roundTripMilliseconds * 8);
  const pool = connections ?? createConnections(profile);

  const queue = [...resources].sort((a, b) => (a.requestedAtMs ?? 0) - (b.requestedAtMs ?? 0));
  const entries: TimingEntryLike[] = [];
  const active: Transfer[] = [];
  const done: Transfer[] = [];
  let queueIndex = 0;

  let t = startClockMs;
  const deadline = startClockMs + 15 * 60 * 1000;

  while ((queueIndex < queue.length || active.length > 0) && t < deadline) {
    // Admit new requests while a connection is free.
    while (queueIndex < queue.length) {
      const spec = queue[queueIndex] as ResourceSpec;
      if (startClockMs + (spec.requestedAtMs ?? 0) > t) break;

      if (spec.cached) {
        queueIndex++;
        entries.push(cachedEntry(spec, t));
        continue;
      }
      if (spec.opaque) {
        queueIndex++;
        entries.push(opaqueEntry(spec, t, profile, random));
        continue;
      }

      const connection = pool.find((c) => !c.busy);
      if (!connection) break;
      queueIndex++;
      connection.busy = true;

      const fresh = !connection.opened;
      if (fresh) {
        connection.opened = true;
        connection.cwndBytes = profile.noSlowStart ? maxCwnd : INITIAL_WINDOW_BYTES;
      }
      const jitter = (random() * 2 - 1) * profile.jitterMilliseconds;
      const domainLookupMilliseconds = fresh && pool.filter((c) => c.opened).length === 1 ? profile.roundTripMilliseconds * 0.6 : 0;
      const handshakeMilliseconds = fresh ? profile.roundTripMilliseconds * 2 : 0;
      const requestStart = t;
      const responseStart =
        requestStart + domainLookupMilliseconds + handshakeMilliseconds + profile.roundTripMilliseconds + profile.serverThinkMs + jitter;

      active.push({
        spec,
        connection,
        wireBytes: spec.bytes + HEADER_BYTES,
        requestStart,
        responseStart,
        responseEnd: responseStart,
        remaining: spec.bytes + HEADER_BYTES,
        dnsStart: requestStart,
        dnsEnd: requestStart + domainLookupMilliseconds,
        connectStart: requestStart + domainLookupMilliseconds,
        connectEnd: requestStart + domainLookupMilliseconds + handshakeMilliseconds,
      });
    }

    // Move bytes for everything whose first byte has arrived.
    const flowing = active.filter((transfer) => t >= transfer.responseStart);
    if (flowing.length > 0) {
      // A connection can have at most one window of data in flight per round trip.
      const limits = flowing.map((transfer) => transfer.connection.cwndBytes / profile.roundTripMilliseconds);
      const rates = waterFill(bytesPerMs, limits);
      for (let i = 0; i < flowing.length; i++) {
        const transfer = flowing[i] as Transfer;
        const delivered = (rates[i] as number) * STEP_MS;
        transfer.remaining -= delivered;
        // Slow start: the window grows by one segment per segment acknowledged,
        // which doubles it every round trip until the link is the limit.
        transfer.connection.cwndBytes = Math.min(maxCwnd, transfer.connection.cwndBytes + delivered);
        if (transfer.remaining <= 0) transfer.responseEnd = t + STEP_MS;
      }
    }

    for (let i = active.length - 1; i >= 0; i--) {
      const transfer = active[i] as Transfer;
      if (transfer.remaining <= 0) {
        transfer.connection.busy = false;
        active.splice(i, 1);
        done.push(transfer);
      }
    }

    t += STEP_MS;
  }

  for (const transfer of done) entries.push(toEntry(transfer));
  entries.sort((a, b) => a.startTime - b.startTime);
  return entries;
}

export function createConnections(profile: LinkProfile): Connection[] {
  return Array.from({ length: profile.maxConcurrent }, () => ({
    cwndBytes: INITIAL_WINDOW_BYTES,
    opened: false,
    busy: false,
  }));
}

/**
 * Share capacity fairly, but hand the slack from connections that cannot use
 * their share (because their window is still small) to the ones that can.
 */
export function waterFill(capacity: number, limits: readonly number[]): number[] {
  const rates = new Array<number>(limits.length).fill(0);
  let remaining = capacity;
  const unsaturated = new Set<number>(limits.map((_, i) => i));

  for (let pass = 0; pass < 8 && unsaturated.size > 0 && remaining > 1e-9; pass++) {
    const share = remaining / unsaturated.size;
    let consumed = 0;
    let changed = false;
    for (const i of [...unsaturated]) {
      const limit = limits[i] as number;
      if (limit <= share) {
        rates[i] = limit;
        consumed += limit;
        unsaturated.delete(i);
        changed = true;
      }
    }
    if (!changed) {
      for (const i of unsaturated) rates[i] = share;
      remaining = 0;
      break;
    }
    remaining -= consumed;
  }
  return rates;
}

function toEntry(transfer: Transfer): TimingEntryLike {
  return {
    name: transfer.spec.url,
    entryType: "resource",
    initiatorType: transfer.spec.initiatorType ?? "img",
    startTime: transfer.requestStart,
    duration: transfer.responseEnd - transfer.requestStart,
    transferSize: transfer.wireBytes,
    encodedBodySize: transfer.spec.bytes,
    decodedBodySize: transfer.spec.bytes,
    domainLookupStart: transfer.dnsStart,
    domainLookupEnd: transfer.dnsEnd,
    connectStart: transfer.connectStart,
    connectEnd: transfer.connectEnd,
    requestStart: transfer.connectEnd,
    responseStart: transfer.responseStart,
    responseEnd: transfer.responseEnd,
  };
}

function cachedEntry(spec: ResourceSpec, t: number): TimingEntryLike {
  return {
    name: spec.url,
    entryType: "resource",
    initiatorType: spec.initiatorType ?? "img",
    startTime: t,
    duration: 0.4,
    transferSize: 0,
    encodedBodySize: spec.bytes,
    decodedBodySize: spec.bytes,
    deliveryType: "cache",
    requestStart: 0,
    responseStart: 0,
    responseEnd: t + 0.4,
  };
}

/** Cross-origin with no Timing-Allow-Origin: the browser zeroes the detail. */
function opaqueEntry(
  spec: ResourceSpec,
  t: number,
  profile: LinkProfile,
  random: () => number,
): TimingEntryLike {
  const duration = profile.roundTripMilliseconds + (spec.bytes * 8 * 1000) / profile.capacityBps + random() * 5;
  return {
    name: spec.url,
    entryType: "resource",
    initiatorType: spec.initiatorType ?? "script",
    startTime: t,
    duration,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
    requestStart: 0,
    responseStart: 0,
    responseEnd: t + duration,
  };
}

/** A realistic mixed page: document, styles, scripts, images, a font. */
export function typicalPage(prefix = "https://example.test/"): ResourceSpec[] {
  return [
    { url: `${prefix}index.html`, bytes: 18_000, initiatorType: "navigation" },
    { url: `${prefix}app.css`, bytes: 42_000, initiatorType: "link" },
    { url: `${prefix}app.js`, bytes: 260_000, initiatorType: "script" },
    { url: `${prefix}vendor.js`, bytes: 480_000, initiatorType: "script" },
    { url: `${prefix}hero.jpg`, bytes: 820_000, initiatorType: "img" },
    { url: `${prefix}photo-1.jpg`, bytes: 310_000, initiatorType: "img" },
    { url: `${prefix}photo-2.jpg`, bytes: 295_000, initiatorType: "img" },
    { url: `${prefix}photo-3.jpg`, bytes: 410_000, initiatorType: "img" },
    { url: `${prefix}icons.woff2`, bytes: 28_000, initiatorType: "css" },
    { url: `${prefix}logo.svg`, bytes: 4_200, initiatorType: "img" },
    { url: `${prefix}analytics.js`, bytes: 31_000, initiatorType: "script", opaque: true },
    { url: `${prefix}cached.png`, bytes: 120_000, initiatorType: "img", cached: true },
  ];
}

/** A media page: a few large video segments, which are the best probes of all. */
export function mediaPage(prefix = "https://example.test/"): ResourceSpec[] {
  return [
    { url: `${prefix}watch.html`, bytes: 22_000, initiatorType: "navigation" },
    { url: `${prefix}player.js`, bytes: 180_000, initiatorType: "script" },
    { url: `${prefix}poster.jpg`, bytes: 240_000, initiatorType: "img" },
    { url: `${prefix}seg-1.mp4`, bytes: 2_400_000, initiatorType: "video", requestedAtMs: 200 },
    { url: `${prefix}seg-2.mp4`, bytes: 2_600_000, initiatorType: "video", requestedAtMs: 900 },
    { url: `${prefix}seg-3.mp4`, bytes: 2_500_000, initiatorType: "video", requestedAtMs: 1800 },
  ];
}

/**
 * A light page: a handful of small assets and nothing big. The hardest case
 * for passive measurement, because no transfer is long enough to show the
 * link's ceiling.
 */
export function lightPage(prefix = "https://example.test/"): ResourceSpec[] {
  return [
    { url: `${prefix}about.html`, bytes: 14_000, initiatorType: "navigation" },
    { url: `${prefix}app.css`, bytes: 42_000, initiatorType: "link", cached: true },
    { url: `${prefix}app.js`, bytes: 260_000, initiatorType: "script", cached: true },
    { url: `${prefix}avatar.png`, bytes: 22_000, initiatorType: "img" },
    { url: `${prefix}chart.svg`, bytes: 9_800, initiatorType: "img" },
  ];
}

/**
 * A page whose assets vary wildly in size and arrive one at a time. This is
 * what lets the duration-versus-size regression find the link.
 */
export function staggeredPage(prefix = "https://example.test/"): ResourceSpec[] {
  const sizes = [40_000, 90_000, 180_000, 360_000, 720_000, 1_400_000, 2_800_000];
  return [
    { url: `${prefix}lab.html`, bytes: 16_000, initiatorType: "navigation" },
    ...sizes.map((bytes, i) => ({
      url: `${prefix}chunk-${i}.bin`,
      bytes,
      initiatorType: "fetch",
      // Spaced far enough apart that each one has the link to itself.
      requestedAtMs: 400 + i * 2500,
    })),
  ];
}
