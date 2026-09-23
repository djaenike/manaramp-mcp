/**
 * functions/cards.ts -- the ONE place that queries manaramp's `cards` Mongo collection.
 *
 * Consolidated 2026-09-17 (fifth pass): this used to be split across sub-tools/scryfall/cards.ts
 * (search) and sub-tools/cardkingdom/pricing.ts (a SEPARATE cards.find() just for market_data),
 * with sub-tools/deck-building/consistency.ts and sub-tools/spellbook/combos.ts ALSO each running
 * their own independent cards.find() for card-detail/cmc lookups -- four different places
 * re-implementing the same underlying query. "scryfall"/"cardkingdom" as folder names were also
 * actively misleading: this queries the WHOLE ingested card document (Forge abilities, 17Lands
 * format_stats, Card Kingdom/ManaPool pricing, Scryfall's own fields), not just "Scryfall data."
 *
 * Every other function in this package that needs card data (deck-validation's consistency checks,
 * combos' cmc/speed classification, decks' oracle_id resolution, draft-results' grpId resolution)
 * calls queryCards below instead of touching `db.collection("cards")` itself -- this is the only
 * file that does.
 *
 * Ability filtering rebuilt on `effects` (2026-09-22, restructured again same day -- see below), NOT
 * the old abilities.is_X booleans (retired entirely from the schema, see manaramp's
 * src/lib/server/ingest/forge-script.ts for the full design reasoning; that repo owns the ingest
 * pipeline this collection is built from). Two reasons the old boolean system had to go, not just
 * "the new one is nicer":
 *   1. It could only ever represent a FIXED, curated set of ~13 boolean categories -- Forge has
 *      ~200 distinct effect types, and collapsing e.g. Destroy/Exile/DealDamage into one shared
 *      is_removal boolean, or LoseLife/DealDamage into nothing at all, threw away real distinctions
 *      no amount of adding more booleans could keep up with.
 *   2. It dropped real data: the old triggered_abilities only ever captured the FIRST effect in a
 *      SubAbility$ chain (confirmed live -- Vengeful Bloodwitch's "you gain 1 life" half, Belladonna
 *      Took's 2nd/3rd storm-count steps, were both silently missing), and never captured a trigger's
 *      ValidCard$/Origin$/Destination$ scope at all.
 * `effects` fixes both: Forge's own effect-name vocabulary used directly (effect_in below), the full
 * SubAbility$ chain walked and preserved in order, and every condition/scope field kept verbatim.
 *
 * Second restructuring (2026-09-22, same day): every value in `effects` (trigger.conditions, a
 * result step's params/conditions) now uses ONE consistent shape (EffectValue -- an array of
 * {type, modifiers} clauses) instead of a string/string[] union, Cost$ is parsed off Forge's real
 * cost-token grammar instead of left as one opaque string, and Origin$/Destination$/ChangeType$ are
 * paired into `zone_change` instead of three independently-named keys -- see EffectValue's own doc
 * comment below, and manaramp's forge-script.ts for the full mapping-logic reasoning. Because
 * Origin$/Destination$/ChangeType$ move OUT of a step's params/conditions into zone_change whenever
 * a zone move is present, effect_param_contains below checks zone_change too when the key named is
 * Origin/Destination/ChangeType -- see ZONE_CHANGE_KEY_MAP.
 *
 * Per-printing pricing (2026-09-22, was one flat market_data object per card, name-matched against
 * retailer pricelists) -- market_data is now an array keyed by scryfall_id, matched by manaramp's
 * ingest against each retailer's OWN scryfall_id per listing (exact identity, not name collapsing --
 * see manaramp's pricing.ts). CardSummary.price_usd resolves to whichever printing released most
 * recently (scryfall_printings[].released_at), priced from the caller's preferred source -- NOT
 * cheapest-across-every-printing, matching the same default manaramp's own /cards page and deck page
 * use (see manaramp's src/lib/server/cards/pricing.ts, a separate copy of the same small resolution
 * logic -- manaramp doesn't depend on manaramp-mcp, so this stays duplicated rather than shared).
 * `printing_preferences` lets a caller override that default per oracle_id (e.g. deck-analysis.ts
 * pricing a deck whose owner pinned a specific printing for some cards -- see manaramp's
 * schema/decks.ts's printing_preferences).
 */

