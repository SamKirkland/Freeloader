import { describe, expect, it, vi } from "vitest";
import {
  installUploadInstrumentation,
  measureBodySize,
  utf8Length,
  type ThroughputSample,
  type UploadHost,
} from "../src/freeloader.js";

describe("utf8Length", () => {
  it("counts ascii, accents, CJK and emoji correctly", () => {
    expect(utf8Length("hello")).toBe(5);
    expect(utf8Length("café")).toBe(5); // é is two bytes.
    expect(utf8Length("日本語")).toBe(9); // Three bytes each.
    expect(utf8Length("🚀")).toBe(4); // One surrogate pair, four bytes.
    expect(utf8Length("")).toBe(0);
  });

  it("agrees with TextEncoder", () => {
    const encoder = new TextEncoder();
    for (const value of ["plain", "mixed café 日本 🚀", JSON.stringify({ a: [1, 2, 3] })]) {
      expect(utf8Length(value)).toBe(encoder.encode(value).length);
    }
  });
});

describe("measureBodySize", () => {
  it("measures the body types a request can carry", () => {
    expect(measureBodySize("12345")).toBe(5);
    expect(measureBodySize(new ArrayBuffer(128))).toBe(128);
    expect(measureBodySize(new Uint8Array(64))).toBe(64);
    expect(measureBodySize(new Blob(["abcdef"]))).toBe(6);
    expect(measureBodySize(new URLSearchParams({ a: "1", b: "2" }))).toBe(7);
  });

  it("returns null for bodies whose size cannot be known up front", () => {
    expect(measureBodySize(null)).toBeNull();
    expect(measureBodySize(undefined)).toBeNull();
    expect(measureBodySize(new FormData())).toBeNull();
    expect(measureBodySize({ some: "object" })).toBeNull();
  });
});

/** Minimal stand-in for XMLHttpRequest's upload event target. */
class FakeUploadTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeXHR {
  static sent: unknown[] = [];
  upload = new FakeUploadTarget();
  send(body?: unknown): void {
    FakeXHR.sent.push(body);
  }
}

