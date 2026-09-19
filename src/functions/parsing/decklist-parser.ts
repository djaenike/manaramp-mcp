/**
 * functions/decklist-parser.ts -- pure text parsing, no Mongo access. Moved from playtest/state.ts
 * (2026-09-17, fourth pass), then from sub-tools/deck-building/ into functions/ (fifth pass, when
 * sub-tools/ was retired -- see CLAUDE.md's tool-consolidation section). The "playtest" folder/
 * naming was a leftover from when this repo also hosted the playtest-table feature (moved to the
 * `manaramp` repo 2026-09-12, then the local glue code itself removed entirely once its last real
 * caller was deleted). parsePlaytestDecklist (renamed parseDecklistText) was the one piece of that
 * area still actually used -- by tools/shared/deck-analysis.ts (optimize_deck/publish_deck), to turn pasted decklist text into structured
 * names. summarizeState (playtest live-game-state formatting) had zero remaining callers and was
 * dropped, not moved.
 */

import type { DeckEntry } from "../reference/deck-validation.js";

interface ParsedDecklist {
  commanderNames: string[];
  deckEntries: DeckEntry[];
}

function parseDecklistText(text: string): ParsedDecklist {
  const lines = text.split(/\r?\n/);
  let section = "deck";
  const commanderNames: string[] = [];
  const deckEntries: DeckEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)x?\s+(.+)$/i);
    if (!m) {
      const lower = line.toLowerCase();
      if (lower.startsWith("commander")) section = "commander";
      else if (lower.startsWith("sideboard")) section = "sideboard";
      else if (lower.startsWith("deck") || lower.startsWith("mainboard")) section = "deck";
      continue;
    }
    const qty = parseInt(m[1], 10);
    const name = m[2].trim();
    if (section === "commander") commanderNames.push(name);
    else if (section === "deck") deckEntries.push({ qty, name });
  }
  return { commanderNames, deckEntries };
}

export { parseDecklistText };
export type { ParsedDecklist };
