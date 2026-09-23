/**
 * functions/reference/bracket-facts.ts (moved from sub-tools/bracket/facts.ts, 2026-09-17, sixth
 * pass, functions/ split into parsing/push/query/reference subfolders)
 *
 * Gathers the raw facts the Commander Bracket System cares about -- which Game Changers/mass land
 * denial/extra-turn cards are present, and which combos are fully assembled -- WITHOUT deciding a
 * bracket label. That decision is the calling model's job, same as wincon_summary/general_strategy
 * -- see tools/shared/deck-analysis.ts (optimize_deck/publish_deck)'s bracket_estimate input field. This file only ever answers "what's
 * actually in this deck," never "what bracket is that." Calls functions/query/combos.ts's
 * queryCombos for the combo-detection step -- not a separate `combos` query of its own.
 *
 * tutors_found/land_ramp_found/extra_land_drops_found/token_generators_found/counterspells_found/
 * recursion_found (2026-09-17, originally backed by Forge-derived abilities booleans -- see
 * schema/cards.ts in the `manaramp` repo) work the same way as game_changers_found/etc, just backed
 * by Forge's own per-card classification instead of a hardcoded name list. Takes the already-fetched
 * `cards` from tools/shared/deck-analysis.ts (optimize_deck/publish_deck)'s own queryCards call (it needs the SAME card data tools/shared/deck-analysis.ts (optimize_deck/publish_deck)
 * already has for consistency checks/pricing) instead of running a second independent `cards` query
 * -- one canonical query per collection per call, same rule as everywhere else in this package.
 *
 * Rebuilt on `effects` (2026-09-22), not the old abilities.is_X booleans -- see functions/query/
 * cards.ts's own header for the full reasoning. The matching RULES below are a deliberate, faithful
 * port of exactly what each old boolean used to mean (manaramp's forge-script.ts's
 * classifyZoneChanges/hasExtraLandDrop/effect-name scan), not a fresh reinterpretation -- e.g.
 * "tutor" is still specifically ChangeZone Library->Hand, not "any card-selection effect." The
 * difference now is these rules live here as plain data (EffectFilter objects) instead of being
 * pre-computed once at ingest time -- extending or correcting one is a code change in THIS file, not
 * a database re-sweep.
 */

import type { Db } from "mongodb";
import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "./bracket-reference-data.js";
import { queryCombos, type ComboResult } from "../query/combos.js";
import type { CardSummary, Effect, EffectStep, EffectValue } from "../query/cards.js";

/** Origin$/Destination$/ChangeType$ moved out of a ChangeZone step's own params/conditions into
 *  zone_change (2026-09-22, see query/cards.ts's header) -- a rule below that names one of these
 *  keys needs to look there too. */
const ZONE_CHANGE_KEY_MAP: Record<string, "from" | "to" | "what"> = { Origin: "from", Destination: "to", ChangeType: "what" };

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
  /** Added 2026-09-22, same weight as every other *_found fact -- combos_found used to be the only
   *  fact with any real elaboration (permalink/steps/speed), which skewed how validate_and_submit
   *  got used in practice ("too combo-oriented" feedback). These two round out the deck's real
   *  card-advantage/interaction picture without singling any one category out. */
  card_draw_found: string[];
  removal_found: string[];
}

/** One matching rule against a single effect step -- see this file's header. `effect` is an exact
 *  Forge ApiType match; `paramsInclude` is an AND of key/substring checks against that step's
 *  params/conditions (Origin$/Destination$/ChangeType$ can land in either depending on whether the
 *  step is a top-level A:/S: line's own first step or a walked SubAbility$ step -- see
 *  forge-script.ts's EffectStep -- so both are checked); `paramKeyExists` just needs the key present,
 *  any value (e.g. AdjustLandPlays$'s value was never checked by the old regex either, just its
 *  presence anywhere in the script). */
interface EffectFilter {
  effect?: string;
  paramsInclude?: Array<{ key: string; valueContains: string }>;
  paramKeyExists?: string;
}

/** Normalizes a raw params/conditions value into the current EffectValue shape -- found live
 *  (2026-09-22, review sweep): a card that predates the EffectValue-array restructuring (most of the
 *  ~26,920-card database still does -- resetting forge_effects_synced_at only clears the PENDING
 *  marker, never the stale content itself) has a bare STRING here instead (e.g. Generous Gift's real
 *  stored params.TokenScript: "g_3_3_elephant"). Calling `.some()` on that raw string threw a real,
 *  reproducible TypeError -- i.e. this would crash validate_and_submit/format_guidelines's whole
 *  gatherDeckFacts call for any deck containing a not-yet-resynced card whose effects include a
 *  paramsInclude-checked key (tutor/land_ramp/recursion all check one). A bare string is exactly what
 *  one EffectValue clause with no modifiers used to look like before the array wrapper existed, so
 *  coercing it that way keeps old cards correctly matched rather than silently excluded. */
function asEffectValue(v: unknown): EffectValue {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [{ type: v, modifiers: [] }];
  return [];
}

function stepValue(step: EffectStep, key: string): EffectValue | undefined {
  const zoneKey = ZONE_CHANGE_KEY_MAP[key];
  if (zoneKey) {
    const fromZone = step.zone_change?.[zoneKey];
    if (fromZone) return fromZone;
  }
  const raw = step.params[key] ?? step.conditions[key];
  return raw === undefined ? undefined : asEffectValue(raw);
}

