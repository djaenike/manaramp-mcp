/**
 * functions/combos.ts -- the ONE place that queries manaramp's `combos` Mongo collection.
 * Consolidated 2026-09-17 (fifth pass) from sub-tools/spellbook/combos.ts -- "spellbook" as a
 * folder name was misleading the same way "scryfall" was for cards.ts. Its speed classification
 * step now calls functions/cards.ts's queryCards for cmc data instead of running its own separate
 * `cards` query -- one canonical place for that collection, not two.
 *
 * One query shape: given any list of card names -- 2-3 specific candidates ("do these combo
 * together?") or a full ~100-card decklist ("which combos exist in this deck?") -- queryCombos
 * returns every documented combo whose pieces are ALL present in that list. The full-decklist case
 * is a strict superset of the small-candidate case, so one function covers both.
 */

import type { Db } from "mongodb";
import { queryCards } from "./cards.js";

interface ComboDoc {
  _id: string;
  pieces_names: string[];
  pieces: string[];
  color_identity: string[];
  result: string | null;
  steps: string[] | null;
  speed: string | null;
  spellbook_url: string | null;
}

interface ComboResult {
  id: string;
  pieces: string[];
  result: string | null;
  steps: string[] | null;
  permalink: string | null;
  total_cmc: number;
  speed: "fast" | "slow";
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

const FAST_COMBO_MAX_CMC = 6; // rough proxy for "comes online by ~turn 6", not a real simulation

/** Every documented combo whose pieces are ALL present in card_names -- see file header. */
async function queryCombos(db: Db, card_names: string[], limit?: number): Promise<ComboResult[]> {
  const nameSet = new Set(card_names.map(norm));

  // Narrow to combos that touch at least one given name, then verify full containment in JS --
  // cheap since `combos` is a small collection (thousands, not millions, of documents).
  const candidates = await db
    .collection<ComboDoc>("combos")
    .find({ pieces_names: { $in: card_names } })
    .limit(limit ? limit * 20 : 500) // headroom before the containment filter narrows it down
    .toArray();

  const assembled = candidates.filter((v) => v.pieces_names.every((p) => nameSet.has(norm(p))));
  if (assembled.length === 0) return [];

  const allPieceNames = Array.from(new Set(assembled.flatMap((v) => v.pieces_names)));
  const cardDocs = await queryCards(db, { names: allPieceNames });
  const cmcByName = new Map(cardDocs.map((c) => [norm(c.name), c.cmc ?? 0]));

  const results = assembled.map((v) => {
    const totalCmc = v.pieces_names.reduce((sum, name) => sum + (cmcByName.get(norm(name)) ?? 0), 0);
    return {
      id: v._id,
      pieces: v.pieces_names,
      result: v.result,
      steps: v.steps,
      permalink: v.spellbook_url,
      total_cmc: totalCmc,
      speed: (totalCmc <= FAST_COMBO_MAX_CMC ? "fast" : "slow") as "fast" | "slow",
    };
  });

  return limit ? results.slice(0, limit) : results;
}

export { queryCombos, FAST_COMBO_MAX_CMC };
export type { ComboResult };