import type { Db } from "mongodb";

/** One clause of a Forge value: a Type plus its dot-then-plus-joined modifiers (AND). Comma-joined
 *  alternatives in the raw Forge string become separate clauses (OR). */
interface EffectClause {
  type: string;
  modifiers: string[];
}

/** The ONE shape every value in `effects` uses, trigger conditions and result-step params/conditions
 *  alike -- the array itself is Forge's comma-separated OR-of-clauses grammar; a plain scalar with
 *  no comma/dot is just one clause with an empty modifiers array, same shape either way. */
type EffectValue = EffectClause[];

interface ZoneChange {
  from: EffectValue;
  to: EffectValue;
  what: EffectValue | null;
}

/** One space-separated token off a Cost$ string, parsed off Forge's own cost-token grammar. kind is
 *  Forge's own cost-part keyword verbatim (e.g. "Sac", "AddCounter") except "Tap"/"Untap" (normalized
 *  from T/Q, Cost.java treats each pair as equivalent) and "Mana" (the bare mana portion, which has
 *  no keyword prefix of its own in Forge's grammar). */
interface EffectCostPart {
  kind: string;
  args: string[];
  mana: string | null;
}

interface EffectStep {
  effect: string;
  /** Pulled out of params when this step's effect involves a zone move (Origin$/Destination$ both
   *  present). Null otherwise. */
  zone_change: ZoneChange | null;
  params: Record<string, EffectValue>;
  conditions: Record<string, EffectValue>;
  /** Any dynamic-amount SVar referenced by name in params/conditions above, inlined to its own raw
   *  Forge formula string (2026-09-22) -- e.g. {"X": "Count$Valid Creature.YouCtrl"} when
   *  params.NumAtt is "+X". Not a resolved number (Count$/Number$ describe a value that depends on
   *  live game state, so there is no single static answer) -- this is the formula itself, inlined so
   *  the step is self-contained rather than requiring a separate svars lookup. Excludes anything that
   *  resolves to a whole ability rather than a value -- see nested_effects. */
  formulas: Record<string, string>;
  /** TriggersWhenSpent$/StaticAbilities$ (2026-09-22), resolved into real nested Effect objects
   *  instead of landing in `formulas` as opaque SVar text -- e.g. Path of Ancestry's mana ability
   *  nests its "scry when spent on a creature" trigger here, Domri Rade's ultimate nests its
   *  "creatures you control get keywords" static here. Empty array, not omitted, when nothing here
   *  references one. */
  nested_effects: Effect[];
  /** Raw Cost$ on THIS step (2026-09-22) -- only ever present when a step reached via a chain (not a
   *  top-level activate line) carries its own cost, e.g. an `ImmediateTrigger` step's linked "when you
   *  do" ability (Bolg of the North: Sac<1/Creature.Other/another creature>). Null when there is no
   *  cost (never an empty array) -- the overwhelmingly common case. */
  cost: EffectCostPart[] | null;
  /** Resolved at READ TIME (2026-09-22), not stored -- keyed by every TokenScript$ value this step's
   *  own params reference (see collectTokenScriptNames/enrichEffectsWithTokens below), e.g.
   *  {"c_a_treasure_sac": {name: "Treasure Token", types: "Artifact Treasure", ...}}. Before this
   *  existed, a token-making card's params.TokenScript was just a bare Forge-internal filename with
   *  zero indication of what it actually creates -- "is c_a_treasure_sac a fine word for an AI with no
   *  context to understand?" No: it resolves to a real card-shaped definition (a Treasure Token with
   *  its own tap-sac-for-mana ability), none of which survived without this. Absent (not an empty
   *  object) when this step has no TokenScript reference, or manaramp's token_scripts collection
   *  hasn't resolved that name yet (see manaramp's schema/token_scripts.ts). */
  tokens?: Record<string, TokenDescriptor>;
  /** DB$ Branch's own TrueSubAbility$/FalseSubAbility$ conditional fork (2026-09-22) -- unlike
   *  SubAbility$ (unconditional continuation) or TriggersWhenSpent$/StaticAbilities$ (a whole separate
   *  trigger/static definition), these point at a plain DB$ step chosen by a BranchConditionSVar$
   *  comparison (confirmed against Forge's real BranchEffect.java source). Null on every step except a
   *  Branch effect. */
  branch: EffectBranch | null;
  /** DB$ Charm's own Choices$ (2026-09-22) -- every "choose one or more --" modal spell in the game.
   *  Keyed by SVar name, e.g. {"DBDamage": [...], "DBReturn1": [...]} -- confirmed against Forge's
   *  real CharmEffect.java source (`sa.getAdditionalAbilityList("Choices")`, the same comma-separated
   *  accessor SubAbility$/Branch's arms resolve through). Empty object, not omitted, when this step
   *  has no Choices$ (only Charm has modes at all). */
  choices: Record<string, EffectStep[]>;
}

