import { Db } from 'mongodb';
import { ComboResult } from '../query/combos.js';
import { CardSummary } from '../query/cards.js';

/**
 * functions/reference/bracket-facts.ts (moved from sub-tools/bracket/facts.ts, 2026-09-17, sixth
 * pass, functions/ split into parsing/push/query/reference subfolders)
 *
 * Gathers the raw facts the Commander Bracket System cares about -- which Game Changers/mass land
 * denial/extra-turn cards are present, and which combos are fully assembled -- WITHOUT deciding a
 * bracket label. That decision is the calling model's job, same as wincon_summary/general_strategy
 * -- see manage-deck.ts's bracket_estimate input field. This file only ever answers "what's
 * actually in this deck," never "what bracket is that." Calls functions/query/combos.ts's
 * queryCombos for the combo-detection step -- not a separate `combos` query of its own.
 *
 * tutors_found/land_ramp_found/extra_land_drops_found/token_generators_found/counterspells_found/
 * recursion_found (2026-09-17, added alongside the new Forge-derived abilities booleans -- see
 * schema/cards.ts in the `manaramp` repo) work the same way as game_changers_found/etc, just backed
 * by Forge's own per-card classification instead of a hardcoded name list. Takes the already-fetched
 * `cards` from manage-deck.ts's own queryCards call (it needs the SAME card data manage-deck.ts
 * already has for consistency checks/pricing) instead of running a second independent `cards` query
 * -- one canonical query per collection per call, same rule as everywhere else in this package.
 */

interface DeckFacts {
    game_changers_found: string[];
    mass_land_denial_found: string[];
    extra_turns_found: string[];
    combos_found: ComboResult[];
    tutors_found: string[];
    land_ramp_found: string[];
    extra_land_drops_found: string[];
    token_generators_found: string[];
    counterspells_found: string[];
    recursion_found: string[];
}
declare function gatherDeckFacts(db: Db, commanderNames: string[], cardNames: string[], cards: CardSummary[]): Promise<DeckFacts>;

export { type DeckFacts, gatherDeckFacts };
