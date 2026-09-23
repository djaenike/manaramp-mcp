import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "./bracket-reference-data.js";
import { queryCombos } from "../query/combos.js";
const ZONE_CHANGE_KEY_MAP = { Origin: "from", Destination: "to", ChangeType: "what" };
function asEffectValue(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [{ type: v, modifiers: [] }];
  return [];
}
function stepValue(step, key) {
  const zoneKey = ZONE_CHANGE_KEY_MAP[key];
  if (zoneKey) {
    const fromZone = step.zone_change?.[zoneKey];
    if (fromZone) return fromZone;
  }
  const raw = step.params[key] ?? step.conditions[key];
  return raw === void 0 ? void 0 : asEffectValue(raw);
}
function effectValueContains(value, needle) {
  const lower = needle.toLowerCase();
  return value.some((clause) => clause.type.toLowerCase().includes(lower) || clause.modifiers.some((m) => m.toLowerCase().includes(lower)));
}
function stepMatches(step, filter) {
  if (filter.effect && step.effect !== filter.effect) return false;
  if (filter.paramKeyExists && stepValue(step, filter.paramKeyExists) === void 0) return false;
  if (filter.paramsInclude) {
    for (const { key, valueContains } of filter.paramsInclude) {
      const v = stepValue(step, key);
      if (v === void 0) return false;
      if (!effectValueContains(v, valueContains)) return false;
    }
  }
  return true;
}
function allSteps(effects) {
  const steps = [];
  const visitEffect = (e) => {
    for (const step of e.result) visitStep(step);
    for (const nested of e.trigger.nested_effects ?? []) visitEffect(nested);
  };
  const visitStep = (step) => {
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
function cardMatchesAny(card, filters) {
  return allSteps(card.effects).some((step) => filters.some((f) => stepMatches(step, f)));
}
async function gatherDeckFacts(db, commanderNames, cardNames, cards) {
  const allNames = Array.from(/* @__PURE__ */ new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));
  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const combosFound = await queryCombos(db, allNames);
  const byEffect = (...filters) => cards.filter((c) => cardMatchesAny(c, filters)).map((c) => c.name);
  return {
    game_changers_found: gameChangersFound,
    mass_land_denial_found: mldFound,
    extra_turns_found: extraTurnsFound,
    combos_found: combosFound,
    // Same exact rule classifyZoneChanges used: ChangeZone from Library straight to Hand.
    tutors_found: byEffect({
      effect: "ChangeZone",
      paramsInclude: [{ key: "Origin", valueContains: "Library" }, { key: "Destination", valueContains: "Hand" }]
    }),
    // Library -> Battlefield, AND the thing moved is specifically a Land (distinct from tutoring a
    // land to hand, which counts as tutors_found instead, same split the old code made).
    land_ramp_found: byEffect({
      effect: "ChangeZone",
      paramsInclude: [
        { key: "Origin", valueContains: "Library" },
        { key: "Destination", valueContains: "Battlefield" },
        { key: "ChangeType", valueContains: "Land" }
      ]
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
      { effect: "ChangeZone", paramsInclude: [{ key: "Origin", valueContains: "Graveyard" }, { key: "Destination", valueContains: "Battlefield" }] }
    ),
    // Same as manaramp's src/lib/server/cards/ability-flags.ts's CARD_DRAW_FILTERS/REMOVAL_FILTERS.
    card_draw_found: byEffect({ effect: "Draw" }),
    removal_found: byEffect({ effect: "Destroy" }, { effect: "Exile" }, { effect: "DealDamage" })
  };
}
export {
  gatherDeckFacts
};
