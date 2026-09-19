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
 * recursion_found (2026-09-17, added alongside the new Forge-derived abilities booleans -- see
 * schema/cards.ts in the `manaramp` repo) work the same way as game_changers_found/etc, just backed
 * by Forge's own per-card classification instead of a hardcoded name list. Takes the already-fetched
 * `cards` from tools/shared/deck-analysis.ts (optimize_deck/publish_deck)'s own queryCards call (it needs the SAME card data tools/shared/deck-analysis.ts (optimize_deck/publish_deck)
 * already has for consistency checks/pricing) instead of running a second independent `cards` query
 * -- one canonical query per collection per call, same rule as everywhere else in this package.
 */

import type { Db } from "mongodb";
import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "./bracket-reference-data.js";
import { queryCombos, type ComboResult } from "../query/combos.js";
import type { CardSummary } from "../query/cards.js";

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
}

async function gatherDeckFacts(db: Db, commanderNames: string[], cardNames: string[], cards: CardSummary[]): Promise<DeckFacts> {
  const allNames = Array.from(new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));

  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const combosFound = await queryCombos(db, allNames);

  const byFlag = (flag: keyof NonNullable<CardSummary["abilities"]>) =>
    cards.filter((c) => c.abilities?.[flag] === true).map((c) => c.name);

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
    recursion_found: byFlag("is_recursion"),
  };
}

export { gatherDeckFacts };
export type { DeckFacts };