/** See EffectStep.branch's own doc comment. */
interface EffectBranch {
  condition_svar: string;
  condition_compare: string;
  condition_formula: string | null;
  true_result: EffectStep[];
  false_result: EffectStep[];
}

/** manaramp's schema/token_scripts.ts, minus token_raw (private, GPL-3.0, same treatment as a card's
 *  own forge_raw -- never read here, let alone exposed). */
interface TokenDescriptor {
  name: string;
  types: string;
  pt: string | null;
  colors: string | null;
  keywords: string[];
  effects: Effect[];
}

interface Effect {
  trigger: {
    kind: "cast" | "activate" | "triggered" | "static" | "replacement";
    /** Raw Mode$ -- present for triggered/static (an S: line's own Mode$ doubles as its
     *  result[].effect too when it has no separate AB$/SP$/ST$/DB$ key of its own). Null for
     *  cast/activate. */
    mode: string | null;
    /** Only ever set for kind: triggered/replacement -- for cast/activate/static, a zone move (if
     *  any) belongs to the effect itself, in result[0].zone_change instead. */
    zone_change: ZoneChange | null;
    conditions: Record<string, EffectValue>;
    /** Only ever present for kind: activate. Null when there is no cost (never an empty array). */
    cost: EffectCostPart[] | null;
    formulas: Record<string, string>;
    /** Same idea as EffectStep.nested_effects, for a pointer referenced at the trigger level rather
     *  than within a chain step. Empty array, not omitted, when nothing here references one. */
    nested_effects: Effect[];
  };
  result: EffectStep[];
}

interface MarketDataEntry {
  scryfall_id: string;
  cardkingdom: { price_usd: number | null; is_foil: boolean; fetched_at: Date } | null;
  manapool: { price_usd: number | null; is_foil: boolean; fetched_at: Date } | null;
}

interface MongoCardDoc {
  _id: string;
  name: string;
  mana_cost: string | null;
  cmc: number | null;
  type_line: string;
  category: string;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string[];
  color_identity: string[];
  legalities: Record<string, string>;
  arena_grp_ids: number[];
  keywords: string[] | null;
  effects: Effect[] | undefined;
  scryfall_printings: Array<{ scryfall_id: string; set_code: string; collector_number: string; released_at: string | null; image_url: string | null }>;
  market_data: MarketDataEntry[];
  format_stats: FormatStatsEntry[];
}

