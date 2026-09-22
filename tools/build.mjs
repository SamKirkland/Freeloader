#!/usr/bin/env node
/**
 * Builds the three files a user downloads: freeloader.ts, freeloader.js and
 * freeloader.d.ts. The source ends with exports that only the tests need, and
 * those are cut before anything is written. Each file opens with a banner
 * naming the version and where it came from, since copies get passed around
 * far from this repository.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "src", "freeloader.ts");
const dist = join(here, "..", "dist");
const TEST_EXPORTS = "// Exported for the test suite only.";

const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
const repo = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
// `/*!` survives minifiers, so the banner stays on the file wherever it ends up.
const banner = [
  "/*!",
  ` * Freeloader v${pkg.version}`,
  ` * ${pkg.description}`,
  " *",
  ` * Source, docs and updates: ${repo}`,
  ` * Report issues: ${pkg.bugs.url}`,
  ` * @license ${pkg.license} (c) ${pkg.author}`,
  " */",
  "",
].join("\n");

const text = await readFile(source, "utf8");
const cut = text.indexOf(TEST_EXPORTS);
if (cut === -1) throw new Error(`Expected "${TEST_EXPORTS}" in src/freeloader.ts`);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const shipped = join(dist, "freeloader.ts");
await writeFile(shipped, banner + "\n" + text.slice(0, cut).trimEnd() + "\n");

const program = ts.createProgram([shipped], {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  declaration: true,
  outDir: dist,
});
const result = program.emit();
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
if (diagnostics.length > 0) {
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" };
  console.error(ts.formatDiagnostics(diagnostics, host));
  process.exit(1);
}
// tsc keeps a detached header comment on its own, but check rather than trust it.
for (const file of ["freeloader.js", "freeloader.d.ts"]) {
  const path = join(dist, file);
  const emitted = await readFile(path, "utf8");
  if (!emitted.startsWith(banner)) await writeFile(path, banner + "\n" + emitted);
}
console.log("Built dist/freeloader.ts, freeloader.js and freeloader.d.ts");
