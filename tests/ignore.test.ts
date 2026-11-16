import { describe, expect, it } from "vitest";
import {
  compileIgnoreList,
  compileUrlPattern,
  Freeloader,
  installUploadInstrumentation,
  urlCandidates,
  type ThroughputSample,
  type UploadHost,
  type UrlPattern,
} from "../src/freeloader.js";
import { simulatePageLoad, typicalPage, type LinkProfile } from "./helpers/simulate.js";

const PROFILE: LinkProfile = {
  capacityBps: 50e6,
  roundTripMilliseconds: 30,
  serverThinkMs: 12,
  maxConcurrent: 6,
  jitterMilliseconds: 5,
  seed: 7,
};

/** Would this one pattern leave this one URL out? */
function ignores(pattern: UrlPattern, url: string): boolean {
  return compileIgnoreList([pattern])(url);
}

describe("compileUrlPattern", () => {
  it("treats a plain string as a substring", () => {
    const matches = compileUrlPattern("sink.txt");
    expect(matches("https://example.test/assets/sink.txt?speedtest=1")).toBe(true);
    expect(matches("https://example.test/assets/hero.jpg")).toBe(false);
  });

  it("treats a string containing * as a glob over the whole candidate", () => {
    const matches = compileUrlPattern("*/assets/*.jpg");
    expect(matches("https://example.test/assets/hero.jpg")).toBe(true);
    expect(matches("/assets/hero.jpg")).toBe(true);
    // Anchored at both ends, so the query string has to be matched too.
    expect(matches("https://example.test/assets/hero.jpg?v=2")).toBe(false);
  });

  it("leaves every character but * literal", () => {
    expect(compileUrlPattern("*/a?b=1")("/a?b=1")).toBe(true);
    expect(compileUrlPattern("*/a?b=1")("/axb=1")).toBe(false);
    expect(compileUrlPattern("*/hero.jpg")("/heroxjpg")).toBe(false);
  });

  it("compares exactly as each tagged form names", () => {
    expect(ignores({ exact: "/assets/sink.txt" }, "/assets/sink.txt")).toBe(true);
    expect(ignores({ exact: "/assets/sink.txt" }, "/assets/sink.txt?x=1")).toBe(false);
    expect(ignores({ includes: "speedtest" }, "/a.bin?speedtest=9")).toBe(true);
    expect(ignores({ startsWith: "/api/" }, "/api/upload")).toBe(true);
    expect(ignores({ startsWith: "/api/" }, "/v2/api/upload")).toBe(false);
    expect(ignores({ endsWith: ".bin" }, "/big.bin")).toBe(true);
    expect(ignores({ endsWith: ".bin" }, "/big.bin?v=2")).toBe(false);
    expect(ignores({ glob: "/segments/*.ts" }, "/segments/0001.ts")).toBe(true);
    expect(ignores({ regex: "sink|probe" }, "/probe")).toBe(true);
    expect(ignores({ regex: "SINK", flags: "i" }, "/sink.txt")).toBe(true);
  });

  it("accepts a RegExp and a predicate", () => {
    expect(ignores(/\?speedtest=/, "/a.bin?speedtest=1")).toBe(true);
    expect(ignores((url) => url.includes("sink"), "/assets/sink.txt")).toBe(true);
    expect(ignores((url) => url.length > 100, "/short")).toBe(false);
  });

  it("is not made stateful by a global regex", () => {
    const matches = compileUrlPattern(/sink/g);
    expect(matches("/sink.txt")).toBe(true);
    // A `g` left in place would carry lastIndex over and miss the second try.
    expect(matches("/sink.txt")).toBe(true);
  });

  it("ignores nothing when there is nothing to ignore", () => {
    expect(compileIgnoreList([])("/anything")).toBe(false);
    expect(compileIgnoreList(undefined)("/anything")).toBe(false);
  });
});

describe("urlCandidates", () => {
  it("offers the URL as reported and its path with query", () => {
    expect(urlCandidates("https://example.test/a/b.js?v=1")).toEqual([
      "https://example.test/a/b.js?v=1",
      "/a/b.js?v=1",
    ]);
  });

  it("falls back to the raw string when it is not a URL at all", () => {
    expect(urlCandidates("about:blank")).toContain("about:blank");
  });

  it("lets a path-shaped pattern match an absolute URL", () => {
    expect(ignores({ exact: "/assets/sink.txt" }, "https://example.test/assets/sink.txt")).toBe(true);
  });
});