interface FormatStatsEntry {
  set_code: string;
  format: string;
  color: string | null;
  rarity: string | null;
  avg_last_seen_at: number | null;
  seen_sample_size: number | null;
  avg_taken_at: number | null;
  taken_sample_size: number | null;
  games_played_win_rate: number | null;
  games_played_sample_size: number | null;
  opening_hand_win_rate: number | null;
  opening_hand_sample_size: number | null;
  games_drawn_win_rate: number | null;
  games_drawn_sample_size: number | null;
  games_in_hand_win_rate: number | null;
  games_in_hand_sample_size: number | null;
  games_not_seen_win_rate: number | null;
  games_not_seen_sample_size: number | null;
  improvement_in_hand: number | null;
  as_of: Date;
}

interface EffectParamContains {
  /** The raw Forge key to match, e.g. "Origin", "ValidTgts", "TokenScript" -- exactly as it appears
   *  in a step's params/conditions (see forge-script.ts's EffectStep), not a normalized/renamed key.
   *  Origin/Destination/ChangeType are checked against zone_change too, not just params/conditions --
   *  see ZONE_CHANGE_KEY_MAP. */
  key: string;
  /** Case-insensitive substring match against that key's value (its EffectClause type OR any of its
   *  modifiers). */
  value_contains: string;
}

interface QueryCardsFilters {
  /** Exact (case-insensitive) name match against any of these -- batch lookup. Highest priority --
   *  takes precedence over every other filter below when present (this is "give me exactly these
   *  cards," not a search). */
  names?: string[];
  /** Oracle_id batch lookup (the `cards` collection's own _id) -- for resolving stored references
   *  like a deck's `cards`/`commander.oracle_ids` arrays back to real card data. Same priority as
   *  `names` (checked first, since callers with oracle_ids already know exactly which docs they
   *  want, same as a name lookup). */
  oracle_ids?: string[];
  /** Arena's numeric grpIds -- batch lookup for resolving a draft pack/pick history in one call.
   *  A card can have several (one per Arena printing). Same priority as `names`/`oracle_ids`. */
  arena_grp_ids?: number[];
  name_contains?: string;
  /** Cards whose color_identity is a SUBSET of this list -- the standard "legal to include under
   *  this commander" filter. Omit for no color-identity restriction. */
  color_identity_subset_of?: string[];
  /** Cards whose `colors` array includes ALL of these. Distinct from color_identity_subset_of. */
  colors_include?: string[];
  category?: string;
  cmc_min?: number;
  cmc_max?: number;
  oracle_text_contains?: string;
  legal_in?: string;
  max_price_usd?: number;
  /** Matches any card with at least one effect step whose Forge ApiType effect name is in this list
   *  (OR-matched, so hedge with multiple candidates rather than guessing one exact name -- e.g.
   *  ["Destroy","DestroyAll","Exile","ExileAll"] for removal, ["DealDamage"] for direct damage,
   *  ["Sacrifice","SacrificeAll"] for sac outlets/edicts). Forge's real vocabulary is ~200 distinct
   *  names, mostly plain English verb-phrases (Draw, Discard, Counter, Tap, GainLife, LoseLife,
   *  PutCounter, Mill...); when unsure, run a query WITHOUT this filter first and inspect a few
   *  results' `effects[].result[].effect` values to confirm the exact spelling before narrowing. */
  effect_in?: string[];
  /** Narrows to effects of this specific kind -- e.g. 'activate' for "has an ACTIVATED removal
   *  ability" vs any removal regardless of how it fires, or 'static' with no effect_in at all for
   *  "any static ability, don't care what it does." Combines with effect_in on the SAME effect entry
   *  (a card with a triggered Draw AND a separate activated Destroy won't match
   *  {effect_in:["Destroy"], trigger_kind:"triggered"} -- the kind and effect must belong to the
   *  same ability, not just both exist somewhere on the card). */
  trigger_kind?: "cast" | "activate" | "triggered" | "static" | "replacement";
  /** Precision filter within the SAME step matched by effect_in (or any step if effect_in is
   *  omitted) -- checked against that step's params/conditions AND, for Origin/Destination/
   *  ChangeType, its zone_change too. Examples: tutors = effect_in: ["ChangeZone"],
   *  effect_param_contains: {key: "Origin", value_contains: "Library"} (add {key: "Destination",
   *  value_contains: "Hand"} as a second query to narrow further -- only one key/value pair per
   *  call, run two queries and intersect if you need both). Player-targeted damage = effect_in:
   *  ["DealDamage"], effect_param_contains: {key: "ValidTgts", value_contains: "Player"} (also try
   *  "Opponent" -- Forge scripts vary). */
  effect_param_contains?: EffectParamContains;
  /** oracle_id -> scryfall_id, for pricing/imagery a SPECIFIC printing instead of the default
   *  (most-recent-release) one -- e.g. deck-analysis.ts pricing a deck whose owner pinned a printing
   *  for some cards (see manaramp's schema/decks.ts printing_preferences). Only affects which
   *  printing's price_usd/image_url a result shows, never which cards match the query. */
  printing_preferences?: Record<string, string>;
  limit?: number;
}

