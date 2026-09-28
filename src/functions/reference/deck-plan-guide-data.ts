/**
 * functions/reference/deck-plan-guide-data.ts
 *
 * Static half of deck_plan_guide (2026-09-27) -- everything a model needs to write ONE precise
 * fill_deck_plan call: format rules, composition targets, what each role means and how to query it,
 * plain-English meanings for the common Forge effects/triggers/params, the returned-card schema, the
 * plan schema, and idea -> filter examples. The live half (effect names + card counts actually in the
 * database, and the user's stored deck_prompt) is merged in by tools/deck-plan-guide.ts.
 *
 * Kept compact on purpose: it's sent once per session, but every token here is read by the model.
 */

interface FormatRules {
  deck_size: string;
  copies: string;
  commander: string | null;
  sideboard: string;
  legality_key: string;
  validate_supported: boolean;
}

const FORMAT_RULES: Record<string, FormatRules> = {
  commander: { deck_size: "exactly 100 including the commander", copies: "singleton (1 of each) except basic lands", commander: "1 legendary creature (2 with partner/background); every card must be within its color identity", sideboard: "none", legality_key: "commander", validate_supported: true },
  brawl: { deck_size: "exactly 100 (Historic Brawl on Arena) including the commander", copies: "singleton except basic lands", commander: "1 legendary creature or planeswalker; color identity rules apply", sideboard: "none", legality_key: "brawl", validate_supported: false },
  standard: { deck_size: "60+ main", copies: "up to 4 of each except basic lands", commander: null, sideboard: "up to 15", legality_key: "standard", validate_supported: false },
  pioneer: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "pioneer", validate_supported: false },
  historic: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "historic", validate_supported: false },
  modern: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "modern", validate_supported: false },
  legacy: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "legacy", validate_supported: false },
  vintage: { deck_size: "60+ main", copies: "up to 4 (restricted list: 1)", commander: null, sideboard: "up to 15", legality_key: "vintage", validate_supported: false },
  pauper: { deck_size: "60+ main", copies: "up to 4, commons only", commander: null, sideboard: "up to 15", legality_key: "pauper", validate_supported: false },
};

/** Community consensus, not official rules -- starting targets the plan's slot counts should hit. */
const COMPOSITION_TARGETS = {
  commander: {
    lands: "35-38 total (basics + utility lands)",
    ramp: "10-12 (mana rocks, dorks, land ramp)",
    card_draw: "9-12",
    interaction: "8-12 removal + counters, incl. 2-3 board wipes",
    theme: "the remaining ~25-30: payoffs, enablers, win conditions",
    curve: "average mana value ~2.8-3.4; few cards above 6",
  },
  sixty_card: {
    lands: "22-26 (aggro low end, control high end)",
    copies: "4-ofs for key cards, 1-2 of situational ones",
    curve: "aggro peaks at 1-2, midrange at 2-3, control spreads 2-5",
    interaction: "6-12 depending on archetype",
  },
};

/** Role -> what it means and the simplest precise filters for it. `roles_any` uses manaramp's
 *  precomputed role flags (same rules as the website's ability filters). */
const ROLES = {
  mana_rock: { meaning: "artifact that makes mana", filters: { roles_any: ["mana_rock"] } },
  mana_dork: { meaning: "creature that makes mana", filters: { roles_any: ["mana_dork"] } },
  land_ramp: { meaning: "puts extra lands onto the battlefield for you (not fetch lands)", filters: { roles_any: ["land_ramp"] } },
  card_draw: { meaning: "draws cards", filters: { roles_any: ["card_draw"] } },
  removal: { meaning: "destroys/exiles/bounces/tucks/damages or shrinks an opposing creature or permanent", filters: { roles_any: ["removal"] } },
  mass_removal: { meaning: "board wipe -- destroy/exile/bounce/damage/-X/-X all creatures or permanents", filters: { roles_any: ["mass_removal"] } },
  counterspell: { meaning: "counters spells", filters: { roles_any: ["counterspell"] } },
  tutor: { meaning: "searches the library for a nonland card (to hand, top, or battlefield)", filters: { roles_any: ["tutor"] } },
  recursion: { meaning: "returns cards from the graveyard", filters: { roles_any: ["recursion"] } },
  token_generator: { meaning: "creates tokens", filters: { roles_any: ["token_generator"] } },
  player_damage: { meaning: "damages players directly", filters: { roles_any: ["player_damage"] } },
  extra_land_drop: { meaning: "lets you play additional lands", filters: { roles_any: ["extra_land_drop"] } },
};

