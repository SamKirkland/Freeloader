import { describe, expect, it } from "vitest";
import {
  clearState,
  emptyState,
  loadState,
  saveState,
  type PersistedState,
  type StorageLike,
  type ThroughputSample,
} from "../src/freeloader.js";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  throwOnWrite = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new DOMException("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const KEY = "freeloader:test";
const DAY = 24 * 60 * 60 * 1000;

function sample(at: number, bitsPerSecond = 1e7): ThroughputSample {
  return { bytes: 500_000, durationMilliseconds: 400, bitsPerSecond, concurrency: 1, resources: 1, freshFraction: 1, at, source: "burst" };
}

function stateWith(now: number, overrides: Partial<PersistedState> = {}): PersistedState {
  return { ...emptyState(now), download: [sample(now)], ...overrides };
}

describe("persistence", () => {
  it("round-trips a state through storage", () => {
    const storage = new FakeStorage();
    const now = Date.now();
    saveState(storage, KEY, stateWith(now));
    const loaded = loadState(storage, KEY, 7 * DAY, now);
    expect(loaded.download).toHaveLength(1);
    expect((loaded.download[0] as ThroughputSample).bitsPerSecond).toBe(1e7);
  });

  it("starts fresh when nothing is stored", () => {
    const loaded = loadState(new FakeStorage(), KEY, 7 * DAY, Date.now());
    expect(loaded.download).toHaveLength(0);
    expect(loaded.totals.samples).toBe(0);
  });

  it("discards state older than the maximum age", () => {
    const storage = new FakeStorage();
    const now = Date.now();
    saveState(storage, KEY, stateWith(now - 10 * DAY));
    expect(loadState(storage, KEY, 7 * DAY, now).download).toHaveLength(0);
  });

  it("drops individual samples that have aged out", () => {
    const storage = new FakeStorage();
    const now = Date.now();
    const state = emptyState(now);
    state.download = [sample(now - 10 * DAY), sample(now - 1000)];
    saveState(storage, KEY, state);
    expect(loadState(storage, KEY, 7 * DAY, now).download).toHaveLength(1);
  });

  it("survives corrupt or foreign data in its key", () => {
    const storage = new FakeStorage();
    const now = Date.now();
    for (const junk of ["not json", "null", "[]", '{"v":99}', '"a string"']) {
      storage.map.set(KEY, junk);
      expect(loadState(storage, KEY, 7 * DAY, now).download).toHaveLength(0);
    }
  });

  it("filters out malformed samples inside otherwise valid state", () => {
    const storage = new FakeStorage();
    const now = Date.now();
    storage.map.set(
      KEY,
      JSON.stringify({
        version: 1,
        updatedAt: now,
        download: [sample(now), { bytes: "lots" }, { bitsPerSecond: Number.NaN, at: now }, null, sample(now, -5)],
        upload: "not an array",
        latency: [{ timeToFirstByteMilliseconds: 20, at: now }, { timeToFirstByteMilliseconds: "soon", at: now }],
        totals: { downloadBytes: 5 },
      }),
    );
    const loaded = loadState(storage, KEY, 7 * DAY, now);
    expect(loaded.download).toHaveLength(1);
    expect(loaded.upload).toHaveLength(0);
    expect(loaded.latency).toHaveLength(1);
    expect(loaded.totals).toEqual({ downloadBytes: 5, uploadBytes: 0, samples: 0 });
  });

  it("does not throw when storage refuses to write", () => {
    const storage = new FakeStorage();
    storage.throwOnWrite = true;
    expect(() => saveState(storage, KEY, stateWith(Date.now()))).not.toThrow();
  });

  it("treats a missing storage as no persistence", () => {
    expect(() => saveState(null, KEY, stateWith(Date.now()))).not.toThrow();
    expect(() => clearState(null, KEY)).not.toThrow();
    expect(loadState(null, KEY, 7 * DAY, Date.now()).download).toHaveLength(0);
  });

  it("clears the stored copy", () => {
    const storage = new FakeStorage();
    saveState(storage, KEY, stateWith(Date.now()));
    clearState(storage, KEY);
    expect(storage.getItem(KEY)).toBeNull();
  });
});