function harness() {
  let clock = 0;
  const samples: ThroughputSample[] = [];
  const host: UploadHost = { XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest };
  const uninstall = installUploadInstrumentation(host, {
    onSample: (sample) => samples.push(sample),
    now: () => clock,
    epochNow: () => 1_700_000_000_000 + clock,
    minimumBytes: 4096,
  });
  return {
    samples,
    uninstall,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("XMLHttpRequest upload timing", () => {
  it("times a body from loadstart to load", () => {
    const { samples, advance, uninstall } = harness();
    const xhr = new FakeXHR();
    const body = new Uint8Array(250_000);

    (xhr as unknown as XMLHttpRequest).send(body as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(200); // 250 KB in 200 ms = 10 Mbps.
    xhr.upload.emit("load", { lengthComputable: true, loaded: 250_000, total: 250_000 });

    expect(samples).toHaveLength(1);
    const sample = samples[0] as ThroughputSample;
    expect(sample.bitsPerSecond).toBe(10_000_000);
    expect(sample.source).toBe("xhr-upload");
    // Nothing here proves the connection was new, so no slow-start correction.
    expect(sample.freshFraction).toBe(0);
    uninstall();
  });

  it("still forwards the body to the original send", () => {
    const { uninstall } = harness();
    FakeXHR.sent = [];
    const xhr = new FakeXHR();
    const body = new Uint8Array(8192);
    (xhr as unknown as XMLHttpRequest).send(body as unknown as XMLHttpRequestBodyInit);
    expect(FakeXHR.sent[0]).toBe(body);
    uninstall();
  });

  it("ignores bodies below the size floor", () => {
    const { samples, advance, uninstall } = harness();
    const xhr = new FakeXHR();
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(100) as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(50);
    xhr.upload.emit("load", { lengthComputable: true, loaded: 100, total: 100 });
    expect(samples).toHaveLength(0);
    uninstall();
  });

  it("emits nothing for an aborted or failed upload, and unhooks itself", () => {
    const { samples, advance, uninstall } = harness();
    const xhr = new FakeXHR();
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(200_000) as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(100);
    xhr.upload.emit("abort");
    expect(samples).toHaveLength(0);
    expect(xhr.upload.count("load")).toBe(0);
    uninstall();
  });

  it("emits nothing when a host refuses the body part way through", () => {
    // What a static host does if it answers 405 without draining the request:
    // the socket closes, some of the body has gone out, and the upload fires
    // `error` rather than `load`. Timing the bytes that did escape would
    // measure the refusal, not the link.
    const { samples, advance, uninstall } = harness();
    const xhr = new FakeXHR();
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(8_388_608) as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(40);
    xhr.upload.emit("progress", { lengthComputable: true, loaded: 262_144, total: 8_388_608 });
    xhr.upload.emit("error");
    expect(samples).toHaveLength(0);
    uninstall();
  });

  it("removes its listeners once a sample is taken", () => {
    const { advance, uninstall } = harness();
    const xhr = new FakeXHR();
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(200_000) as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(100);
    xhr.upload.emit("load", { lengthComputable: true, loaded: 200_000, total: 200_000 });
    expect(xhr.upload.count("loadstart")).toBe(0);
    expect(xhr.upload.count("load")).toBe(0);
    uninstall();
  });

  it("restores the original send on uninstall", () => {
    const original = FakeXHR.prototype.send;
    const { uninstall } = harness();
    expect(FakeXHR.prototype.send).not.toBe(original);
    uninstall();
    expect(FakeXHR.prototype.send).toBe(original);
  });

  it("never reinstalls a stopped send when two installs uninstall in start order", () => {
    const original = FakeXHR.prototype.send;
    const first = harness();
    const second = harness();
    first.uninstall();
    second.uninstall();

    const xhr = new FakeXHR();
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(200_000) as unknown as XMLHttpRequestBodyInit);
    expect(xhr.upload.count("load")).toBe(0);
    expect(FakeXHR.sent[FakeXHR.sent.length - 1]).toBeInstanceOf(Uint8Array);

    // The first wrapper is left in the chain as a pass-through; clear it so
    // later tests see the real prototype.
    FakeXHR.prototype.send = original;
  });

  it("unwinds send fully when uninstalled in reverse order", () => {
    const original = FakeXHR.prototype.send;
    const first = harness();
    const second = harness();
    second.uninstall();
    first.uninstall();
    expect(FakeXHR.prototype.send).toBe(original);
  });
});

describe("fetch upload timing", () => {
  function fetchHarness(roundTripMilliseconds: number | null = 0) {
    let clock = 0;
    const samples: ThroughputSample[] = [];
    const inner = vi.fn(async () => {
      clock += 120; // The request took 120 ms to come back.
      return { ok: true } as Response;
    });
    const host: UploadHost = { fetch: inner as unknown as typeof fetch };
    const uninstall = installUploadInstrumentation(host, {
      onSample: (sample) => samples.push(sample),
      getRoundTripMilliseconds: () => roundTripMilliseconds,
      now: () => clock,
      epochNow: () => 1_700_000_000_000 + clock,
      minimumBytes: 4096,
    });
    return { host, samples, inner, uninstall };
  }

  it("times a POST body and subtracts one round trip", async () => {
    const { host, samples } = fetchHarness(20);
    await (host.fetch as typeof fetch)("/api/upload", {
      method: "POST",
      body: new Uint8Array(125_000),
    });
    expect(samples).toHaveLength(1);
    // 125 KB over (120 - 20) ms = 10 Mbps.
    expect((samples[0] as ThroughputSample).bitsPerSecond).toBe(10_000_000);
    expect((samples[0] as ThroughputSample).source).toBe("fetch-upload");
  });

  it("passes requests through untouched when there is no measurable body", async () => {
    const { host, samples, inner } = fetchHarness();
    const response = await (host.fetch as typeof fetch)("/api/list");
    expect(response.ok).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(0);
  });

  it("propagates failures without recording a sample", async () => {
    let clock = 0;
    const samples: ThroughputSample[] = [];
    const host: UploadHost = {
      fetch: (async () => {
        clock += 50;
        throw new Error("network down");
      }) as unknown as typeof fetch,
    };
    installUploadInstrumentation(host, {
      onSample: (s) => samples.push(s),
      now: () => clock,
      minimumBytes: 4096,
    });
    await expect((host.fetch as typeof fetch)("/api", { body: new Uint8Array(50_000) })).rejects.toThrow(
      "network down",
    );
    expect(samples).toHaveLength(0);
  });

  it("restores the original fetch on uninstall", () => {
    const { host, inner, uninstall } = fetchHarness();
    expect(host.fetch).not.toBe(inner);
    uninstall();
    expect(host.fetch).toBe(inner);
  });

  it("uninstalling twice is harmless", () => {
    const { host, inner, uninstall } = fetchHarness();
    uninstall();
    uninstall();
    expect(host.fetch).toBe(inner);
  });

  describe("when something else wraps fetch on top", () => {
    function stacked() {
      const first = fetchHarness();
      const { host, inner } = first;
      const secondSamples: ThroughputSample[] = [];
      const secondUninstall = installUploadInstrumentation(host, {
        onSample: (sample) => secondSamples.push(sample),
        getRoundTripMilliseconds: () => 0,
        // Each reading is 100 ms after the last, so a call through it takes time.
        now: (() => {
          let clock = 0;
          return () => (clock += 100);
        })(),
        minimumBytes: 4096,
      });
      const upload = () => (host.fetch as typeof fetch)("/api/upload", { method: "POST", body: new Uint8Array(125_000) });
      return { host, inner, first, secondSamples, secondUninstall, upload };
    }

    it("leaves the later wrapper in place when the earlier one uninstalls", async () => {
      const { host, first, secondSamples, upload } = stacked();
      const top = host.fetch;
      first.uninstall();
      expect(host.fetch).toBe(top);

      await upload();
      expect(first.samples).toHaveLength(0);
      expect(secondSamples).toHaveLength(1);
    });

    it("never reinstalls a stopped wrapper, whatever order they uninstall in", async () => {
      const { host, inner, first, secondSamples, secondUninstall, upload } = stacked();
      first.uninstall();
      secondUninstall();

      // The first wrapper cannot be unhooked from under the second, so it stays
      // in the chain, but it must be a pure pass-through.
      const response = await upload();
      expect(response.ok).toBe(true);
      expect(inner).toHaveBeenCalledTimes(1);
      expect(first.samples).toHaveLength(0);
      expect(secondSamples).toHaveLength(0);
    });

    it("unwinds fully when uninstalled in reverse order", () => {
      const { host, inner, first, secondUninstall } = stacked();
      secondUninstall();
      first.uninstall();
      expect(host.fetch).toBe(inner);
    });
  });
});
