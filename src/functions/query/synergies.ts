/**
 * functions/synergies.ts -- the ONE place that queries manaramp's `commander_synergies` Mongo
 * collection. Consolidated 2026-09-17 (fifth pass) from sub-tools/edhrec/{client,recommendations}.ts
 * -- "edhrec" as a folder name was misleading the same way "scryfall" was for cards.ts: this reads
 * already-ingested Mongo data, not a live EDHREC page.
 *
 * Keyed by commander, not arbitrary card -- see querySynergies' own doc comment for why there's no
 * per-card equivalent.
 */

import type { Db } from "mongodb";

// Converts a commander name into the slug this collection is keyed by, e.g.
// "Atraxa, Grand Unifier" -> "atraxa-grand-unifier". Matches EDHREC's own slug convention, which
// is what manaramp's ingest pipeline used as the _id when it originally wrote these documents.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface RecommendedCard {
  name: string;
  synergy_pct: number | null;
  inclusion_pct: number | null;
}

interface CommanderSynergies {
  commander: string;
  recommended_cards: RecommendedCard[];
}

interface CommanderSynergiesDoc {
  _id: string;
  commander_names: string[];
  recommended_cards: Array<{ name: string; synergy_pct: number | null; inclusion_pct: number | null }> | null;
}

/** ONLY returns data when commander_name is ITSELF a commander -- this collection is
 *  commander-keyed, not a per-arbitrary-card lookup (that data doesn't exist in manaramp's Mongo
 *  schema). */
async function querySynergies(db: Db, commander_name: string): Promise<CommanderSynergies> {
  const slug = slugify(commander_name);
  const doc = await db.collection<CommanderSynergiesDoc>("commander_synergies").findOne({ _id: slug });

  if (!doc) {
    throw new Error(`No commander_synergies entry for '${commander_name}' (slug '${slug}'). Check spelling, or this commander hasn't been ingested yet.`);
  }
  if (!doc.recommended_cards) {
    throw new Error(`'${commander_name}' is known but its recommendations haven't synced yet (recommended_cards is still null) -- try again once the daily ingest catches up.`);
  }

  return {
    commander: commander_name,
    recommended_cards: doc.recommended_cards.map((c) => ({ name: c.name, synergy_pct: c.synergy_pct, inclusion_pct: c.inclusion_pct })),
  };
}

export { querySynergies, slugify };
export type { RecommendedCard, CommanderSynergies };
