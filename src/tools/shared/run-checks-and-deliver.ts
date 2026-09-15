/**
 * tools/shared/run-checks-and-deliver.ts
 *
 * Shared by both deck-building tools (new_deck_creation / existing_deck_cleanup) -- defined here,
 * not tucked further down, specifically so the full check -> build report -> render sequence stays
 * visible to anyone reading this file, rather than hidden a layer down the way the old
 * deliver_finished_deck.js orchestrator was.
 *
 * PLAYTEST TABLE CREATION IS TEMPORARILY DISABLED (see sub-tools/delivery/create_playtest_room.ts
 * and sub-tools/playtest/* -- code is untouched, just not called from here). The playtest server
 * is buggy and needs more work; focus for now is the core MCP structure. Re-add a call to
 * createPlaytestRoom() once that's ready -- this function's shape (consistency/bracket/price ->
 * build report -> render) is unaffected by that, so wiring it back in later is a small, localized
 * edit here (e.g. threading a room_url into actualOutput/the rendered HTML).
 *
 * There is no "blocked" gate here: a decklist that parses (a Commander and a Deck section were
 * found) always gets a full report, even if consistency checks failed. deck_report_template.html
 * has a built-in issue banner for exactly that case -- surfacing problems in the delivered report
 * is more useful than refusing to deliver one. The only hard stop is a genuine parse failure,
 * where there's nothing coherent to report on at all.
 *
 * FUTURE REMOTE (Workers) TRANSPORT NOTE (not part of this pass -- see repo CLAUDE.md): TWO steps
 * below are genuinely local-machine-only and will need to change for a future remote MCP endpoint
 * (planned to live in the sibling `manaramp` Cloudflare Workers repo, importing these same tool
 * definitions): (1) renderDeckReportHtml (in html_renderer.ts) reads deck_report_template.html off
 * disk via readFileSync relative to its own compiled file location -- Workers has no filesystem, so
 * that will need to become a bundled template string instead. (2) writeReportFile below writes the
 * rendered HTML to a real file in the user's Downloads folder -- also filesystem-dependent, and
 * also not something a Workers request/response cycle can do; a remote path would drop the local
 * file entirely and rely on html_report alone. Both are kept EXACTLY as they behaved in the
 * original plain-JS index.js in this pass -- this is a TypeScript/structure conversion only, not an
 * attempt to make either of these Workers-compatible yet.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parsePlaytestDecklist } from "../../sub-tools/playtest/state.js";
import { computeDeckConsistency } from "../../sub-tools/deck-building/consistency.js";
import { computeBracketRating } from "../../sub-tools/bracket/rating.js";
import { computeDeckPriceTotal } from "../../sub-tools/cardkingdom/pricing.js";
import { buildActualOutput, type ActualOutput } from "../../sub-tools/delivery/report_data.js";
import { renderDeckReportHtml } from "../../sub-tools/delivery/html_renderer.js";

interface RunChecksAndDeliverArgs {
  decklist_text: string;
  deck_name: string;
  deck_design_preference?: string;
  deck_type?: string;
  price_limit_usd?: number;
  bracket_level_requested?: string;
  user_color_preference?: string[];
  user_commander_preference?: string | null;
  wincon_summary: string;
  general_strategy: string;
}

interface RunChecksAndDeliverBlockedResult {
  blocked: true;
  reason: string;
}

interface RunChecksAndDeliverSuccessResult {
  blocked: false;
  user_defined_scope: {
    deckDesignPreference: string | null;
    deckType: string;
    priceLimitUsd: number | null;
    bracketLevel: string | null;
    userColorPreference: string[] | null;
    userCommanderPreference: string | null;
  };
  actual_output: ActualOutput;
  html_report: string;
  report_path: string | null;
}

type RunChecksAndDeliverResult = RunChecksAndDeliverBlockedResult | RunChecksAndDeliverSuccessResult;

// --- Report file output ----------------------------------------------------------------------
// Every rendered report also gets written to a real file -- this is how a Claude Desktop user (no
// Artifact/live-HTML rendering in its chat window) actually VIEWS the report: open report_path in
// a real browser, where plain https:// image URLs load with no restriction at all. That's also
// why images are NOT base64-inlined into html_report/actual_output (see report_data.ts's comment)
// -- a real browser opening a local file doesn't need that workaround, and inlining blew the MCP
// tool response well past its ~1MB cap for a full decklist.
//
// Deliberately NOT written next to this file: this server is meant to run packaged (.mcpb) on a
// machine that may not be the one it was built on, so "next to this module" isn't a folder the
// user can necessarily find or write to. The user's Downloads folder is a stable, always-writable,
// always-discoverable location on any machine regardless of where the server itself is installed
// -- a dedicated subfolder there keeps it from scattering loose report files into Downloads' root.
// SCRYFALL_MCP_REPORTS_DIR overrides this (used by tests, so test runs don't touch a real
// Downloads folder).
const REPORTS_DIR = process.env.SCRYFALL_MCP_REPORTS_DIR || join(homedir(), "Downloads", "MTG Deck Reports");

function slugifyFilename(name?: string | null): string {
  return (name || "deck").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
}

function writeReportFile(deckName: string, html: string): string | null {
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(REPORTS_DIR, `${slugifyFilename(deckName)}-${timestamp}.html`);
    writeFileSync(path, html);
    return path;
  } catch {
    return null; // a filesystem hiccup shouldn't take down report delivery -- html_report is still returned directly
  }
}

async function runChecksAndDeliver({
  decklist_text, deck_name, deck_design_preference, deck_type, price_limit_usd, bracket_level_requested,
  user_color_preference, user_commander_preference, wincon_summary, general_strategy,
}: RunChecksAndDeliverArgs): Promise<RunChecksAndDeliverResult> {
  const { commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text);
  if (!commanderNames.length || !deckEntries.length) {
    return { blocked: true, reason: "Couldn't parse a commander and deck from decklist_text — check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting." };
  }

  const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
  const allCopiesNames = [...commanderNames, ...deckEntries.flatMap((e) => Array(e.qty).fill(e.name))];

  const [consistency, bracket, price] = await Promise.all([
    computeDeckConsistency(commanderNames, deckEntries),
    computeBracketRating(commanderNames, uniqueDeckNames),
    computeDeckPriceTotal(allCopiesNames, false),
  ]);

  const userDefinedScope = {
    deckDesignPreference: deck_design_preference ?? null,
    deckType: deck_type ?? "commander",
    priceLimitUsd: price_limit_usd ?? null,
    bracketLevel: bracket_level_requested ?? null,
    userColorPreference: user_color_preference ?? null,
    userCommanderPreference: user_commander_preference ?? null,
  };

  const actualOutput = buildActualOutput({
    commanderNames, deckEntries, decklistText: decklist_text,
    consistency, bracket, price, wincon_summary, general_strategy, bracket_level_requested,
  });

  const htmlReport = renderDeckReportHtml(userDefinedScope, actualOutput);
  const reportPath = writeReportFile(deck_name, htmlReport);

  return {
    blocked: false, user_defined_scope: userDefinedScope, actual_output: actualOutput,
    html_report: htmlReport, report_path: reportPath,
  };
}

export { runChecksAndDeliver };
export type { RunChecksAndDeliverArgs, RunChecksAndDeliverResult };