/** Plain meanings for the Forge effect names worth knowing by heart. The full list with card counts
 *  comes from the database (effect_vocabulary) -- anything not here is still a valid name. */
const EFFECT_MEANINGS: Record<string, string> = {
  Continuous: "static rules change (anthems, cost changes, abilities granted)",
  ChangeZone: "moves cards between zones -- tutors, reanimation, blink, exile-removal (see Origin/Destination)",
  ChangeZoneAll: "moves many cards at once (mass exile, mass reanimation)",
  Pump: "+X/+X or grants a keyword to one creature",
  PumpAll: "same, to a group (anthem effects)",
  Token: "creates tokens (see makes_tokens)",
  CopyPermanent: "creates a token copy of a permanent",
  Mana: "adds mana",
  PutCounter: "puts counters (+1/+1, loyalty, others)",
  PutCounterAll: "puts counters on a group",
  Draw: "draws cards",
  Dig: "looks at the top N, takes some",
  Scry: "scry", Surveil: "surveil", Mill: "mills cards", Discard: "a player discards",
  DealDamage: "deals damage (ValidTgts says to whom: Creature, Player, Any...)",
  DamageAll: "damages every creature/player matching a filter",
  Destroy: "destroys a permanent", DestroyAll: "destroys all matching (board wipe)",
  Sacrifice: "a player sacrifices (edicts, or a cost-like outlet)", SacrificeAll: "mass sacrifice",
  Counter: "counters a spell or ability",
  GainLife: "gains life", LoseLife: "loses life (drain)",
  Tap: "taps", Untap: "untaps", TapAll: "taps a group", UntapAll: "untaps a group",
  Animate: "turns something into a creature / changes types",
  Fight: "two creatures fight", Charm: "modal spell (choose one or more)",
  Effect: "creates a lasting effect (emblem-like, delayed)",
  ReduceCost: "makes spells cheaper", RaiseCost: "makes spells cost more (tax)",
  CantBlockBy: "evasion: can't be blocked by X",
  Attach: "attaches an Aura/Equipment", Regenerate: "regenerates",
  Protection: "grants protection", Bounce: "returns to hand",
  ExchangeControl: "swaps control", GainControl: "steals a permanent",
  Proliferate: "proliferate", Explore: "explore", Venture: "venture into the dungeon",
  AddTurn: "extra turn", Clone: "becomes a copy", Reveal: "reveals cards",
};

/** How to read trigger kinds and the `on` field on returned cards. */
const TRIGGERS = {
  kinds: {
    cast: "the spell's own effect when cast",
    activate: "activated ability ({cost}: effect)",
    triggered: "\"when/whenever\" ability",
    static: "always-on ability",
    replacement: "\"if X would happen, instead Y\"",
  },
  on_values: "etb (enters the battlefield), dies, exiled, leaves_battlefield, attacks, blocks, cast_spell, draws, deals_damage, sacrificed, token_created, counter_added, life_gained, life_lost, upkeep, end_step, activated, cast, static",
  trigger_event_filter: "use trigger_event (etb, dies, leaves_battlefield, attacks, blocks, cast_spell, deals_damage, draws, discards, sacrificed, token_created, counter_added, life_gained, life_lost, upkeep, end_step, combat) + trigger_watches ({ type: 'Creature'|'Land'|'Artifact'|'Card', modifier: 'YouCtrl'|'OppCtrl'|'Other'|'Self' }) to target exactly 'whenever a creature you control enters' vs 'when this enters'",
  forge_modes: "trigger_kind:'triggered' + a Forge Mode (ChangesZone = zone moves incl. ETB/dies, SpellCast, Attacks, DamageDone, Phase...) -- modes with counts are in vocabulary.trigger_modes",
};

