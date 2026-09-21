import { Db } from 'mongodb';
import { DeckValidationResult } from '../../functions/reference/deck-validation.js';
import { DeckFacts } from '../../functions/reference/bracket-facts.js';
import '../../functions/query/cards.js';
import '../../functions/query/combos.js';

/**
 * tools/shared/deck-analysis.ts
 *
 * Shared analysis pipeline for optimize_deck (analyze/propose, never persists) and publish_deck
 * (persists, so re-runs this same analysis first to get fresh facts rather than trusting whatever
 * optimize_deck last returned -- the decklist may have changed in between). Extracted so the two
 * tools can't drift apart on what "the facts" actually are -- this is now the ONE place that parses
 * a decklist, runs the single queryCards batch, and gathers consistency + bracket facts, same "one
 * canonical query per collection per call" rule as functions/query/cards.ts itself follows.
 *
 * This is a straight split of what manage-deck.ts used to do inline, up through -- but not
 * including -- persistence (that part is publish_deck's own job now, via functions/push/deck.ts).
 */

interface DeckAnalysis {
    commanderNames: string[];
    deckEntries: Array<{
        qty: number;
        name: string;
    }>;
    consistency: DeckValidationResult;
    facts: DeckFacts;
    priceTotal: number;
    cardsNotPriced: string[];
    totalCards: number;
}
/** Throws a plain Error with a user-facing message on a decklist that couldn't even be parsed --
 *  both callers turn that into their own tool-response shape rather than a thrown exception
 *  reaching the MCP transport. `priceSource` (2026-09-21, defaults to 'cardkingdom' -- both callers
 *  resolve it from ctx.getPriceSourcePreference?.() and pass it in, falling back the same way for a
 *  legacy account with no preference saved or a local-stdio call with no such getter at all -- see
 *  tools/types.ts's McpContext for the full reasoning) decides which market priceTotal normalizes
 *  to, via queryCards's own priceSource param. */
declare function analyzeDecklist(readDb: Db, decklist_text: string, priceSource?: "cardkingdom" | "manapool"): Promise<DeckAnalysis>;
/** Shared by optimize_deck and publish_deck's own bracket_level_matches_request field. */
declare function extractBracketNumber(s: unknown): string | null;

export { type DeckAnalysis, analyzeDecklist, extractBracketNumber };
