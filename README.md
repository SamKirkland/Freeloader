# Freeloader
Passive network speed test for the browser.
No dependencies. 20KB Gzipped.


The traditional form of running a speed test downloads and uploads a series of large files in parallel 
while measuring the speeds. This consumes the users data cap and slows down the rest of the page.
Traditional tests take 1-2 minutes.

Freeloader takes a different approach, start Freeloader right away and Freeloader monitors **existing** network
request you website is already making such as images, styles, scripts, video, and API calls. 
As the user uses your website the estimated speed gets more accurate. But is already within 20% of a full speed test by the time the home page is done loading. Freeloader ties into browser APIs for resource timings so it doesn't use any extra resources or slow down your page load besdies the modest additional 20KB script size.

## Install

Freeloader is a simple single-file utility with no dependencies. No npm package is available.

Copy it into your project and use it:
- **TypeScript:** `freeloader.ts`
- **JavaScript:** `freeloader.js`, and `freeloader.d.ts` if you want types in your editor.

## Usage

```ts
import { Freeloader } from "./freeloader";

const freeloader = Freeloader.start();

freeloader.subscribe((estimate) => {
  console.log(estimate.download.megabitsPerSecond, estimate.upload.megabitsPerSecond, estimate.latency.roundTripMilliseconds);
});
```

---

## Where to start it

Once per page load, in the browser. Load it last.

Freeloader reads download timings from the browser's Resource Timing records, which the browser
keeps for everything the page has already loaded. So it doesn't need to run first: downloads that
finished before `start()` still count, and loading it last keeps it out of your page's way.

Uploads are the one exception: they're timed by wrapping `fetch` and `XMLHttpRequest`, so uploads sent before `start()` aren't measured.

### Script tag

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module" src="/app.js"></script>
  </head>
  <body>
    <!-- content -->
    <script type="module">
      // Start after everything else has loaded. Downloads so far are still read
      // from the browser's timing records; uploads before this point are not timed.
      addEventListener("load", async () => {
        const { Freeloader } = await import("/freeloader.js");
        window.freeloader = Freeloader.start();
      }, { once: true });
    </script>
  </body>
</html>
```

Until the page's `load` event, `window.freeloader` is `undefined`, so check for it before reading it.
Freeloader is an ES module, so it needs `type="module"` or `import()`; a classic `<script>` won't work.

### Bundled apps

Copy `freeloader.ts` into your source folder, create one shared instance, and import it from your entry file:

```ts
// src/network.ts
import { Freeloader } from "./freeloader";

export const network = Freeloader.start();
```

### React

```tsx
// src/main.tsx
import "./network";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
```

```ts
// src/useNetwork.ts
import { useSyncExternalStore } from "react";
import { network } from "./network";

export function useNetwork() {
  return useSyncExternalStore(
    (onChange) => network.subscribe(onChange),
    () => network.getEstimate(),
  );
}
```

```tsx
// src/NetworkStatus.tsx
import { formatBitsPerSecond, formatMilliseconds } from "./freeloader";
import { useNetwork } from "./useNetwork";

export function NetworkStatus() {
  const { download, upload, latency } = useNetwork();
  return (
    <p>
      ↓ {formatBitsPerSecond(download.bitsPerSecond)} · ↑ {formatBitsPerSecond(upload.bitsPerSecond)} ·{" "}
      {formatMilliseconds(latency.roundTripMilliseconds)} ping
    </p>
  );
}
```

### Next.js

`instrumentation-client.ts` (Next.js 15.3+) runs in the browser before hydration.

```ts
// lib/network.ts
import { Freeloader } from "./freeloader.js";

export const network = typeof window === "undefined" ? null : Freeloader.start();
```

```ts
// instrumentation-client.ts
import "./lib/network";
```

```ts
// lib/useNetwork.ts
"use client";
import { useSyncExternalStore } from "react";
import { network } from "./network";

const subscribe = (onChange: () => void) => network?.subscribe(onChange) ?? (() => {});