/** The step params that make filters precise, and what they hold. */
const PARAM_KEYS = {
  ValidTgts: "what it can target -- Creature, Player, Opponent, Any, Permanent, Artifact...",
  Defined: "who/what it affects without targeting -- You, Opponent, Self...",
  Origin: "zone moved FROM (Battlefield, Graveyard, Library, Hand, Exile)",
  Destination: "zone moved TO",
  NumDmg: "damage amount", NumCards: "cards drawn/milled", Amount: "generic amount",
  TokenScript: "which token is created",
  ValidCards: "which cards a group effect applies to",
  Affected: "what a static ability affects (e.g. Creature.YouCtrl)",
};

/** What each field on a card returned by fill_deck_plan / edit_deck means. */
const CARD_SCHEMA = {
  name: "exact card name (use it in swaps)",
  slot: "which plan slot picked it",
  mana_cost: "e.g. {1}{R}", cmc: "mana value", type_line: "full type line", color_identity: "WUBRG letters, C = colorless",
  pt: "power/toughness (creatures)", oracle_text: "the rules text -- ground truth for fine print",
  keywords: "real keywords (Flying, Haste...)",
  abilities: "one entry per ability: kind, on (what fires it), on_what (which objects fire it, Forge syntax e.g. Creature.YouCtrl = creatures you control, Card.Self = this card), does (effect chain, see effect meanings), targets, cost (e.g. Sac<1/Creature> = sacrifice a creature), optional ('you may')",
  makes_tokens: "tokens it creates, e.g. '1/1 red Goblin'",
  roles: "precomputed roles (see roles)",
  price_usd: "price of the default printing",
  reading_synergy: "Match what one card PRODUCES (does/makes_tokens) against what another is TRIGGERED BY (on/on_what): a token maker (makes_tokens) feeds an etb payoff whose on_what includes Creature.YouCtrl.",
};

/** fill_deck_plan's input, for the model to fill in. */
const PLAN_SCHEMA = {
  prompt_id: "the Manaramp deck prompt id if the user gave one -- constraints are read from it",
  commander: "exact commander name (Commander/Brawl). Omit if prompt_id already has one",
  format: "commander (default) or another key from `formats`",
  constraints: "only when there's no prompt_id: { colors?: ['R'], max_price_usd?: 150, bracket?: 3, restrictions?: '...', build_style?: 'original'|'community', use_synergies?: bool, use_combos?: bool }",
  exclude: "deck-wide exclusions, a list of filter sets -- use an archetype's `exclude` list for 'no <archetype>' (e.g. archetypes.aristocrats.exclude)",
  slots: "ordered list, filled top-down (earlier slots claim cards first): { label, count, ...any query_cards filter (roles_any, effect_in, effects_all, trigger_kind, trigger_event, trigger_watches, cost_contains, effect_param_contains, type_line_contains, category, cmc_min/cmc_max, oracle_text_contains, max_price_usd), sort?: 'varied'|'cmc'|'price'|'synergy' }",
  basic_lands: "e.g. { Mountain: 30 } -- counted toward the deck size, not a slot",
  alternates_per_slot: "0-4, default 2 -- extra candidates per slot you can swap in at submit",
  rules: "slot counts + basic lands + commander must equal the deck size exactly (Commander: 100). Colors and legality are applied to every slot automatically -- don't repeat them in slot filters.",
};

const PLAN_EXAMPLE = {
  commander: "Purphoros, God of the Forge",
  exclude: [{ cost_contains: { kind: "Sac", arg: "Creature" } }, { trigger_event: "dies", trigger_watches: { type: "Creature" } }],
  slots: [
    { label: "etb payoffs", count: 6, trigger_event: "etb", trigger_watches: { type: "Creature", modifier: "YouCtrl" }, effect_in: ["DealDamage"] },
    { label: "token makers", count: 12, roles_any: ["token_generator"], cmc_max: 4 },
    { label: "anthems", count: 4, effect_in: ["PumpAll"] },
    { label: "ramp", count: 10, roles_any: ["mana_rock", "mana_dork", "land_ramp"], cmc_max: 3 },
    { label: "draw", count: 9, roles_any: ["card_draw"] },
    { label: "removal", count: 8, roles_any: ["removal", "mass_removal"] },
    { label: "utility lands", count: 6, category: "Land" },
    { label: "flex", count: 14, category: "Creature", cmc_max: 3, sort: "varied" },
  ],
  basic_lands: { Mountain: 30 },
  note: "6+12+4+10+9+8+6+14 = 69 + 30 basics + 1 commander = 100",
};