interface CardSummary {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  cmc: number | null;
  type_line: string;
  category: string;
  oracle_text: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string[];
  color_identity: string[];
  legalities: Record<string, string>;
  arena_grp_ids: number[];
  keywords: string[] | null;
  /** Empty array means checked and confirmed no scripted ability (Forge has no vocabulary for
   *  "does nothing," a blank result is the real, complete answer for a vanilla creature) -- NOT the
   *  same as this card never having been checked at all, which this package has no way to represent
   *  since every card fed through manaramp's ingest sweep gets checked. */
  effects: Effect[];
  /** The printing used to resolve this -- pinned (printing_preferences) if given and valid, else
   *  whichever printing released most recently. Null only if this card has no scryfall_printings at
   *  all (shouldn't happen for a real card). */
  printing: { scryfall_id: string; set_code: string; collector_number: string } | null;
  price_usd: number | null;
  image_url: string | null;
  format_stats: FormatStatsEntry[];
}

/** `pinnedScryfallId` wins if it actually matches one of this card's printings; otherwise whichever
 *  printing has the latest `released_at` (a plain string compare -- always YYYY-MM-DD, so
 *  lexicographic order IS chronological order); otherwise the first recorded printing as a last
 *  resort for a card synced before released_at was backfilled onto every entry. Same logic as
 *  manaramp's own src/lib/server/cards/pricing.ts -- kept as a separate copy per this repo's
 *  established boundary (manaramp doesn't depend on manaramp-mcp), not shared. */
function pickDefaultPrinting(printings: MongoCardDoc["scryfall_printings"], pinnedScryfallId?: string): MongoCardDoc["scryfall_printings"][number] | null {
  if (pinnedScryfallId) {
    const pinned = printings.find((p) => p.scryfall_id === pinnedScryfallId);
    if (pinned) return pinned;
  }
  if (printings.length === 0) return null;
  let best = printings[0];
  for (const p of printings) {
    if ((p.released_at ?? "") > (best.released_at ?? "")) best = p;
  }
  return best;
}

function resolvePriceForEntry(entry: MarketDataEntry | undefined, priceSource: "cardkingdom" | "manapool"): number | null {
  if (!entry) return null;
  const preferred = priceSource === "manapool" ? entry.manapool : entry.cardkingdom;
  const other = priceSource === "manapool" ? entry.cardkingdom : entry.manapool;
  return preferred?.price_usd ?? other?.price_usd ?? null;
}

/** Every TokenScript$ value referenced anywhere in one card's effects tree, walking into
 *  nested_effects (both a step's own and the trigger's) and a Branch step's true_result/false_result
 *  arms -- a TokenScript$ hidden inside a nested ability (e.g. an Effect-object token maker) or only
 *  reachable through a conditional fork is just as real a reference as one on a top-level step.
 *  Mirrors manaramp's sync-token-scripts.ts's own collectTokenScriptNames exactly (same repo-boundary
 *  duplication as everything else in this file). `?? []` throughout -- a card synced before
 *  nested_effects/branch existed has no such key at all on its stored effects, not an empty array.
 *  `Array.isArray(tokenScript)` (found live, 2026-09-22): a card that predates the EffectValue-array
 *  restructuring stores a bare STRING here instead (e.g. Generous Gift's real stored
 *  params.TokenScript: "g_3_3_elephant") -- iterating it with `for...of` doesn't throw, it silently
 *  walks it CHARACTER BY CHARACTER, which is how a bogus token_scripts._id: null stub entry ended up
 *  in production. */
