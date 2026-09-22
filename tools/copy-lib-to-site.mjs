#!/usr/bin/env node
/** Copies the built library into the demo site, the way a user would drop it into theirs. */
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

for (const file of ["freeloader.ts", "freeloader.js", "freeloader.d.ts"]) {
  await copyFile(join(here, "..", "dist", file), join(here, "..", "site", file));
}
console.log("Copied freeloader.ts, freeloader.js and freeloader.d.ts -> site/");