const IDEA_EXAMPLES = [
  { idea: "pings opponents whenever a creature you control enters", filters: { trigger_event: "etb", trigger_watches: { type: "Creature", modifier: "YouCtrl" }, effect_in: ["DealDamage"] } },
  { idea: "landfall", filters: { trigger_event: "etb", trigger_watches: { type: "Land", modifier: "YouCtrl" } } },
  { idea: "death-trigger payoffs (aristocrats)", filters: { trigger_event: "dies", trigger_watches: { type: "Creature" } } },
  { idea: "creature removal", filters: { roles_any: ["removal"] } },
  { idea: "draws when creatures die", filters: { trigger_event: "dies", trigger_watches: { type: "Creature" }, effect_in: ["Draw"] } },
  { idea: "reanimation", filters: { effect_in: ["ChangeZone"], effect_param_contains: { key: "Origin", value_contains: "Graveyard" }, oracle_text_contains: "battlefield" } },
  { idea: "makes tokens AND draws", filters: { effects_all: ["Token", "Draw"] } },
  { idea: "bats only (tribal creature slots)", filters: { category: "Creature", type_line_contains: "Bat" } },
  { idea: "sacrifice outlets", filters: { cost_contains: { kind: "Sac", arg: "Creature" } } },
  { idea: "no aristocrats (deck-wide exclude)", exclude: "archetypes.aristocrats.exclude" },
];

/** Archetypes as filter sets (2026-09-27): `include` = slot filters to BUILD it, `exclude` = the
 *  deck-wide `exclude` list to AVOID it. So "no aristocrats" is the same, complete exclusion every
 *  time instead of whatever filters get improvised. Incidental overlap is fine -- e.g. avoiding
 *  aristocrats doesn't ban every card that gains or drains a little life; only the engine pieces. */
const ARCHETYPES = {
  aristocrats: {
    means: "sacrifice outlets + creature death triggers + drain payoffs",
    include: [{ cost_contains: { kind: "Sac", arg: "Creature" } }, { trigger_event: "dies", trigger_watches: { type: "Creature" } }],
    exclude: [{ cost_contains: { kind: "Sac", arg: "Creature" } }, { trigger_event: "dies", trigger_watches: { type: "Creature" } }, { trigger_event: "sacrificed" }],
  },
  lifegain: {
    means: "gain life, get paid off for it",
    include: [{ trigger_event: "life_gained" }, { effect_in: ["GainLife"], trigger_kind: "triggered" }],
    exclude: [{ trigger_event: "life_gained" }],
  },
  tokens_go_wide: {
    means: "many tokens + anthems / ETB payoffs",
    include: [{ roles_any: ["token_generator"] }, { effect_in: ["PumpAll"] }, { trigger_event: "etb", trigger_watches: { type: "Creature", modifier: "YouCtrl" } }],
    exclude: [{ roles_any: ["token_generator"] }],
  },
  counters: {
    means: "+1/+1 counters and proliferate",
    include: [{ effect_in: ["PutCounter", "PutCounterAll", "Proliferate"] }, { trigger_event: "counter_added" }],
    exclude: [{ effect_in: ["Proliferate"] }, { trigger_event: "counter_added" }],
  },
  spellslinger: {
    means: "cheap instants/sorceries + cast triggers",
    include: [{ trigger_event: "cast_spell" }, { category: "Instant", cmc_max: 3 }, { category: "Sorcery", cmc_max: 3 }],
    exclude: [{ trigger_event: "cast_spell" }],
  },
  voltron: {
    means: "suit up one threat with equipment/auras",
    include: [{ type_line_contains: "Equipment" }, { type_line_contains: "Aura" }],
    exclude: [{ type_line_contains: "Equipment" }, { type_line_contains: "Aura" }],
  },
  reanimator: {
    means: "fill the graveyard, bring back big threats",
    include: [{ effect_in: ["ChangeZone"], effect_param_contains: { key: "Origin", value_contains: "Graveyard" } }, { effect_in: ["Mill", "Discard"] }],
    exclude: [{ effect_in: ["ChangeZone"], effect_param_contains: { key: "Origin", value_contains: "Graveyard" } }],
  },
  landfall: {
    means: "land drops trigger payoffs",
    include: [{ trigger_event: "etb", trigger_watches: { type: "Land", modifier: "YouCtrl" } }, { roles_any: ["land_ramp", "extra_land_drop"] }],
    exclude: [{ trigger_event: "etb", trigger_watches: { type: "Land" } }],
  },
  stax: {
    means: "tax and lock opponents",
    include: [{ effect_in: ["RaiseCost"] }],
    exclude: [{ effect_in: ["RaiseCost"] }, { roles_any: ["mass_removal"], oracle_text_contains: "land" }],
  },
};

