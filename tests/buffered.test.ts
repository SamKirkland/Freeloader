import { describe, expect, it } from "vitest";
import { Freeloader, parseTimingEntry, type TimingEntryLike } from "../src/freeloader.js";

/**
 * Some intermediaries hold a response and release it in one go: DevTools
 * network throttling does exactly this, and so do some proxies and shapers.
 *
 * When that happens the time the bytes actually spent on the wire lands in
 * `requestStart..responseStart` instead of `responseStart..responseEnd`, and a
 * measurement that trusts the body window alone reads a 100 Mbps link as
 * several gigabits. That breaks the one promise the library makes — that it
 * never claims a link is faster than it is — so it is tested directly.
 */

const RTT_MS = 20;
/** Entries never start at zero on a real clock, and zero reads as "opaque". */
const BASE = 100;

/** One transfer as a buffering intermediary reports it. */
function buffered(options: {
  bytes: number;
  requestStart: number;
  /** When the emulator finally released the body. */
  releasedAt: number;
  /** How long the release itself appeared to take. */
  releaseMs?: number;
}): TimingEntryLike {
  const releaseMs = options.releaseMs ?? 4;
  return {
    name: `https://example.test/asset-${options.requestStart}-${options.bytes}.jpg`,
    entryType: "resource",
    initiatorType: "img",
    startTime: options.requestStart,
    duration: options.releasedAt + releaseMs - options.requestStart,
    transferSize: options.bytes,
    encodedBodySize: options.bytes - 300,
    decodedBodySize: options.bytes - 300,
    requestStart: options.requestStart,
    // The wait swallows the transfer time.
    responseStart: options.releasedAt,
    responseEnd: options.releasedAt + releaseMs,
  };
}

describe("a response released in one go", () => {
  it("is charged for the time it spent waiting, not just for its release", () => {
    // 1 MB that really took 80 ms to arrive on a 100 Mbps link, but whose body
    // window claims 4 ms.
    const parsed = parseTimingEntry(
      buffered({ bytes: 1_000_000, requestStart: BASE, releasedAt: BASE + 100 }),
      { firstByteFloorMilliseconds: RTT_MS },
    );

    expect(parsed.skipped).toBeNull();
    // The clock starts when the first byte could physically have arrived.
    expect(parsed.window).toEqual({
      start: BASE + RTT_MS,
      end: BASE + 104,
      bytes: 1_000_000,
      fresh: false,
    });
  });

  it("leaves an ordinary transfer alone", () => {
    // Here the first byte arrives exactly one round trip after the request, so
    // there is nothing to correct and the body window stands.
    const ordinary: TimingEntryLike = {
      name: "https://example.test/ordinary.jpg",
      entryType: "resource",
      startTime: BASE,
      duration: 500,
      transferSize: 1_000_000,
      requestStart: BASE,
      responseStart: BASE + RTT_MS,
      responseEnd: BASE + 500,
    };
    const parsed = parseTimingEntry(ordinary, { firstByteFloorMilliseconds: RTT_MS });
    expect(parsed.window).toEqual({
      start: BASE + RTT_MS,
      end: BASE + 500,
      bytes: 1_000_000,
      fresh: false,
    });
  });

  it("does not let a throttled link read as gigabit end to end", () => {
    // Twelve 600 KB images on a 100 Mbps link: 7.2 MB takes about 576 ms.
    // The emulator releases them all at the end, a few milliseconds apart.
    const LINK_BPS = 100e6;
    const bytesEach = 600_000;
    const count = 12;
    const totalBytes = bytesEach * count;
    const deliveredMs = (totalBytes * 8 * 1000) / LINK_BPS;

    const freeloader = new Freeloader({
      persist: false,
      now: () => 1_700_000_000_000,
      timeOrigin: 1_700_000_000_000,
    });

    for (let i = 0; i < count; i++) {
      freeloader.ingest(
        buffered({
          bytes: bytesEach,
          requestStart: BASE,
          // Released in quick succession once the link has actually delivered.
          releasedAt: BASE + RTT_MS + deliveredMs + i * 2,
        }),
      );
      // A small request that was not buffered, to establish the round trip.
      freeloader.ingest({
        name: `https://example.test/ping-${i}.json`,
        entryType: "resource",
        startTime: BASE,
        duration: RTT_MS + 1,
        transferSize: 800,
        requestStart: BASE,
        responseStart: BASE + RTT_MS,
        responseEnd: BASE + RTT_MS + 1,
      });
    }

    freeloader.flush(BASE + RTT_MS + deliveredMs + count * 2 + 5000);
    const estimate = freeloader.getEstimate();

    expect(estimate.download.bitsPerSecond).not.toBeNull();
    const megabitsPerSecond = (estimate.download.bitsPerSecond as number) / 1e6;
    // The invariant: never faster than the link really is.
    expect(megabitsPerSecond).toBeLessThan(115);
    // And still close enough to be worth reporting.
    expect(megabitsPerSecond).toBeGreaterThan(70);
  });
});