export function useNetwork() {
  return useSyncExternalStore(subscribe, () => network?.getEstimate() ?? null, () => null);
}
```

`useNetwork()` returns `null` during server rendering and hydration. On the Pages Router, import
`../lib/network` at the top of `pages/_app.tsx` instead.

### Vue

```ts
// src/main.ts
import "./network";
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

```ts
// src/useNetwork.ts
import { onScopeDispose, shallowRef } from "vue";
import { network } from "./network";

export function useNetwork() {
  const estimate = shallowRef(network.getEstimate());
  onScopeDispose(network.subscribe((next) => (estimate.value = next)));
  return estimate;
}
```

On Nuxt, use a client-only plugin instead:

```ts
// plugins/freeloader.client.ts
import { Freeloader } from "~/freeloader.js";

export default defineNuxtPlugin(() => ({ provide: { network: Freeloader.start() } }));
```

```ts
const { $network } = useNuxtApp();
```

### Svelte and SvelteKit

```ts
// src/lib/network.ts
import { browser } from "$app/environment";
import { readable } from "svelte/store";
import { Freeloader } from "./freeloader.js";

export const network = browser ? Freeloader.start() : null;

export const estimate = readable(network?.getEstimate() ?? null, (set) => network?.subscribe(set));
```

```ts
// src/hooks.client.ts
import "$lib/network";
```

```svelte
<p>{$estimate?.download.megabitsPerSecond ?? "—"} Mbps</p>
```

Without SvelteKit, drop the `browser` check and import `./lib/network` in `main.ts`.

### Angular

```ts
// src/main.ts
import "./network";
import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

bootstrapApplication(AppComponent, appConfig);
```

```ts
// src/app/network.service.ts
import { Injectable, signal } from "@angular/core";
import { network } from "../network";

@Injectable({ providedIn: "root" })
export class NetworkService {
  readonly estimate = signal(network.getEstimate());

  constructor() {
    network.subscribe((next) => this.estimate.set(next));
  }
}
```

With server-side rendering, use the `typeof window` check from the Next.js example.

## What it measures

| | How it's measured |
|---|---|
| **Download** | Files that download at the same time are grouped together, and the speed is their total size divided by how long the group took. |
| **Upload** | How long request bodies take to send. `XMLHttpRequest` reports this directly; for `fetch`, it's the time until the response starts, minus one round trip. |
| **Round trip** | The fastest time to first byte among recent requests. When a request opens a new connection, the setup takes about two round trips, so half the fastest setup is used if that is lower. |
| **Jitter** | How much the time to first byte varies, measured only while nothing else was downloading. |
| **Confidence** | Sample count, bytes observed, and how much the samples agree. |

Everything stays in the browser. Only sizes and timings are read — never the contents of a request
or a response.

## Accuracy

Two independent checks, because a measurement library that is only tested against its own
assumptions has not been tested.

**Against a simulated link** (`tests/accuracy.test.ts`) — a discrete-event model with a fixed
connection pool, a congestion window that ramps and then stays warm, round trip, server think time
and jitter. The link's true capacity is known exactly, so error is exact:

| Link | After one page | After a short session |
|---|---|---|
| 5 Mbps, 120 ms | 1.00× | 1.00× |
| 25 Mbps, 40 ms | 0.99× | 1.00× |
| 100 Mbps, 20 ms | 0.95× | 0.99× |
| 500 Mbps, 8 ms | 0.78× | 0.98× |
| 1 Gbps, 5 ms | 0.68× | 0.96× |

The suite asserts the final figure lands within 10%, that no figure ever exceeds true capacity by
more than 5%, that the estimate improves as browsing continues, and that entries arriving in
completion order — the way a browser actually delivers them — give the same answer.

**Against a real browser** on a throttled server (`tools/dev-server.mjs --mbps N`, a single shared
token bucket, so the whole browser really is limited to that rate):

| Configured | Measured | Error |
|---|---|---|
| 5 Mbps | 4.97 Mbps | −0.7% |
| 25 Mbps | 25.1 Mbps | +0.4% |
| 50 Mbps | 46.4 Mbps | −7% (link delivered 45.6 on a single stream) |
| 100 Mbps | 96.5 Mbps | −3.5% |

