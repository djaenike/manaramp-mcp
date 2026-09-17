import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "./bracket-reference-data.js";
import { queryCombos } from "../query/combos.js";
async function gatherDeckFacts(db, commanderNames, cardNames, cards) {
  const allNames = Array.from(/* @__PURE__ */ new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));
  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const combosFound = await queryCombos(db, allNames);
  const byFlag = (flag) => cards.filter((c) => c.abilities?.[flag] === true).map((c) => c.name);
  return {
    game_changers_found: gameChangersFound,
    mass_land_denial_found: mldFound,
    extra_turns_found: extraTurnsFound,
    combos_found: combosFound,
    tutors_found: byFlag("is_tutor"),
    land_ramp_found: byFlag("is_land_ramp"),
    extra_land_drops_found: byFlag("is_extra_land_drop"),
    token_generators_found: byFlag("is_token_generator"),
    counterspells_found: byFlag("is_counterspell"),
    recursion_found: byFlag("is_recursion")
  };
}
export {
  gatherDeckFacts
};
