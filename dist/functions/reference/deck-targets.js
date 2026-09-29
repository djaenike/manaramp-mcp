const TYPE_KEYS = ["Land", "Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker"];
const ROLE_GROUPS = {
  ramp: ["mana_rock", "mana_dork", "land_ramp"],
  card_draw: ["card_draw"],
  removal: ["removal"],
  mass_removal: ["mass_removal"],
  counterspell: ["counterspell"],
  protection: ["protection"],
  recursion: ["recursion"],
  tutor: ["tutor"],
  token_generator: ["token_generator"],
  buff: ["buff"]
};
const ROLE_SLOT_HINTS = {
  ramp: { cmc_max: 3 },
  card_draw: { cmc_max: 5 },
  removal: { cmc_max: 5 },
  counterspell: { cmc_max: 4 },
  protection: { cmc_max: 4 }
};
function deckSizeFor(format) {
  return format === "commander" || format === "brawl" ? 99 : 60;
}
function defaultTypeTargets(format) {
  return deckSizeFor(format) === 99 ? { Land: 37, Creature: 28, Instant: 10, Sorcery: 9, Artifact: 8, Enchantment: 6, Planeswalker: 1 } : { Land: 24, Creature: 20, Instant: 8, Sorcery: 4, Artifact: 2, Enchantment: 2, Planeswalker: 0 };
}
function defaultRoleTargets(format, colors) {
  const has = (c) => colors.includes(c);
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
      buff: 0
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
    buff: 0
  };
}
function resolveTargets(format, colors, stored) {
  const types = { ...defaultTypeTargets(format), ...stored.type_targets ?? {} };
  const roles = { ...defaultRoleTargets(format, colors), ...stored.role_targets ?? {} };
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
    source: stored.type_targets || stored.role_targets ? "user" : "default"
  };
}
export {
  ROLE_GROUPS,
  ROLE_SLOT_HINTS,
  TYPE_KEYS,
  deckSizeFor,
  defaultRoleTargets,
  defaultTypeTargets,
  resolveTargets
};
