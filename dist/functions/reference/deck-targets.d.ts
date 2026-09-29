/**
 * functions/reference/deck-targets.ts
 *
 * Deck-shape targets (2026-09-28): how many of each card type and each role a deck aims for. The
 * user can set them on manaramp's Create with AI sliders (stored on the deck prompt as type_targets /
 * role_targets); otherwise these defaults apply. fill_deck_plan fills the "standard core" to these
 * targets server-side -- the AI only writes the theme slots -- which is most of the speed-up: the
 * model no longer spends a thousand output tokens restating "10 ramp, 10 draw, 8 removal, 37 lands".
 *
 * manaramp's $lib/deck-targets.ts carries the same keys and defaults for the sliders -- keep in sync.
 */
declare const TYPE_KEYS: readonly ["Land", "Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker"];
/** Role slider key -> the stored role_flags it counts. */
declare const ROLE_GROUPS: Record<string, string[]>;
/** Extra filters for a core slot, so "ramp" means cheap ramp, not a 7-drop that happens to make mana. */
declare const ROLE_SLOT_HINTS: Record<string, Record<string, unknown>>;
/** Non-commander cards in the deck. */
declare function deckSizeFor(format: string): number;
declare function defaultTypeTargets(format: string): Record<string, number>;
/** Color-aware: counterspells only when blue is available, recursion leans black/green. */
declare function defaultRoleTargets(format: string, colors: string[]): Record<string, number>;
/** The deck's effective targets: the user's where set, defaults otherwise. */
declare function resolveTargets(format: string, colors: string[], stored: {
    type_targets?: Record<string, number> | null;
    role_targets?: Record<string, number> | null;
}): {
    deck_size: number;
    types: {
        [x: string]: number;
    };
    roles: {
        [x: string]: number;
    };
    spell_slots: number;
    /** Rough count the AI's theme slots should add up to -- the server fills the rest. Role cards the
     *  theme picks already do (a token maker that draws) count toward the role, so this is a floor. */
    theme_slots_budget: number;
    source: string;
};

export { ROLE_GROUPS, ROLE_SLOT_HINTS, TYPE_KEYS, deckSizeFor, defaultRoleTargets, defaultTypeTargets, resolveTargets };