Latency tracked the configured delay closely too: on the 25 Mbps run the server delayed each
response by 40 ms ± 8 ms and Freeloader reported 46 ms time to first byte with 4.4 ms of jitter.

Run it yourself:

```bash
npm run assets && npm run build:site && node tools/dev-server.mjs --mbps 25 --latency 40 --jitter 8
```

Throttling is opt-in and off by default — `npm run serve` hands out files and nothing else, the way
the deployed site is served.

**Against a link whose delay lands in the wait** (`tools/dev-server.mjs --mbps 100 --buffer`) —
the case that matters because it is what DevTools network throttling does, and what some proxies
and shapers do. The server holds each response for as long as it would have taken to arrive and
then sends it in one go, so Resource Timing shows a long wait followed by a body window of a few
milliseconds. Measured in Chrome against that server at 100 Mbps: 83 Mbps, peak 84, never above the
configured rate. The streaming throttle on the same rate reads 91 Mbps.

**Upload, measured the same way** — the speed test posts to a static path and times the body going
out. Against the same 100 Mbps server it reads 97.5 Mbps. There is deliberately no *peak* upload:
`XMLHttpRequest` reports bytes handed to the socket rather than bytes acknowledged, and reports them
in lumps, so the best window reads +160% at one second, +98% at two, +37% at four and +16% at six —
converging on the truth only by turning into the average. Total bytes over total time is anchored at
both ends by something real, so that is the figure given.

**Against an active speed test in the browser** (`/speedtest.html`) — the check that travels with
the deployed demo, where there is no throttled server to ask. The page does what a conventional
speed test does: it pulls the site's own static images and video over parallel connections with
fresh cache-busters, times the bytes, and reports a rate. Because it is an ordinary active test, it
is ground truth for the passive estimate sitting next to it.

The comparison is set up so it cannot cheat. The passive estimate is snapshotted the instant the
test starts, before the test's own traffic can teach the library anything, and that snapshot is the
figure graded. Against the throttled dev server at 25 Mbps the test itself reads 24.2–25.0 Mbps, so
it is a fair referee.

### What it cannot do

- **It cannot exceed what the site transfers.** On a gigabit link, a page that only ever moves 40 KB
  assets will read low. The link was never asked for more, so nothing observed it.
- **The first page view on a very fast link reads low.** New connections spend their first round
  trips ramping up. That ramp is corrected for, but only within reason.
- **Cross-origin assets are invisible** unless the other origin sends `Timing-Allow-Origin`. Without
  it the browser zeroes every timestamp and reports zero transferred bytes, which is indistinguishable
  from a cache hit — so both are skipped.
- **Upload needs uploads.** A site that never sends a request body will never have an upload figure.
  It does not need a server that *accepts* one, though: the browser reports the body going out
  whatever comes back, so a static host refusing a `POST` with 405 still yields a real measurement —
  provided it reads the request before refusing it. A host that answers and closes the socket without
  draining the body truncates the upload, and the browser then fires `error` rather than `load`, so
  no sample is taken at all. Either way the figure is never wrong; on such a host there simply is
  not one.
- **A page of revalidations says nothing.** A `304` transfers its headers and nothing else, so ten
  of them are ten numerous, perfectly consistent samples totalling three kilobytes. The figure they
  imply stands as a floor, but when no transfer at all clears the size gate the confidence is held
  low.
- **A shaper's burst allowance is not capacity.** Small transfers ride it and look enormous; the
  estimate is capped by the fastest transfer large enough to outrun it.
- **A server that thinks for a long time reads as a slow link.** A transfer's clock starts at the
  fastest first byte the page has seen, so a response that is unusually slow to start is charged for
  the difference. This is what keeps buffered delivery from reading as gigabit, and the cost is that
  one slow endpoint looks like a slow link — which is why the estimate reaches for the top of the
  sample distribution rather than its middle.

When the evidence is thin, confidence is low rather than the number being wrong. A page of 30 KB
assets on a 100 Mbps link reports low confidence, and the test suite asserts that it does.

