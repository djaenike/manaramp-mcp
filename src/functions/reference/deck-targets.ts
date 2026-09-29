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

export const TYPE_KEYS = ["Land", "Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker"] as const;

/** Role slider key -> the stored role_flags it counts. */
export const ROLE_GROUPS: Record<string, string[]> = {
  ramp: ["mana_rock", "mana_dork", "land_ramp"],
  card_draw: ["card_draw"],
  removal: ["removal"],
  mass_removal: ["mass_removal"],
  counterspell: ["counterspell"],
  protection: ["protection"],
  recursion: ["recursion"],
  tutor: ["tutor"],
  token_generator: ["token_generator"],
  buff: ["buff"],
};

/** Extra filters for a core slot, so "ramp" means cheap ramp, not a 7-drop that happens to make mana. */
export const ROLE_SLOT_HINTS: Record<string, Record<string, unknown>> = {
  ramp: { cmc_max: 3 },
  card_draw: { cmc_max: 5 },
  removal: { cmc_max: 5 },
  counterspell: { cmc_max: 4 },
  protection: { cmc_max: 4 },
};

/** Non-commander cards in the deck. */
export function deckSizeFor(format: string): number {
  return format === "commander" || format === "brawl" ? 99 : 60;
}

export function defaultTypeTargets(format: string): Record<string, number> {
  return deckSizeFor(format) === 99
    ? { Land: 37, Creature: 28, Instant: 10, Sorcery: 9, Artifact: 8, Enchantment: 6, Planeswalker: 1 }
    : { Land: 24, Creature: 20, Instant: 8, Sorcery: 4, Artifact: 2, Enchantment: 2, Planeswalker: 0 };
}

/** Color-aware: counterspells only when blue is available, recursion leans black/green. */
export function defaultRoleTargets(format: string, colors: string[]): Record<string, number> {
  const has = (c: string) => colors.includes(c);
  if (deckSizeFor(format) === 99) {
    return {
      ramp: 10,
      card_draw: 10,
      removal: 8,
      mass_removal: 3,
      counterspell: has("U") ? 3 : 0,
      protection: 2,
      recursion: has("B") || has("G") ? 2 : 0,
      tutor: 0,
      token_generator: 0,
      buff: 0,
    };
  }
  return {
    ramp: has("G") ? 4 : 0,
    card_draw: 4,
    removal: 6,
    mass_removal: 1,
    counterspell: has("U") ? 3 : 0,
    protection: 0,
    recursion: 0,
    tutor: 0,
    token_generator: 0,
    buff: 0,
  };
}

/** The deck's effective targets: the user's where set, defaults otherwise. */
export function resolveTargets(format: string, colors: string[], stored: { type_targets?: Record<string, number> | null; role_targets?: Record<string, number> | null }) {
  const types = { ...defaultTypeTargets(format), ...(stored.type_targets ?? {}) };
  const roles = { ...defaultRoleTargets(format, colors), ...(stored.role_targets ?? {}) };
  const deckSize = deckSizeFor(format);
  const spellSlots = deckSize - (types.Land ?? 0);
  const roleTotal = Object.values(roles).reduce((a, b) => a + b, 0);
  return {
    deck_size: deckSize,
    types,
    roles,
    spell_slots: spellSlots,
    /** Rough count the AI's theme slots should add up to -- the server fills the rest. Role cards the
     *  theme picks already do (a token maker that draws) count toward the role, so this is a floor. */
    theme_slots_budget: Math.max(10, spellSlots - roleTotal),
    source: stored.type_targets || stored.role_targets ? "user" : "default",
  };
}
