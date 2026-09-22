#!/usr/bin/env node
/**
 * Writes the two static data files the demo needs when there is no server
 * behind it — on GitHub Pages there is only a CDN handing out files.
 *
 *   site/assets/manifest.json   what assets exist and exactly how big they are
 *   site/assets/data/rows.json  a frozen copy of the dashboard's API response
 *
 * The manifest is what makes an honest active speed test possible from a static
 * host: the test needs to know how many bytes it is about to pull before it
 * pulls them, and which files are safe to measure. Text files are marked
 * compressible, because a CDN gzips them and the browser would then count more
 * bytes than crossed the wire.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "site");
const generatedDir = join(siteDir, "assets", "generated");

const TYPES = {
  ".jpg": { type: "image/jpeg", compressible: false },
  ".jpeg": { type: "image/jpeg", compressible: false },
  ".png": { type: "image/png", compressible: false },
  ".webp": { type: "image/webp", compressible: false },
  ".mp4": { type: "video/mp4", compressible: false },
  ".webm": { type: "video/webm", compressible: false },
  ".js": { type: "text/javascript", compressible: true },
  ".json": { type: "application/json", compressible: true },
};

/**
 * The same fabricated rows the dev server invents, frozen to a file so the
 * dashboard has something to render on a static host. Deterministic, so
 * regenerating does not churn the diff.
 */
function makeRows(count, seed) {
  const regions = ["us-east", "us-west", "eu-west", "eu-north", "ap-south", "sa-east"];
  const rows = [];
  for (let i = 0; i < count; i++) {
    const n = (seed + i * 7919) % 100000;
    rows.push({
      id: `evt-${seed}-${i}`,
      region: regions[n % regions.length],
      requests: 1000 + (n % 90000),
      p95Ms: 20 + (n % 380),
      errorRate: Number(((n % 500) / 10000).toFixed(4)),
      // Minutes before an arbitrary fixed instant: a static file cannot know
      // "now", and the page relabels these on load anyway.
      offsetMinutes: i,
    });
  }
  return rows;
}

async function main() {
  let names = [];
  try {
    names = (await readdir(generatedDir)).sort();
  } catch {
    console.error("site/assets/generated is missing. Run `npm run assets` first.");
    process.exitCode = 1;
    return;
  }

  const files = [];
  for (const name of names) {
    const ext = extname(name).toLowerCase();
    const known = TYPES[ext];
    if (!known) continue;
    const info = await stat(join(generatedDir, name));
    files.push({
      // Relative to the site root, so the manifest works from any base path.
      path: `assets/generated/${name}`,
      bytes: info.size,
      type: known.type,
      compressible: known.compressible,
    });
  }

  if (files.length === 0) {
    console.error("No assets found in site/assets/generated. Run `npm run assets` first.");
    process.exitCode = 1;
    return;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
  await writeFile(join(siteDir, "assets", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // One file per size the dashboard offers. Slicing a single file client-side
  // would move the same bytes either way, which would make the buttons a lie:
  // the whole point of the pair is that one is a small fetch and one is a big
  // one.
  await mkdir(join(siteDir, "assets", "data"), { recursive: true });
  const rowCounts = [200, 2000];
  const rowFiles = [];
  for (const count of rowCounts) {
    const name = `rows-${count}.json`;
    await writeFile(join(siteDir, "assets", "data", name), JSON.stringify({ rows: makeRows(count, 1) }), "utf8");
    rowFiles.push({ name, bytes: (await stat(join(siteDir, "assets", "data", name))).size });
  }

  const mb = (manifest.totalBytes / 1024 / 1024).toFixed(1);
  const measurable = files.filter((file) => !file.compressible);
  const measurableMb = (measurable.reduce((sum, file) => sum + file.bytes, 0) / 1024 / 1024).toFixed(1);
  console.log(`manifest.json: ${files.length} files, ${mb} MB (${measurableMb} MB measurable)`);
  for (const file of rowFiles) console.log(`${file.name}: ${(file.bytes / 1024).toFixed(0)} KB`);
}

await main();