/** Vague budget words -> a number to plan with. Always tell the user the number you assumed. */
const BUDGET_WORDS = {
  "cheap / budget / broke": "$50-100 whole deck",
  "mid / reasonable": "$150-300",
  "upgraded / nice": "$300-600",
  "no limit / money no object": "no budget constraint",
  unspecified: "ask once, or if the user said 'just build it', assume $150 and say so",
};

const INSTRUCTIONS = [
  "0. Defaults: no format named = Commander (say so). If the user said 'just build it' or gave enough to go on, fill gaps with stated defaults (budget_words) instead of asking -- open your reply with what you assumed so they can correct it.",
  "1. If `missing` is non-empty and you can't reasonably default it, ask ONCE, all questions together.",
  "1b. No commander (none given, or you passed commander: null): pick from `commander_candidates` -- read each one's abilities and `rewards`, choose the one that best fits the colors/budget/restrictions, and tell the user why plus one alternative. Want different options? Call deck_plan_guide again with commander: null (candidates reshuffle every call).",
  "1c. No theme given: build around what the commander `rewards` -- name the direction you chose.",
  "2. Translate `constraints.restrictions` into filters (idea_examples) -- slot filters, or deck-wide `exclude`.",
  "3. Design the deck by role with slot counts that sum EXACTLY to the deck size, using composition_targets as the baseline. Order slots by priority (theme payoffs first, lands last).",
  "4. build_style 'original': build theme slots from effect combinations (what cards produce vs what triggers them) -- don't use query_synergies/query_combos, web search, or remembered meta lists. 'community': you may add sort: 'synergy' slots and known combos when use_synergies/use_combos allow.",
  "5. Call fill_deck_plan ONCE. It returns picks + alternates per slot, shortfalls, price, curve and role counts.",
  "6. Review the picks (abilities/makes_tokens make synergies visible). Then call validate_and_submit ONCE with { draft_id, swaps, submit: true, deck_name, wincon_summary, general_strategy, bracket_estimate }. Don't retype the decklist.",
  "7. Edits (deck_id given): use edit_deck in ONE call -- remove/add by name, add_search for server-picked cards (the deck's colors/budget/restrictions apply automatically), constraints to change a rule, commander to swap commander while keeping cards that still fit. For a rebuild around a new commander, call deck_plan_guide with deck_id and commander: null, pick one, write a new plan, fill_deck_plan, then validate_and_submit with the draft_id AND deck_id to overwrite the same deck.",
];

export {
  FORMAT_RULES,
  COMPOSITION_TARGETS,
  ROLES,
  EFFECT_MEANINGS,
  TRIGGERS,
  PARAM_KEYS,
  CARD_SCHEMA,
  PLAN_SCHEMA,
  PLAN_EXAMPLE,
  IDEA_EXAMPLES,
  INSTRUCTIONS,
  ARCHETYPES,
  BUDGET_WORDS,
};