## How it works

**Bursts, not requests.** Six images downloading at once each look slow on their own, because each is
getting a slice of the link. Transfers whose windows overlap are merged, and the burst's total bytes
divided by the wall time it occupied is what the link actually did. Because a browser reports a
transfer only when it *finishes*, a twelve-second download arrives long after the short transfers it
was sharing the link with — so bursts stay open to revision for a minute rather than being measured
once and closed. Getting this wrong made a 5 Mbps link read as 2.7 Mbps.

**Slow start, undone.** A connection's window doubles every round trip until it saturates the link.
Integrating that ramp shows the lost time is `rtt × (log2(rtt × rate / IW) − log2 e)`, which can be
subtracted. It is applied only to transfers whose timings show a real handshake — bytes on a reused
connection never paid the ramp, and correcting them would invent speed that was not there.

**Regression across sizes.** Transfer duration is roughly `overhead + bytes / rate`. Fitting duration
against size across a session recovers the rate while per-request overhead falls out as the intercept.
It is fitted only to transfers that had the link to themselves, since a request sharing the link tells
you how the capacity was divided, not what it was.

**Quiet moments for latency.** A request that waited while the page was already pulling bytes queued
behind the page's own traffic; its delay describes the page, not the link. Those samples are excluded
from the median and from jitter — but not from the round trip, which is a minimum, and queuing can
only ever inflate a reading.

**A lower bound, honestly labelled.** Nothing in passive measurement makes a link look faster than it
is; plenty makes it look slower. So the estimate reaches for the top of the observed distribution
rather than its middle, and every figure carries a confidence score.

## API

```ts
const freeloader = Freeloader.start(options);  // construct and start
const freeloader = new Freeloader(options);    // construct only; call freeloader.start()

freeloader.getEstimate(): NetworkEstimate      // current estimate, recomputed on change
freeloader.subscribe(fn): () => void           // called on every change; returns an unsubscribe
freeloader.reset(): void                       // forget everything, including the stored copy
freeloader.stop(): void                        // stop observing and un-patch fetch/XHR
freeloader.debug(): FreeloaderDebug            // counters, recent samples, reasons entries were skipped
freeloader.ingest(entry): void                 // feed a performance entry in by hand
freeloader.flush(): void                       // fold buffered entries in now
```

### Options

| Option | Default | |
|---|---|---|
| `storageKey` | `"freeloader"` | localStorage key. |
| `persist` | `true` | Keep the estimate across page views. |
| `maximumAgeMilliseconds` | 7 days | Ignore stored state older than this. |
| `halfLifeMilliseconds` | 24 hours | A sample's weight halves every this long. |
| `minimumSampleBytes` | 32768 | Transfers smaller than this are ignored for download and upload speed. They still count for latency. |
| `quantile` | `0.9` | Where in the weighted sample distribution to read the estimate. |
| `maximumSamples` | 100 | Throughput samples kept per direction. |
| `maximumLatencySamples` | 100 | Latency samples kept. |
| `mergeBursts` | `true` | Merge overlapping transfers. |
| `burstGapMilliseconds` | 30 | Gap still treated as one burst. |
| `slowStartCorrection` | `1` | How much of the ramp to subtract, 0–1. |
| `instrumentUploads` | `true` | Patch `fetch`/`XMLHttpRequest` to time request bodies. |
| `origins` | every origin | Restrict observation to these origins. |
| `onUpdate` | — | Called on every change. |
| `now`, `timeOrigin` | real clocks | Injectable clocks, for tests. |

### The estimate

```ts
interface NetworkEstimate {
  download: DirectionEstimate;   // bitsPerSecond, megabitsPerSecond, resources, confidence, peakBitsPerSecond, averageBitsPerSecond, regressionBitsPerSecond
  upload: DirectionEstimate;
  latency: LatencyEstimate;      // roundTripMilliseconds, timeToFirstByteMilliseconds, jitterMilliseconds, resources, confidence
  updatedAt: number;
}
```