function effectValueContains(value: EffectValue, needle: string): boolean {
  const lower = needle.toLowerCase();
  return value.some((clause) => clause.type.toLowerCase().includes(lower) || clause.modifiers.some((m) => m.toLowerCase().includes(lower)));
}

function stepMatches(step: EffectStep, filter: EffectFilter): boolean {
  if (filter.effect && step.effect !== filter.effect) return false;
  if (filter.paramKeyExists && stepValue(step, filter.paramKeyExists) === undefined) return false;
  if (filter.paramsInclude) {
    for (const { key, valueContains } of filter.paramsInclude) {
      const v = stepValue(step, key);
      if (v === undefined) return false;
      if (!effectValueContains(v, valueContains)) return false;
    }
  }
  return true;
}

/** Flattens result[] plus every step's nested_effects[].result[] (recursively), a Branch step's own
 *  true_result/false_result arms, AND a Charm step's own choices (every mode, not just the ones
 *  chosen) into one flat list -- an ability entirely defined via TriggersWhenSpent$/StaticAbilities$
 *  (e.g. Domri Rade's ultimate granting keywords through a nested static -- see query/cards.ts's
 *  nested_effects doc comment), reached only through a DB$ Branch's conditional fork (see
 *  query/cards.ts's EffectBranch doc comment), or living inside a DB$ Charm's Choices$ (see
 *  query/cards.ts's EffectStep.choices doc comment -- every "choose one or more --" modal spell in the
 *  game) would otherwise be invisible to every rule below, the same blind spot that used to hide
 *  TriggersWhenSpent$/StaticAbilities$ inside `formulas` as opaque text before that got fixed
 *  (2026-09-22). `?? []`/`?? {}` throughout -- a card synced before nested_effects/branch/choices
 *  existed has no such key at all on its stored effects, not an empty array/null/object (found live,
 *  2026-09-22, crashing manaramp's sync-token-scripts.ts's own walk of the same shape). */
function allSteps(effects: Effect[]): EffectStep[] {
  const steps: EffectStep[] = [];
  const visitEffect = (e: Effect) => {
    for (const step of e.result) visitStep(step);
    for (const nested of e.trigger.nested_effects ?? []) visitEffect(nested);
  };
  const visitStep = (step: EffectStep) => {
    steps.push(step);
    for (const nested of step.nested_effects ?? []) visitEffect(nested);
    if (step.branch) {
      for (const s of step.branch.true_result) visitStep(s);
      for (const s of step.branch.false_result) visitStep(s);
    }
    for (const choiceSteps of Object.values(step.choices ?? {})) {
      for (const s of choiceSteps) visitStep(s);
    }
  };
  for (const e of effects) visitEffect(e);
  return steps;
}

function cardMatchesAny(card: CardSummary, filters: EffectFilter[]): boolean {
  return allSteps(card.effects).some((step) => filters.some((f) => stepMatches(step, f)));
}

async function gatherDeckFacts(db: Db, commanderNames: string[], cardNames: string[], cards: CardSummary[]): Promise<DeckFacts> {
  const allNames = Array.from(new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));

  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const combosFound = await queryCombos(db, allNames);

  const byEffect = (...filters: EffectFilter[]) => cards.filter((c) => cardMatchesAny(c, filters)).map((c) => c.name);

  return {
    game_changers_found: gameChangersFound,
    mass_land_denial_found: mldFound,
    extra_turns_found: extraTurnsFound,
    combos_found: combosFound,
    // Same exact rule classifyZoneChanges used: ChangeZone from Library straight to Hand.
    tutors_found: byEffect({
      effect: "ChangeZone",
      paramsInclude: [{ key: "Origin", valueContains: "Library" }, { key: "Destination", valueContains: "Hand" }],
    }),
    // Library -> Battlefield, AND the thing moved is specifically a Land (distinct from tutoring a
    // land to hand, which counts as tutors_found instead, same split the old code made).
    land_ramp_found: byEffect({
      effect: "ChangeZone",
      paramsInclude: [
        { key: "Origin", valueContains: "Library" },
        { key: "Destination", valueContains: "Battlefield" },
        { key: "ChangeType", valueContains: "Land" },
      ],
    }),
    // Same as hasExtraLandDrop's whole-file regex -- just needs the key present, not any specific
    // value (Forge's own AdjustLandPlays$ amount varies per card).
    extra_land_drops_found: byEffect({ paramKeyExists: "AdjustLandPlays" }),
    // Same as has('Token') -- any step whose own effect IS Token, regardless of what triggers it.
    token_generators_found: byEffect({ effect: "Token" }),
    // Same as has('Counter').
    counterspells_found: byEffect({ effect: "Counter" }),
    // Graveyard -> Hand OR Graveyard -> Battlefield (reanimation) -- an OR of two rules, same as the
    // old code's `origin === 'Graveyard' && (destination === 'Hand' || destination === 'Battlefield')`.
    recursion_found: byEffect(
      { effect: "ChangeZone", paramsInclude: [{ key: "Origin", valueContains: "Graveyard" }, { key: "Destination", valueContains: "Hand" }] },
      { effect: "ChangeZone", paramsInclude: [{ key: "Origin", valueContains: "Graveyard" }, { key: "Destination", valueContains: "Battlefield" }] },
    ),
    // Same as manaramp's src/lib/server/cards/ability-flags.ts's CARD_DRAW_FILTERS/REMOVAL_FILTERS.
    card_draw_found: byEffect({ effect: "Draw" }),
    removal_found: byEffect({ effect: "Destroy" }, { effect: "Exile" }, { effect: "DealDamage" }),
  };
}

export { gatherDeckFacts };
export type { DeckFacts };
