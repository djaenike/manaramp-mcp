/**
 * sub-tools/delivery/html_renderer.js
 * Merges real deck data into deck_report_template.html server-side and returns one
 * complete, ready-to-show HTML string. Deliberately NOT left to the calling Claude
 * model to reconstruct from the template each time -- that risks drift from the
 * actual styling/behavior in the template file. The template itself stays the one
 * place layout/interaction logic lives; this just swaps its placeholder DECK_DATA
 * for the real thing.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "deck_report_template.html");

const BOILERPLATE_COMMENT_PATTERN = /<!--\s*BOILERPLATE[\s\S]*?-->\n?/;
const DECK_DATA_BLOCK_PATTERN = /const DECK_DATA = \{[\s\S]*?renderDeckReport\(DECK_DATA\);/;

function renderDeckReportHtml(userDefinedScope, actualOutput) {
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