describe("the ignore option", () => {
  const page = () => simulatePageLoad(PROFILE, typicalPage(), 0);

  it("leaves matching transfers out of the estimate entirely", () => {
    const entries = page();
    const ignoring = new Freeloader(
      { persist: false, instrumentUploads: false, ignore: ["hero.jpg", { endsWith: "vendor.js" }] },
      null,
    );
    const counting = new Freeloader({ persist: false, instrumentUploads: false }, null);
    for (const entry of entries) {
      ignoring.ingest(entry);
      counting.ingest(entry);
    }
    ignoring.flush(1e6);
    counting.flush(1e6);

    expect(ignoring.debug().skipped["ignored"]).toBe(2);
    expect(counting.debug().skipped["ignored"]).toBeUndefined();
    // The two largest files are gone, so neither their bytes nor their time count.
    expect(counting.debug().totals.downloadBytes - ignoring.debug().totals.downloadBytes).toBeGreaterThan(
      1_000_000,
    );
    expect(ignoring.getEstimate().download.bitsPerSecond).toBeGreaterThan(0);
  });

  it("ignores a whole speed test by its query marker", () => {
    const freeloader = new Freeloader(
      { persist: false, instrumentUploads: false, ignore: [/[?&]speedtest=/] },
      null,
    );
    const probes = simulatePageLoad(
      PROFILE,
      typicalPage().map((file) => ({ ...file, url: `${file.url}?speedtest=abc` })),
      0,
    );
    for (const entry of probes) freeloader.ingest(entry);
    freeloader.flush(1e6);

    expect(freeloader.debug().skipped["ignored"]).toBe(probes.length);
    expect(freeloader.getEstimate().download.bitsPerSecond).toBeNull();
    expect(freeloader.getEstimate().latency.roundTripMilliseconds).toBeNull();
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
}

/** A fake that, unlike the one in upload.test.ts, is opened to a URL first. */
class FakeXHR {
  static opened: string[] = [];
  upload = new FakeUploadTarget();
  open(method: string, url: string): void {
    FakeXHR.opened.push(`${method} ${url}`);
  }
  send(_body?: unknown): void {}
}

describe("ignored uploads", () => {
  function harness(ignore: UrlPattern[]) {
    let clock = 0;
    const samples: ThroughputSample[] = [];
    const host: UploadHost = { XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest };
    const uninstall = installUploadInstrumentation(host, {
      onSample: (sample) => samples.push(sample),
      now: () => clock,
      epochNow: () => 1_700_000_000_000 + clock,
      minimumBytes: 4096,
      shouldIgnore: compileIgnoreList(ignore),
    });
    return {
      samples,
      uninstall,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  /** One 250 KB upload, opened to `url` and timed over `ms` milliseconds. */
  function upload(url: string, advance: (ms: number) => void, ms: number): void {
    const xhr = new FakeXHR();
    const bytes = 250_000;
    (xhr as unknown as XMLHttpRequest).open("POST", url);
    (xhr as unknown as XMLHttpRequest).send(new Uint8Array(bytes) as unknown as XMLHttpRequestBodyInit);
    xhr.upload.emit("loadstart");
    advance(ms);
    xhr.upload.emit("load", { lengthComputable: true, loaded: bytes, total: bytes });
  }

  it("does not time an XHR upload to an ignored URL", () => {
    FakeXHR.opened = [];
    const { samples, advance, uninstall } = harness([{ exact: "/assets/sink.txt" }]);

    upload("/assets/sink.txt", advance, 200);
    expect(samples).toHaveLength(0);
    // The request itself still went out, untouched.
    expect(FakeXHR.opened).toEqual(["POST /assets/sink.txt"]);

    upload("/api/photos", advance, 200); // 250 KB in 200 ms = 10 Mbps.
    expect(samples).toHaveLength(1);
    expect((samples[0] as ThroughputSample).bitsPerSecond).toBe(10_000_000);
    uninstall();
  });

  it("does not time a fetch upload to an ignored URL", async () => {
    let clock = 0;
    const samples: ThroughputSample[] = [];
    const host: UploadHost = {
      fetch: (async () => {
        clock += 100;
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    };
    const uninstall = installUploadInstrumentation(host, {
      onSample: (sample) => samples.push(sample),
      now: () => clock,
      epochNow: () => 1_700_000_000_000 + clock,
      minimumBytes: 4096,
      shouldIgnore: compileIgnoreList(["speedtest"]),
    });

    const fetching = host.fetch as typeof fetch;
    await fetching("/assets/sink.txt?speedtest=1", { method: "POST", body: new Uint8Array(200_000) });
    expect(samples).toHaveLength(0);

    // A Request object carries its URL too, and is matched the same way.
    await fetching("/api/photos", { method: "POST", body: new Uint8Array(200_000) });
    expect(samples).toHaveLength(1);
    uninstall();
  });

  it("restores the original open on uninstall", () => {
    const original = FakeXHR.prototype.open;
    const { uninstall } = harness(["anything"]);
    expect(FakeXHR.prototype.open).not.toBe(original);
    uninstall();
    expect(FakeXHR.prototype.open).toBe(original);
  });
});