function collectTokenScriptNames(effects: Effect[]): Set<string> {
  const names = new Set<string>();
  const visitStep = (step: EffectStep) => {
    const tokenScript = step.params["TokenScript"];
    if (Array.isArray(tokenScript)) for (const clause of tokenScript) names.add(clause.type);
    for (const nested of step.nested_effects ?? []) visitEffect(nested);
    if (step.branch) {
      for (const s of step.branch.true_result) visitStep(s);
      for (const s of step.branch.false_result) visitStep(s);
    }
    for (const choiceSteps of Object.values(step.choices ?? {})) {
      for (const s of choiceSteps) visitStep(s);
    }
  };
  const visitEffect = (e: Effect) => {
    for (const step of e.result) visitStep(step);
    for (const nested of e.trigger.nested_effects ?? []) visitEffect(nested);
  };
  for (const e of effects) visitEffect(e);
  return names;
}

/** Rebuilds `effects`, attaching `tokens` to every step/trigger that references a name present in
 *  `tokensById` -- see EffectStep.tokens' own doc comment for why this can't just be left as a bare
 *  filename. A name NOT in `tokensById` (not yet resolved by manaramp's sync-token-scripts.ts, or a
 *  broken/typo'd reference) is left unenriched rather than guessed at. Same `?? []`/Array.isArray
 *  defensiveness as collectTokenScriptNames above -- a pre-nested_effects/pre-EffectValue-array card's
 *  steps have no such key at all, or a bare string instead of an array. */
function enrichEffectsWithTokens(effects: Effect[], tokensById: Map<string, TokenDescriptor>): Effect[] {
  const tokensFor = (step: { params: Record<string, EffectValue> }): Record<string, TokenDescriptor> | undefined => {
    const tokenScript = step.params["TokenScript"];
    if (!Array.isArray(tokenScript)) return undefined;
    const tokens: Record<string, TokenDescriptor> = {};
    for (const clause of tokenScript) {
      const descriptor = tokensById.get(clause.type);
      if (descriptor) tokens[clause.type] = descriptor;
    }
    return Object.keys(tokens).length > 0 ? tokens : undefined;
  };
  const enrichEffect = (e: Effect): Effect => ({
    trigger: { ...e.trigger, nested_effects: (e.trigger.nested_effects ?? []).map(enrichEffect) },
    result: e.result.map(enrichStep),
  });
  // A DB$ Branch's own true_result/false_result arms and a DB$ Charm's own choices (see EffectBranch/
  // EffectStep.choices' own doc comments) are just as real a place for a TokenScript reference to
  // live as any other step -- enriched the same way.
  function enrichStep(step: EffectStep): EffectStep {
    return {
      ...step,
      nested_effects: (step.nested_effects ?? []).map(enrichEffect),
      tokens: tokensFor(step),
      branch: step.branch
        ? { ...step.branch, true_result: step.branch.true_result.map(enrichStep), false_result: step.branch.false_result.map(enrichStep) }
        : null,
      choices: Object.fromEntries(Object.entries(step.choices ?? {}).map(([name, choiceSteps]) => [name, choiceSteps.map(enrichStep)])),
    };
  }
  return effects.map(enrichEffect);
}

