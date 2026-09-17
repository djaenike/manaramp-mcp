import { Db } from 'mongodb';

/**
 * functions/synergies.ts -- the ONE place that queries manaramp's `commander_synergies` Mongo
 * collection. Consolidated 2026-09-17 (fifth pass) from sub-tools/edhrec/{client,recommendations}.ts
 * -- "edhrec" as a folder name was misleading the same way "scryfall" was for cards.ts: this reads
 * already-ingested Mongo data, not a live EDHREC page.
 *
 * Keyed by commander, not arbitrary card -- see querySynergies' own doc comment for why there's no
 * per-card equivalent.
 */

declare function slugify(name: string): string;
interface RecommendedCard {
    name: string;
    synergy_pct: number | null;
    inclusion_pct: number | null;
}
interface CommanderSynergies {
    commander: string;
    recommended_cards: RecommendedCard[];
}
/** ONLY returns data when commander_name is ITSELF a commander -- this collection is
 *  commander-keyed, not a per-arbitrary-card lookup (that data doesn't exist in manaramp's Mongo
 *  schema). */
declare function querySynergies(db: Db, commander_name: string): Promise<CommanderSynergies>;

export { type CommanderSynergies, type RecommendedCard, querySynergies, slugify };
