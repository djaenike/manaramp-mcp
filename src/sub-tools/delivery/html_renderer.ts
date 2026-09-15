/**
 * sub-tools/delivery/html_renderer.ts
 * Merges real deck data into deck_report_template.html server-side and returns one
 * complete, ready-to-show HTML string. Deliberately NOT left to the calling Claude
 * model to reconstruct from the template each time -- that risks drift from the
 * actual styling/behavior in the template file. The template itself stays the one
 * place layout/interaction logic lives; this just swaps its placeholder DECK_DATA
 * for the real thing.
 *
 * NOTE for a future remote (Workers) transport: this reads the template from disk via
 * readFileSync, relative to this file's own location on disk (import.meta.url) -- that
 * works for a local stdio process, but Cloudflare Workers has no filesystem. A remote
 * path will need to swap this for a bundled template string (e.g. imported as a JS string
 * constant) instead of a runtime file read. Left as-is deliberately for this pass -- see
 * tools/shared/run-checks-and-deliver.ts's own header comment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "deck_report_template.html");

const BOILERPLATE_COMMENT_PATTERN = /<!--\s*BOILERPLATE[\s\S]*?-->\n?/;
const DECK_DATA_BLOCK_PATTERN = /const DECK_DATA = \{[\s\S]*?renderDeckReport\(DECK_DATA\);/;

function renderDeckReportHtml(userDefinedScope: unknown, actualOutput: unknown): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  if (!BOILERPLATE_COMMENT_PATTERN.test(template) || !DECK_DATA_BLOCK_PATTERN.test(template)) {
    throw new Error(
      "deck_report_template.html doesn't match the expected shape (missing the boilerplate " +
      "comment or the DECK_DATA/renderDeckReport block) -- html_renderer.js's anchors need updating."
    );
  }

  const dataJson = JSON.stringify({ userDefinedScope, actualOutput });
  const withoutBoilerplateComment = template.replace(BOILERPLATE_COMMENT_PATTERN, "");
  const rendered = withoutBoilerplateComment.replace(
    DECK_DATA_BLOCK_PATTERN,
    `const DECK_DATA = ${dataJson};\nrenderDeckReport(DECK_DATA);`
  );

  return rendered;
}

export { renderDeckReportHtml };