function toSummary(doc: MongoCardDoc, priceSource: "cardkingdom" | "manapool", tokensById: Map<string, TokenDescriptor>, pinnedScryfallId?: string): CardSummary {
  const printings = doc.scryfall_printings ?? [];
  const printing = pickDefaultPrinting(printings, pinnedScryfallId);
  const marketEntry = (doc.market_data ?? []).find((m) => m.scryfall_id === printing?.scryfall_id);
  return {
    oracle_id: doc._id,
    name: doc.name,
    mana_cost: doc.mana_cost,
    cmc: doc.cmc,
    type_line: doc.type_line,
    category: doc.category,
    oracle_text: doc.oracle_text,
    power: doc.power,
    toughness: doc.toughness,
    loyalty: doc.loyalty,
    colors: doc.colors,
    color_identity: doc.color_identity,
    legalities: doc.legalities,
    arena_grp_ids: doc.arena_grp_ids ?? [],
    keywords: doc.keywords ?? null,
    effects: enrichEffectsWithTokens(doc.effects ?? [], tokensById),
    printing: printing ? { scryfall_id: printing.scryfall_id, set_code: printing.set_code, collector_number: printing.collector_number } : null,
    price_usd: resolvePriceForEntry(marketEntry, priceSource),
    image_url: printing?.image_url ?? null,
    format_stats: doc.format_stats ?? [],
  };
}

/** manaramp's schema/token_scripts.ts collection, projected to exclude token_raw (private, never
 *  read here). One query per queryCards call, batched across every doc's distinct TokenScript$ names
 *  -- not a lookup per card, per the same "one canonical query" rule this whole file already follows
 *  for `cards` itself. */
async function resolveTokenScripts(db: Db, docs: MongoCardDoc[]): Promise<Map<string, TokenDescriptor>> {
  const names = new Set<string>();
  for (const doc of docs) for (const name of collectTokenScriptNames(doc.effects ?? [])) names.add(name);
  if (names.size === 0) return new Map();

  const found = await db
    .collection<TokenDescriptor & { _id: string }>("token_scripts")
    .find(
      { _id: { $in: [...names] }, name: { $ne: "" } },
      { projection: { _id: 1, name: 1, types: 1, pt: 1, colors: 1, keywords: 1, effects: 1 } }
    )
    .toArray();
  return new Map(found.map(({ _id, ...descriptor }) => [_id, descriptor]));
}

/** Shared tail end for every queryCards branch -- resolves TokenScript$ references once across the
 *  whole result batch, then maps each doc to its CardSummary. */
