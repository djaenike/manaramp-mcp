// Copies non-.ts assets tsup doesn't touch into dist/, next to their compiled .js counterparts --
// specifically deck_report_template.html/.json, which sub-tools/delivery/html_renderer.ts reads
// from disk relative to its OWN compiled file location (import.meta.url), not bundled in as a
// string. Run automatically as part of `npm run build` (see package.json).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [
  "sub-tools/delivery/deck_report_template.html",
  "sub-tools/delivery/deck_report_template.json",
];

for (const relPath of assets) {
  const src = join(repoRoot, "src", relPath);
  const dest = join(repoRoot, "dist", relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${relPath} -> dist/`);
}
