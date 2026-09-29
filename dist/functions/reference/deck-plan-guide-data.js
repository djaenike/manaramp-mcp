const FORMAT_RULES = {
  commander: { deck_size: "exactly 100 including the commander", copies: "singleton (1 of each) except basic lands", commander: "1 legendary creature (2 with partner/background); every card must be within its color identity", sideboard: "none", legality_key: "commander", validate_supported: true },
  brawl: { deck_size: "exactly 100 (Historic Brawl on Arena) including the commander", copies: "singleton except basic lands", commander: "1 legendary creature or planeswalker; color identity rules apply", sideboard: "none", legality_key: "brawl", validate_supported: false },
  standard: { deck_size: "60+ main", copies: "up to 4 of each except basic lands", commander: null, sideboard: "up to 15", legality_key: "standard", validate_supported: false },
  pioneer: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "pioneer", validate_supported: false },
  historic: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "historic", validate_supported: false },
  modern: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "modern", validate_supported: false },
  legacy: { deck_size: "60+ main", copies: "up to 4", commander: null, sideboard: "up to 15", legality_key: "legacy", validate_supported: false },
  vintage: { deck_size: "60+ main", copies: "up to 4 (restricted list: 1)", commander: null, sideboard: "up to 15", legality_key: "vintage", validate_supported: false },
  pauper: { deck_size: "60+ main", copies: "up to 4, commons only", commander: null, sideboard: "up to 15", legality_key: "pauper", validate_supported: false }
};
const COMPOSITION_TARGETS = {
  commander: {
    lands: "35-38 total (basics + utility lands)",
    ramp: "10-12 (mana rocks, dorks, land ramp)",
    card_draw: "9-12",
    interaction: "8-12 removal + counters, incl. 2-3 board wipes",
    theme: "the remaining ~25-30: payoffs, enablers, win conditions",
    curve: "average mana value ~2.8-3.4; few cards above 6"
  },
  sixty_card: {
    lands: "22-26 (aggro low end, control high end)",
    copies: "4-ofs for key cards, 1-2 of situational ones",
    curve: "aggro peaks at 1-2, midrange at 2-3, control spreads 2-5",
    interaction: "6-12 depending on archetype"
  }
};
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
  buff: { meaning: "makes your other creatures bigger: pump spells, anthems, equipment/aura boosts, +1/+1 counters, proliferate, counter doublers", filters: { roles_any: ["buff"] } },
  protection: { meaning: "gives your other permanents hexproof/indestructible/shroud/protection/ward, or phases them out (Heroic Intervention, Swiftfoot Boots)", filters: { roles_any: ["protection"] } }
};
const EFFECT_MEANINGS = {
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
  Scry: "scry",
  Surveil: "surveil",
  Mill: "mills cards",
  Discard: "a player discards",
  DealDamage: "deals damage (ValidTgts says to whom: Creature, Player, Any...)",
  DamageAll: "damages every creature/player matching a filter",
  Destroy: "destroys a permanent",
  DestroyAll: "destroys all matching (board wipe)",
  Sacrifice: "a player sacrifices (edicts, or a cost-like outlet)",
  SacrificeAll: "mass sacrifice",
  Counter: "counters a spell or ability",
  GainLife: "gains life",
  LoseLife: "loses life (drain)",
  Tap: "taps",
  Untap: "untaps",
  TapAll: "taps a group",
  UntapAll: "untaps a group",
  Animate: "turns something into a creature / changes types",
  Fight: "two creatures fight",
  Charm: "modal spell (choose one or more)",
  Effect: "creates a lasting effect (emblem-like, delayed)",
  ReduceCost: "makes spells cheaper",
  RaiseCost: "makes spells cost more (tax)",
  CantBlockBy: "evasion: can't be blocked by X",
  Attach: "attaches an Aura/Equipment",
  Regenerate: "regenerates",
  Protection: "grants protection",
  Bounce: "returns to hand",
  ExchangeControl: "swaps control",
  GainControl: "steals a permanent",
  Proliferate: "proliferate",
  Explore: "explore",
  Venture: "venture into the dungeon",
  AddTurn: "extra turn",
  Clone: "becomes a copy",
  Reveal: "reveals cards"
};
const TRIGGERS = {
  kinds: {
    cast: "the spell's own effect when cast",
    activate: "activated ability ({cost}: effect)",
    triggered: '"when/whenever" ability',
    static: "always-on ability",
    replacement: '"if X would happen, instead Y"'
  },
  on_values: "etb (enters the battlefield), dies, exiled, leaves_battlefield, attacks, blocks, cast_spell, draws, deals_damage, sacrificed, token_created, counter_added, life_gained, life_lost, upkeep, end_step, activated, cast, static",
  trigger_event_filter: "use trigger_event (etb, dies, leaves_battlefield, attacks, blocks, cast_spell, deals_damage, draws, discards, sacrificed, token_created, counter_added, life_gained, life_lost, upkeep, end_step, combat) + trigger_watches ({ type: 'Creature'|'Land'|'Artifact'|'Card', modifier: 'YouCtrl'|'OppCtrl'|'Other'|'Self' }) to target exactly 'whenever a creature you control enters' vs 'when this enters'",
  forge_modes: "trigger_kind:'triggered' + a Forge Mode (ChangesZone = zone moves incl. ETB/dies, SpellCast, Attacks, DamageDone, Phase...) -- modes with counts are in vocabulary.trigger_modes"
};
const PARAM_KEYS = {
  ValidTgts: "what it can target -- Creature, Player, Opponent, Any, Permanent, Artifact...",
  Defined: "who/what it affects without targeting -- You, Opponent, Self...",
  Origin: "zone moved FROM (Battlefield, Graveyard, Library, Hand, Exile)",
  Destination: "zone moved TO",
  NumDmg: "damage amount",
  NumCards: "cards drawn/milled",
  Amount: "generic amount",
  TokenScript: "which token is created",
  ValidCards: "which cards a group effect applies to",
  Affected: "what a static ability affects (e.g. Creature.YouCtrl)"
};
const CARD_SCHEMA = {
  name: "exact card name (use it in swaps)",
  slot: "which plan slot picked it",
  mana_cost: "e.g. {1}{R}",
  cmc: "mana value",
  type_line: "full type line",
  color_identity: "WUBRG letters, C = colorless",
  pt: "power/toughness (creatures)",
  oracle_text: "the rules text -- ground truth for fine print",
  keywords: "real keywords (Flying, Haste...)",
  abilities: "one entry per ability: kind, on (what fires it), on_what (which objects fire it, Forge syntax e.g. Creature.YouCtrl = creatures you control, Card.Self = this card), does (effect chain, see effect meanings), targets, cost (e.g. Sac<1/Creature> = sacrifice a creature), optional ('you may')",
  makes_tokens: "tokens it creates, e.g. '1/1 red Goblin'",
  roles: "precomputed roles (see roles)",
  price_usd: "price of the default printing",
  reading_synergy: "Match what one card PRODUCES (does/makes_tokens) against what another is TRIGGERED BY (on/on_what): a token maker (makes_tokens) feeds an etb payoff whose on_what includes Creature.YouCtrl."
};
const PLAN_SCHEMA = {
  prompt_id: "the Manaramp deck prompt id if there is one -- commander, rules and targets are read from it",
  commander: "exact name (Commander/Brawl) -- omit if the prompt has one",
  deck_name: "short and specific",
  wincon_summary: "how it wins, one sentence",
  general_strategy: "how to pilot it, one short paragraph",
  bracket_estimate: "e.g. 'Bracket 2 (Core)' -- your judgment",
  exclude: "deck-wide exclusions (list of filter sets) -- for 'no <archetype>' use archetypes.<name>.exclude",
  slots: "THEME slots only, highest priority first: { label, count, ...filters (roles_any, effect_in, trigger_event + trigger_watches, cost_contains, type_line_contains, oracle_text_contains, category, cmc_max, max_price_usd), sort? }. Total about targets.theme_slots_budget cards. Don't add ramp/draw/removal/wipes/lands -- the server fills those to targets, counting theme cards that already do them.",
  constraints: "only without a prompt_id: { colors, max_price_usd, bracket, theme, restrictions, build_style }",
  review: "optional true = return an unsaved draft with card details instead of saving"
};
const PLAN_EXAMPLE = {
  commander: "Purphoros, God of the Forge",
  deck_name: "Purphoros Burn",
  wincon_summary: "Every creature that enters pings opponents; go wide and burn them out.",
  general_strategy: "Ramp early, flood the board with cheap creatures and token makers, protect Purphoros.",
  bracket_estimate: "Bracket 2 (Core)",
  exclude: [{ cost_contains: { kind: "Sac", arg: "Creature" } }],
  slots: [
    { label: "etb payoffs", count: 7, trigger_event: "etb", trigger_watches: { type: "Creature", modifier: "YouCtrl" }, effect_in: ["DealDamage"] },
    { label: "token makers", count: 14, roles_any: ["token_generator"], cmc_max: 4 },
    { label: "anthems", count: 4, effect_in: ["PumpAll"] }
  ],
  note: "25 theme cards -- the server adds ramp, draw, removal, wipes, types and lands to exactly 100 and saves."
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
  { idea: "no aristocrats (deck-wide exclude)", exclude: "archetypes.aristocrats.exclude" }
];
const ARCHETYPES = {
  aristocrats: {
    means: "sacrifice outlets + creature death triggers + drain payoffs",
    include: [{ cost_contains: { kind: "Sac", arg: "Creature" } }, { trigger_event: "dies", trigger_watches: { type: "Creature" } }],
    exclude: [{ cost_contains: { kind: "Sac", arg: "Creature" } }, { trigger_event: "dies", trigger_watches: { type: "Creature" } }, { trigger_event: "sacrificed" }]
  },
  lifegain: {
    means: "gain life, get paid off for it",
    include: [{ trigger_event: "life_gained" }, { effect_in: ["GainLife"], trigger_kind: "triggered" }],
    exclude: [{ trigger_event: "life_gained" }]
  },
  tokens_go_wide: {
    means: "many tokens + anthems / ETB payoffs",
    include: [{ roles_any: ["token_generator"] }, { effect_in: ["PumpAll"] }, { trigger_event: "etb", trigger_watches: { type: "Creature", modifier: "YouCtrl" } }],
    exclude: [{ roles_any: ["token_generator"] }]
  },
  counters: {
    means: "+1/+1 counters and proliferate",
    include: [{ effect_in: ["PutCounter", "PutCounterAll", "Proliferate"] }, { trigger_event: "counter_added" }],
    exclude: [{ effect_in: ["Proliferate"] }, { trigger_event: "counter_added" }]
  },
  spellslinger: {
    means: "cheap instants/sorceries + cast triggers",
    include: [{ trigger_event: "cast_spell" }, { category: "Instant", cmc_max: 3 }, { category: "Sorcery", cmc_max: 3 }],
    exclude: [{ trigger_event: "cast_spell" }]
  },
  voltron: {
    means: "suit up one threat with equipment/auras",
    include: [{ type_line_contains: "Equipment" }, { type_line_contains: "Aura" }],
    exclude: [{ type_line_contains: "Equipment" }, { type_line_contains: "Aura" }]
  },
  reanimator: {
    means: "fill the graveyard, bring back big threats",
    include: [{ effect_in: ["ChangeZone"], effect_param_contains: { key: "Origin", value_contains: "Graveyard" } }, { effect_in: ["Mill", "Discard"] }],
    exclude: [{ effect_in: ["ChangeZone"], effect_param_contains: { key: "Origin", value_contains: "Graveyard" } }]
  },
  landfall: {
    means: "land drops trigger payoffs",
    include: [{ trigger_event: "etb", trigger_watches: { type: "Land", modifier: "YouCtrl" } }, { roles_any: ["land_ramp", "extra_land_drop"] }],
    exclude: [{ trigger_event: "etb", trigger_watches: { type: "Land" } }]
  },
  stax: {
    means: "tax and lock opponents",
    include: [{ effect_in: ["RaiseCost"] }],
    exclude: [{ effect_in: ["RaiseCost"] }, { roles_any: ["mass_removal"], oracle_text_contains: "land" }]
  }
};
const BUDGET_WORDS = {
  "cheap / budget / broke": "$50-100 whole deck",
  "mid / reasonable": "$150-300",
  "upgraded / nice": "$300-600",
  "no limit / money no object": "no budget constraint",
  unspecified: "ask once, or if the user said 'just build it', assume $150 and say so"
};
const INSTRUCTIONS = [
  "0. No format named = Commander. If the user said 'just build it' or gave enough, fill gaps with defaults (budget_words) instead of asking, and open your reply with what you assumed.",
  "1. Ask ONCE (all questions together) only if `missing` has something you can't reasonably default.",
  "1b. No commander: pick from commander_candidates by abilities and `rewards` vs colors/budget/theme; say why plus one alternative. commander: null reshuffles candidates.",
  "1c. Build toward constraints.theme; if there's none, toward what the commander `rewards` -- name the direction.",
  "2. constraints.restrictions -> deck-wide `exclude` (archetypes.<name>.exclude for 'no <archetype>'); theme -> slot filters (idea_examples).",
  "3. Write THEME slots only (~targets.theme_slots_budget cards): payoffs, enablers, synergy pieces, highest priority first. The server fills ramp, draw, removal, wipes, card types and lands to `targets` (the user's sliders when targets.source is 'user').",
  "4. build_style 'original': theme from effect combinations (what cards produce vs what triggers them), no query_synergies/query_combos/meta lists. 'community': sort: 'synergy' slots and known combos are OK when allowed.",
  "5. Call fill_deck_plan ONCE with the slots + deck_name, wincon_summary, general_strategy, bracket_estimate. It builds and SAVES the deck and returns the link. If it comes back saved: false, fix the warnings with validate_and_submit({ draft_id, swaps, submit: true }).",
  "6. Reply in under ~100 words: commander, the plan in one line, price vs budget, the link. Offer edit_deck for changes.",
  "7. Edits: edit_deck in ONE call (remove/add by name, add_search, constraints, commander swap). A rebuild prompt (mode 'rebuild') = steps 3-6 with the same prompt_id -- the deck is overwritten in place."
];
export {
  ARCHETYPES,
  BUDGET_WORDS,
  CARD_SCHEMA,
  COMPOSITION_TARGETS,
  EFFECT_MEANINGS,
  FORMAT_RULES,
  IDEA_EXAMPLES,
  INSTRUCTIONS,
  PARAM_KEYS,
  PLAN_EXAMPLE,
  PLAN_SCHEMA,
  ROLES,
  TRIGGERS
};
