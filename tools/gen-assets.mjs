#!/usr/bin/env node
/**
 * Generates the demo site's heavy assets with ffmpeg.
 *
 * The demo needs real images and real video, because the whole point of the
 * library is that it learns from the bytes a page was already going to move.
 * Everything lands in site/assets/generated/, which is gitignored.
 */
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "site", "assets", "generated");

const IMAGES = [
  { name: "hero.jpg", filter: "mandelbrot=size=2400x1200", quality: 2 },
  { name: "gallery-01.jpg", filter: "testsrc2=size=1800x1200", quality: 2 },
  { name: "gallery-02.jpg", filter: "mandelbrot=size=1600x1200:maxiter=400", quality: 3 },
  { name: "gallery-03.jpg", filter: "cellauto=size=1600x1200:rule=110", quality: 2 },
  { name: "gallery-04.jpg", filter: "life=size=1600x1200:mold=10:ratio=0.3", quality: 2 },
  { name: "gallery-05.jpg", filter: "testsrc2=size=2000x1400", quality: 2 },
  { name: "gallery-06.jpg", filter: "mandelbrot=size=2000x1400:maxiter=800", quality: 2 },
  { name: "gallery-07.jpg", filter: "rgbtestsrc=size=1600x1200", quality: 2 },
  { name: "gallery-08.jpg", filter: "cellauto=size=2000x1400:rule=30", quality: 2 },
  { name: "gallery-09.jpg", filter: "gradients=size=1800x1200:nb_colors=7", quality: 2 },
  { name: "gallery-10.jpg", filter: "mandelbrot=size=1400x1000:maxiter=200", quality: 4 },
  { name: "gallery-11.jpg", filter: "life=size=1400x1000:ratio=0.5", quality: 3 },
  { name: "gallery-12.jpg", filter: "testsrc2=size=1200x900", quality: 4 },
  { name: "thumb-a.jpg", filter: "testsrc2=size=600x400", quality: 6 },
  { name: "thumb-b.jpg", filter: "mandelbrot=size=600x400", quality: 6 },
  { name: "thumb-c.jpg", filter: "gradients=size=600x400", quality: 6 },
];

const VIDEOS = [
  {
    name: "clip-720p.mp4",
    args: [
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "24", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
    ],
  },
  {
    name: "clip-1080p.mp4",
    args: [
      "-f", "lavfi", "-i", "mandelbrot=size=1920x1080:rate=30",
      "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ],
  },
  {
    name: "loop-480p.webm",
    args: [
      "-f", "lavfi", "-i", "life=size=854x480:rate=25:mold=10",
      "-t", "12", "-c:v", "libvpx-vp9", "-b:v", "1200k", "-deadline", "realtime", "-cpu-used", "8",
    ],
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function generateImage({ name, filter, quality }) {
  const out = join(outDir, name);
  if (await exists(out)) return { name, skipped: true };
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", filter, "-frames:v", "1", "-q:v", String(quality), out]);
  return { name, bytes: (await stat(out)).size };
}

async function generateVideo({ name, args }) {
  const out = join(outDir, name);
  if (await exists(out)) return { name, skipped: true };
  await run("ffmpeg", ["-y", ...args, out], { maxBuffer: 64 * 1024 * 1024 });
  return { name, bytes: (await stat(out)).size };
}

/**
 * A chunky but genuinely parseable script, standing in for the kind of vendor
 * bundle a real site ships. Deterministic, so rebuilds do not churn.
 */
async function generateBundle(name, approxBytes) {
  const out = join(outDir, name);
  if (await exists(out)) return { name, skipped: true };
  const parts = [`/* Demo bundle: ${name}. Generated, inert, safe to ignore. */`, "window.__demoBundles = (window.__demoBundles || []).concat("];
  parts.push(JSON.stringify(name) + ");");
  let i = 0;
  while (parts.join("\n").length < approxBytes) {
    parts.push(
      `export function helper_${i}(input) {\n` +
        `  // Filler routine ${i}: does a little arithmetic so the parser has real work.\n` +
        `  const scaled = (input ?? ${i}) * ${(i % 97) + 1} + ${i * 31};\n` +
        `  return scaled % ${(i % 13) + 7} === 0 ? scaled : scaled - ${i};\n` +
        `}`,
    );
    i++;
  }
  await writeFile(out, parts.join("\n"), "utf8");
  return { name, bytes: (await stat(out)).size };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    console.error("ffmpeg is required to generate the demo assets. Install it and re-run.");
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const image of IMAGES) results.push(await generateImage(image));
  for (const video of VIDEOS) results.push(await generateVideo(video));
  results.push(await generateBundle("vendor-charts.js", 420_000));
  results.push(await generateBundle("vendor-icons.js", 180_000));
  results.push(await generateBundle("vendor-editor.js", 900_000));

  let total = 0;
  for (const result of results) {
    if (result.skipped) {
      console.log(`  = ${result.name} (already present)`);
      continue;
    }
    total += result.bytes;
    console.log(`  + ${result.name} ${(result.bytes / 1024).toFixed(0)} KB`);
  }
  console.log(`\nGenerated ${(total / 1024 / 1024).toFixed(1)} MB into site/assets/generated/`);
}

await main();
