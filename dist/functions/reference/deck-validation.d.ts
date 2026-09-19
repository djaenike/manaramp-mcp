import { CardSummary } from '../query/cards.js';
import 'mongodb';

/**
 * functions/reference/deck-validation.ts (renamed from sub-tools/deck-building/consistency.ts,
 * 2026-09-17, sixth pass) -- PURE: takes already-fetched card data instead of querying Mongo
 * itself. It used to run its OWN `cards.find()` batch query, a THIRD independent implementation of
 * the same query functions/query/cards.ts's queryCards already does -- tools/shared/deck-analysis.ts (optimize_deck/publish_deck) calls
 * queryCards ONCE and passes the result in here, so there's exactly one place `cards` actually
 * gets queried.
 *
 * Validates deck size, singleton, color identity, Commander legality, and computes mana curve +
 * curve-out probability. Does NOT detect combos -- that's functions/reference/bracket-facts.ts's
 * job.
 */

interface DeckEntry {
    qty: number;
    name: string;
}
interface CardDetail {
    oracle_id: string;
    mana_cost: string;
    type_line: string;
    oracle_text: string;
    image_url: string | null;
    cmc: number;
}
interface ColorIdentityViolation {
    name: string;
    card_color_identity: string[];
    offending_colors: string[];
}
interface CommanderLegalityViolation {
    name: string;
    status: string;
}
interface DeckValidationResult {
    issues: string[];
    total_cards: number;
    land_count: number;
    nonland_count: number;
    avg_nonland_cmc: number;
    mana_curve: Record<string, number>;
    curve_out_probability: Record<string, number | string>;
    duplicate_violations: Array<{
        name: string;
        qty: number;
    }>;
    color_identity_violations: ColorIdentityViolation[];
    not_commander_legal: CommanderLegalityViolation[];
    not_found: string[];
    commander_color_identity: string[];
    card_details: Map<string, CardDetail>;
}
declare function combinations(n: number, k: number): number;
declare function hypergeometricAtLeast(librarySize: number, successes: number, draws: number, need: number): number;
/** `cards` is every card queryCards found for this decklist's names (commander_names +
 *  deck_entries' unique names) -- fetch it ONCE via queryCards before calling this. */
declare function validateDeck(cards: CardSummary[], commander_names: string[], deck_entries: DeckEntry[]): DeckValidationResult;

export { type CardDetail, type DeckEntry, type DeckValidationResult, combinations, hypergeometricAtLeast, validateDeck };