async function finalize(db: Db, docs: MongoCardDoc[], priceSource: "cardkingdom" | "manapool", pinned: (id: string) => string | undefined): Promise<CardSummary[]> {
  const tokensById = await resolveTokenScripts(db, docs);
  return docs.map((doc) => toSummary(doc, priceSource, tokensById, pinned(doc._id)));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Origin$/Destination$/ChangeType$ moved out of a ChangeZone step's own params/conditions into
 *  zone_change (2026-09-22) -- effect_param_contains naming one of these keys needs to check there
 *  too, not just params/conditions. */
const ZONE_CHANGE_KEY_MAP: Record<string, "from" | "to" | "what"> = { Origin: "from", Destination: "to", ChangeType: "what" };

function keyPaths(key: string): string[] {
  const paths = [`params.${key}`, `conditions.${key}`];
  const zoneKey = ZONE_CHANGE_KEY_MAP[key];
  if (zoneKey) paths.push(`zone_change.${zoneKey}`);
  return paths;
}

/** The one canonical query against manaramp's `cards` collection -- see file header. `priceSource`
 *  (2026-09-21, defaults to 'cardkingdom' for callers that don't pass one -- no behavior change for
 *  them) resolves each result's CardSummary.price_usd to the calling account's own preference; see
 *  tools/shared/deck-analysis.ts's analyzeDecklist for the main consumer. */
async function queryCards(db: Db, filters: QueryCardsFilters, priceSource: "cardkingdom" | "manapool" = "cardkingdom"): Promise<CardSummary[]> {
  const pinned = (id: string) => filters.printing_preferences?.[id];

  if (filters.names?.length) {
    const regexes = filters.names.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i"));
    const docs = await db.collection<MongoCardDoc>("cards").find({ name: { $in: regexes } }).toArray();
    return finalize(db, docs, priceSource, pinned);
  }
  if (filters.oracle_ids?.length) {
    const docs = await db.collection<MongoCardDoc>("cards").find({ _id: { $in: filters.oracle_ids } }).toArray();
    return finalize(db, docs, priceSource, pinned);
  }
  if (filters.arena_grp_ids?.length) {
    const docs = await db.collection<MongoCardDoc>("cards").find({ arena_grp_ids: { $in: filters.arena_grp_ids } }).toArray();
    return finalize(db, docs, priceSource, pinned);
  }

  const query: Record<string, unknown> = {};

  if (filters.name_contains) {
    query.name = { $regex: filters.name_contains, $options: "i" };
  }
  if (filters.color_identity_subset_of) {
    query.color_identity = { $not: { $elemMatch: { $nin: filters.color_identity_subset_of } } };
  }
  if (filters.colors_include?.length) {
    query.colors = { $all: filters.colors_include };
  }
  if (filters.category) {
    query.category = filters.category;
  }
  if (filters.cmc_min !== undefined || filters.cmc_max !== undefined) {
    const cmcFilter: Record<string, number> = {};
    if (filters.cmc_min !== undefined) cmcFilter.$gte = filters.cmc_min;
    if (filters.cmc_max !== undefined) cmcFilter.$lte = filters.cmc_max;
    query.cmc = cmcFilter;
  }
  if (filters.oracle_text_contains) {
    query.oracle_text = { $regex: filters.oracle_text_contains, $options: "i" };
  }
  if (filters.legal_in) {
    query[`legalities.${filters.legal_in}`] = "legal";
  }
  if (filters.max_price_usd !== undefined) {
    // Any printing at or under the ceiling counts -- a card isn't excluded just because its
    // DEFAULT (most-recent) printing happens to be pricier than an older one.
    query.market_data = {
      $elemMatch: { $or: [{ "cardkingdom.price_usd": { $lte: filters.max_price_usd } }, { "manapool.price_usd": { $lte: filters.max_price_usd } }] },
    };
  }

  // Ability filtering, rebuilt on `effects` (see file header) -- effect_in/trigger_kind/
  // effect_param_contains all correlate to the SAME entry in the effects[] array via one outer
  // $elemMatch, so "activated Destroy" doesn't accidentally match a card with a triggered Destroy
  // and an unrelated activated Draw.
  if (filters.effect_in?.length || filters.trigger_kind || filters.effect_param_contains) {
    const effectMatch: Record<string, unknown> = {};
    if (filters.trigger_kind) effectMatch["trigger.kind"] = filters.trigger_kind;

    const stepMatch: Record<string, unknown> = {};
    if (filters.effect_in?.length) stepMatch.effect = { $in: filters.effect_in };
    if (filters.effect_param_contains) {
      const { key, value_contains } = filters.effect_param_contains;
      const re = { $regex: value_contains, $options: "i" };
      // EffectValue is an array of {type, modifiers} subdocuments (2026-09-22), not a plain
      // string/string[] -- match against either field, on every path this key could live at.
      stepMatch.$or = keyPaths(key).flatMap((p) => [{ [`${p}.type`]: re }, { [`${p}.modifiers`]: re }]);
    }
    // Only require a matching result step when one was actually asked for -- a bare trigger_kind
    // query (e.g. "any static ability") should still match a static with an empty result array.
    if (Object.keys(stepMatch).length > 0) {
      effectMatch.result = { $elemMatch: stepMatch };
    }
    query.effects = { $elemMatch: effectMatch };
  }

  const docs = await db
    .collection<MongoCardDoc>("cards")
    .find(query)
    .limit(Math.min(filters.limit ?? 25, 100))
    .toArray();

  return finalize(db, docs, priceSource, pinned);
}

export { queryCards };
export type { QueryCardsFilters, CardSummary, FormatStatsEntry, Effect, EffectStep, EffectValue, EffectClause, ZoneChange, EffectCostPart, EffectBranch, TokenDescriptor };
