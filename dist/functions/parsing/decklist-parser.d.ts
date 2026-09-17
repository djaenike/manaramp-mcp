import { DeckEntry } from '../reference/deck-validation.js';
import '../query/cards.js';
import 'mongodb';

/**
 * functions/decklist-parser.ts -- pure text parsing, no Mongo access. Moved from playtest/state.ts
 * (2026-09-17, fourth pass), then from sub-tools/deck-building/ into functions/ (fifth pass, when
 * sub-tools/ was retired -- see CLAUDE.md's tool-consolidation section). The "playtest" folder/
 * naming was a leftover from when this repo also hosted the playtest-table feature (moved to the
 * `manaramp` repo 2026-09-12, then the local glue code itself removed entirely once its last real
 * caller was deleted). parsePlaytestDecklist (renamed parseDecklistText) was the one piece of that
 * area still actually used -- by manage-deck.ts, to turn pasted decklist text into structured
 * names. summarizeState (playtest live-game-state formatting) had zero remaining callers and was
 * dropped, not moved.
 */

interface ParsedDecklist {
    commanderNames: string[];
    deckEntries: DeckEntry[];
}
declare function parseDecklistText(text: string): ParsedDecklist;

export { type ParsedDecklist, parseDecklistText };
