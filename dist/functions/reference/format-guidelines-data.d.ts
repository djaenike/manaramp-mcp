/**
 * functions/reference/format-guidelines-data.ts
 *
 * Backs tools/format-guidelines.ts. Two genuinely different kinds of data, kept clearly separate so
 * a caller never confuses one for the other:
 *
 *   1. COMMANDER_BRACKETS -- the REAL, official Commander Bracket System (Commander Format Panel),
 *      verified live against magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta
 *      on 2026-09-22, not paraphrased from memory. Re-verify there if a rule looks off or enough
 *      time has passed that a review cycle is likely (same "current as of" caveat
 *      bracket-reference-data.ts already carries for GAME_CHANGERS/etc, which this reuses).
 *   2. COMPOSITION_GUIDANCE -- NOT an official rule. General, widely-cited Commander deck-building
 *      consensus (land/ramp/draw/interaction counts for a 100-card deck) -- a reasonable starting
 *      point, not something WotC publishes or enforces. Every consumer of this data must keep that
 *      distinction visible (see format-guidelines.ts's own disclaimer field), the same way
 *      bracket_estimate has always been left to the calling model rather than computed here --
 *      numbers below are guidance to reason WITH, not a pass/fail gate.
 */
interface BracketRules {
    game_changers_allowed: number | null;
    two_card_combos: "none" | "no_early_game" | "unrestricted";
    mass_land_denial_allowed: boolean;
    extra_turns: "none" | "low_quantity_no_chaining" | "unrestricted";
    tutors: "sparse" | "unrestricted";
}
interface CommanderBracket {
    level: 1 | 2 | 3 | 4 | 5;
    name: string;
    experience: string;
    deck_building: string;
    rules: BracketRules;
}
declare const COMMANDER_BRACKETS: CommanderBracket[];
interface CompositionRange {
    min: number;
    max: number;
    note: string;
}
interface CompositionGuidance {
    disclaimer: string;
    lands: CompositionRange;
    ramp: CompositionRange;
    card_draw: CompositionRange;
    interaction: CompositionRange;
}
declare const COMMANDER_COMPOSITION_GUIDANCE: CompositionGuidance;

export { type BracketRules, COMMANDER_BRACKETS, COMMANDER_COMPOSITION_GUIDANCE, type CommanderBracket, type CompositionGuidance, type CompositionRange };
