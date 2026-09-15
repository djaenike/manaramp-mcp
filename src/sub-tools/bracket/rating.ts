/**
 * sub-tools/bracket/rating.ts
 * Deterministic Bracket System (1-5) classifier. The 1-vs-2 and 4-vs-5
 * boundaries are explicitly about play INTENT in the official system, not
 * card composition — reported as ranges rather than false precision.
 */

import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "./reference_data.js";
import { findCombosInDeck, classifyComboSpeed, type ClassifiedCombo } from "../spellbook/combos.js";

interface BracketRating {
  bracket_estimate: string;
  explanation: string;
  confidence_notes: string[];
  game_changers_found: string[];
  mass_land_denial_found: string[];
  extra_turns_found: string[];
  combos_found: ClassifiedCombo[];
  data_current_as_of: string;
}

async function computeBracketRating(commanderNames: string[], cardNames: string[]): Promise<BracketRating> {
  const allNames = Array.from(new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));

  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));

  const rawCombos = await findCombosInDeck(allNames);
  const combosFound = await classifyComboSpeed(rawCombos);
  const hasFastCombo = combosFound.some((c) => c.speed === "fast");

  let bracketEstimate: string;
  let explanation: string;
  const confidenceNotes: string[] = [];

  if (gameChangersFound.length > 3 || hasFastCombo || mldFound.length > 0) {
    const reasons: string[] = [];
    if (gameChangersFound.length > 3) reasons.push(`${gameChangersFound.length} Game Changers (more than bracket 3's limit of 3)`);
    if (hasFastCombo) reasons.push("a fast (turn-6-or-earlier) infinite combo");
    if (mldFound.length > 0) reasons.push(`mass land denial (${mldFound.join(", ")})`);
    bracketEstimate = "Optimized (4) at minimum";
    explanation = `At least Bracket 4 (Optimized) due to: ${reasons.join("; ")}. Brackets 4-5 place no restrictions on these beyond the banned list.`;
    confidenceNotes.push(
      "Distinguishing Optimized (4) from cEDH (5) additionally requires tournament-proven meta " +
      "consistency and tuning, which no static card list can assess — treat 5 as a possibility " +
      "only if this deck is genuinely built/tuned against the current competitive meta."
    );
  } else if (gameChangersFound.length >= 1 || combosFound.length > 0) {
    const reasons: string[] = [];
    if (gameChangersFound.length >= 1) reasons.push(`${gameChangersFound.length} Game Changer(s) (within bracket 3's limit of 3)`);
    if (combosFound.length > 0) reasons.push(`${combosFound.length} combo(s) present, all classified 'slow' (turn 7+)`);
    bracketEstimate = "Upgraded (3)";
    explanation = `Bracket 3 (Upgraded): ${reasons.join("; ")}, and no mass land denial.`;
  } else {
    bracketEstimate = "Core (2) or below";
    explanation = "No Game Changers, no fully-assembled combos, and no mass land denial found — clears the bar for Bracket 2 (Core) or lower.";
    confidenceNotes.push(
      "Distinguishing Core (2) from Exhibition (1) is explicitly about intent in the official system " +
      "(house-ruling / self-expression / joke decks vs. baseline precon-level power), not card " +
      "composition — this tool can't determine that from a card list alone."
    );
  }

  if (extraTurnsFound.length > 0) {
    confidenceNotes.push(
      `${extraTurnsFound.length} extra-turn card(s) present (${extraTurnsFound.join(", ")}) — bracket rules ` +
      "care whether these are chained via untap/cost-reduction engines, which is a board-state question " +
      "this tool can't evaluate from a card list alone."
    );
  }

  return {
    bracket_estimate: bracketEstimate,
    explanation,
    confidence_notes: confidenceNotes,
    game_changers_found: gameChangersFound,
    mass_land_denial_found: mldFound,
    extra_turns_found: extraTurnsFound,
    combos_found: combosFound,
    data_current_as_of: "2026-02-09 Game Changers update",
  };
}

export { computeBracketRating };
export type { BracketRating };
