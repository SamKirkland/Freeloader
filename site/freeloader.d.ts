/*!
 * Freeloader v1.0.3
 * Zero-dependency, zero-weight passive network speed estimation from ordinary page traffic.
 *
 * Source, docs and updates: https://github.com/SamKirkland/FreeLoader
 * Report issues: https://github.com/SamKirkland/FreeLoader/issues
 * @license MIT (c) Sam Kirkland
 */
/** Where a sample came from. Useful for debugging and for weighting. */
export type SampleSource = "navigation" | "resource" | "burst" | "xhr-upload" | "fetch-upload";
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
/** Human-readable bits per second, e.g. `42.3 Mbps`. */
export declare function formatBitsPerSecond(bitsPerSecond: number | null | undefined): string;
/** Human-readable milliseconds, e.g. `18.4 ms`. */
export declare function formatMilliseconds(ms: number | null | undefined): string;
/**
 * Human-readable byte counts, e.g. `3.4 MB`.
 *
 * Decimal, not binary: a KB here is 1000 bytes. Everything else in this library
 * is decimal — a megabit is 1e6 bits — and mixing the two would mean a file the
 * operating system calls 7.8 MB showing up as 7.5 MB beside a rate in Mbps.
 */
export declare function formatBytes(bytes: number | null | undefined): string;
/** The minimal slice of localStorage we need; makes the store trivially fakeable. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
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
    totals: {
        downloadBytes: number;
        uploadBytes: number;
        samples: number;
    };
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
export declare class Freeloader {
    private readonly options;
    private readonly storage;
    private readonly aggregator;
    private readonly listeners;
    private readonly skipped;
    /** Latency observations awaiting a contention verdict. */
    private pendingLatency;
    /** Recent body windows, used to decide whether a request had the link to itself. */
    private recentWindows;
    /**
     * Latency samples from this page view, with the wait window each one came
     * from, so a transfer reported later can still be recognised as having
     * competed with them.
     */
    private latencyWaits;
    /**
     * Samples whose bursts are still open to revision. They count toward the
     * estimate but are not settled, and are recomputed on every flush.
     */
    private liveSamples;
    private state;
    private estimate;
    private observer;
    private uninstallUploads;
    private flushTimer;
    private running;
    /**
     * Entries the observer has delivered, kept across stop/start. Deliberately
     * not cleared by `reset()`: forgetting the page's old traffic means not
     * counting it again either.
     */
    private observed;
    constructor(options?: FreeloaderOptions, storage?: StorageLike | null);
    /** Construct and start in one call. */
    static start(options?: FreeloaderOptions): Freeloader;
    get isRunning(): boolean;
    /** Begin observing. Safe to call twice; the second call does nothing. */
    start(): void;
    /** Stop observing, un-patch fetch/XHR, and write the final state out. */
    stop(): void;
    /** Current estimate. Cheap: it is recomputed on change, not on read. */
    getEstimate(): NetworkEstimate;
    /** Subscribe to estimate changes. Returns an unsubscribe function. */
    subscribe(listener: (estimate: NetworkEstimate) => void): () => void;
    /** Throw away everything learned so far, including the stored copy. */
    reset(): void;
    debug(): FreeloaderDebug;
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
    private firstByteFloorMilliseconds;
    /**
     * Feed one performance entry in by hand. The observer calls this, and so do
     * the tests; it is also the escape hatch for apps that buffer entries
     * themselves.
     */
    ingest(entry: TimingEntryLike): void;
    /**
     * Close out any bursts that can no longer grow and fold them in.
     *
     * `nowPerf` defaults to the real performance clock; passing it explicitly
     * lets tests drive a simulated clock.
     */
    flush(nowPerf?: number): void;
    /**
     * Settle every open burst. Called by `stop()`, so that what was learned is
     * saved rather than lost mid-burst.
     */
    private settleAll;
    /**
     * Decide, now that the surrounding transfers are known, which requests were
     * waiting on a quiet link and which were queued behind the page's own bytes.
     */
    private resolveLatency;
    private overlaps;
    /** Flag any already-recorded latency sample this transfer was competing with. */
    private markContention;
    private scheduleFlush;
    private addUploadSample;
    private addLatencySample;
    private addSample;
    private matchesOrigin;
    private estimatorConfig;
    private recompute;
    private publish;
    /**
     * Persist settled and still-open samples together.
     *
     * Keeping the two apart in memory is what lets a burst be revised; on the way
     * out they are the same thing, so a page that is closed mid-burst still keeps
     * what it measured.
     */
    private persist;
    private now;
    private perfNow;
    private timeOrigin;
    private epochFromPerf;
}