`bitsPerSecond` is the estimate and sits *above* `averageBitsPerSecond` on purpose: every passive sample is a lower
bound, so the mean of what was seen understates the link while the estimate reaches for the top of
the distribution. `peakBitsPerSecond` is the fastest single burst.

`confidence.score` runs 0–1. Treat a figure with low confidence as "at least this fast" rather than as
a measurement.

## Privacy

- No requests are made. No data leaves the browser.
- Only transfer sizes and timings are read, never request or response contents.
- Upload instrumentation measures body *size*; bodies are never inspected or copied.
- State lives under one `localStorage` key and can be cleared with `freeloader.reset()`.

## The demo site

Eight pages, deliberately varied, with ~49 MB of assets generated locally by ffmpeg:

| Page | What it exercises |
|---|---|
| `/` | Hero image, live metrics |
| `/gallery.html` | Twelve parallel image loads — the burst case |
| `/media.html` | Ranged video streaming, two containers, a large prefetch |
| `/app.html` | Vendor bundles, JSON over fetch, XHR and fetch uploads |
| `/about.html` | A deliberately light page, where confidence should stay low |
| `/usage.html` | Install, options, recipes and debugging, with live metrics like every other page |
| `/network.html` | Full diagnostics, raw samples, skip reasons, stored state, graded against the last speed test |
| `/speedtest.html` | An active speed test over the site's own assets, to grade the passive estimate |

```bash
npm install
npm run assets        # generate images, video and bundles with ffmpeg
npm run build:site    # build site/freeloader.js and write the asset manifest
npm run serve         # or: node tools/dev-server.mjs --mbps 25 --latency 40 --jitter 8
```

The dev server hands out files and nothing else — it has no routes, because the demo needs none. Two optional flags
exist for development: `--base <path>` serves the site from a subdirectory, the way GitHub Pages
serves a project site, and `--mbps N` throttles everything through one shared token bucket so the
estimate can be compared against a known rate. Both are off by default.

The library itself is frontend-only and has no server component. On Windows the server's throughput
ceiling with `--mbps` is a few hundred Mbps, since throttling sleeps round up to the system timer
granularity.

### Deploying it

The demo is a static site. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds and
publishes it on every push to `main` or `master` — which includes every pull request merge, since a
merge is a push — after the tests, the typecheck and the build have passed. A failure stops the
deploy and leaves the current site up.

The workflow enables Pages itself on first run, so there is nothing to click. If your organisation
blocks that, set **Settings → Pages → Source → GitHub Actions** by hand once and re-run it. The live
URL is printed at the end of the run, and is `https://<user>.github.io/<repo>/` for a project site.

Three things make it work on a static host:

- **Every URL is relative.** GitHub Pages serves a project site from `/<repo>/`, so nothing may
  assume it lives at the root. Check it locally the way it will actually be served:

  ```bash
  node tools/dev-server.mjs --base SpeedTest
  ```

  which puts the whole demo under `http://localhost:8080/SpeedTest/`.

- **The assets are committed, not generated at deploy time.** `site/assets/generated/` is ~49 MB of
  ffmpeg output in the repository. CI regenerates only `assets/manifest.json` from the files that
  are actually there, so the sizes the speed test relies on are always the truth.

- **No page asks for anything a file server cannot answer.** The dashboard reads its rows from a
  static JSON file rather than an API, and `/network.html` grades the estimate against the last
  speed-test result out of `localStorage`. The upload buttons are the sole exception: they attempt a
  `POST`, and say plainly that a static host has no endpoint to accept a body when it fails — no
  probing on load, so a deployed page issues no request that can 404.

Verified by serving `site/` from a file server with no routes at all: every page loads, the speed
test completes, and not one request fails.

## Development

```bash
npm test
npm run typecheck
npm run build
```

The test suite covers the statistics primitives, timing-entry parsing, burst aggregation, persistence
(including corrupt, stale and foreign data), upload instrumentation against a fake `XMLHttpRequest`,
the estimator's behaviour under bias, and end-to-end accuracy against the simulated link.

## Licence

MIT.
