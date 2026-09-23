const COMMANDER_BRACKETS = [
  {
    level: 1,
    name: "Exhibition",
    experience: "Throw down with your ultra-casual Commander deck! Winning is secondary; focus is on unusual themes.",
    deck_building: "No cards from the Game Changers list. No intentional two-card infinite combos, mass land denial, or extra-turn cards. Tutors should be sparse.",
    rules: { game_changers_allowed: 0, two_card_combos: "none", mass_land_denial_allowed: false, extra_turns: "none", tutors: "sparse" }
  },
  {
    level: 2,
    name: "Core",
    experience: "The average current preconstructed deck is at a Core (Bracket 2) level -- strong engines but not optimized. Games typically last 9+ turns.",
    deck_building: "No cards from the Game Changers list. No intentional two-card infinite combos or mass land denial. Extra-turn cards should only appear in low quantities and are not intended to be chained in succession or looped. Tutors should be sparse.",
    rules: { game_changers_allowed: 0, two_card_combos: "none", mass_land_denial_allowed: false, extra_turns: "low_quantity_no_chaining", tutors: "sparse" }
  },
  {
    level: 3,
    name: "Upgraded",
    experience: "Souped up and ready to play beyond the strength of an average preconstructed deck. Games end a turn or two sooner than Bracket 2.",
    deck_building: "Up to three cards from the Game Changers list. No intentional early-game two-card infinite combos. Extra-turn cards should only appear in low quantities and are not intended to be chained in succession or looped. No mass land denial.",
    rules: { game_changers_allowed: 3, two_card_combos: "no_early_game", mass_land_denial_allowed: false, extra_turns: "low_quantity_no_chaining", tutors: "unrestricted" }
  },
  {
    level: 4,
    name: "Optimized",
    experience: "Bring out your strongest decks and cards. Expect explosive starts and games ending quickly.",
    deck_building: "There are no restrictions (other than the banned list).",
    rules: { game_changers_allowed: null, two_card_combos: "unrestricted", mass_land_denial_allowed: true, extra_turns: "unrestricted", tutors: "unrestricted" }
  },
  {
    level: 5,
    name: "cEDH",
    experience: "High power with a competitive, metagame-focused mindset. Winning matters more than self-expression.",
    deck_building: "There are no restrictions (other than the banned list).",
    rules: { game_changers_allowed: null, two_card_combos: "unrestricted", mass_land_denial_allowed: true, extra_turns: "unrestricted", tutors: "unrestricted" }
  }
];
const COMMANDER_COMPOSITION_GUIDANCE = {
  disclaimer: "General community deck-building consensus for a 100-card Commander deck -- NOT an official WotC rule, and not enforced anywhere in this tool. A reasonable starting point to reason with, not a pass/fail gate; a deliberate theme (e.g. a heavy land-matters or stax build) can reasonably fall outside these ranges.",
  lands: { min: 33, max: 38, note: "Lower end if ramp/card-draw density is high and curve is low; higher end for a top-heavy curve or few ramp/draw pieces." },
  ramp: { min: 8, max: 12, note: "Mana rocks, dorks, and land-ramp effects combined (see validate_and_submit's land_ramp_found)." },
  card_draw: { min: 8, max: 12, note: "Repeatable or one-shot card advantage combined (see validate_and_submit's card_draw_found)." },
  interaction: { min: 8, max: 12, note: "Removal + counterspells combined (see validate_and_submit's removal_found/counterspells_found)." }
};
export {
  COMMANDER_BRACKETS,
  COMMANDER_COMPOSITION_GUIDANCE
};
