/**
 * functions/decks.ts -- the ONE place that queries manaramp's `decks` Mongo collection for reads.
 * Moved 2026-09-17 (fifth pass) out of tools/query-decks.ts, which was doing this inline -- tools/
 * files are registration wrappers only now (name/description/schema/handler), no query logic of
 * their own; see CLAUDE.md's tool-consolidation section. Resolves stored oracle_ids back to real
 * card data via functions/cards.ts's queryCards (oracle_ids filter) instead of a separate `cards`
 * query.
 *
 * `decks` lives under the write-capable credential by convention (see tools/types.ts's McpContext),
 * so this takes writeDb for the decks collection itself and readDb separately for resolving cards.
 */

import type { Db } from "mongodb";
import { queryCards } from "./cards.js";

// The one canonical shape for a `decks` document -- matches manaramp's
// src/lib/server/schema/decks.ts. manage-deck.ts (the only writer) imports this same type rather
// than declaring its own separate one, so there's exactly one place this shape is defined.
interface DeckDoc {
  _id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  format: string;
  platform: string | null;
  is_public: boolean;
  cards: string[];
  sideboard: string[] | null;
  size_summary: { main: number; sideboard: number; commander: number; total: number } | null;
  commander: { oracle_ids: string[]; color_identity: string[] } | null;
  bracket: { estimate: string | null; combos_found: Array<{ pieces: string[]; speed: string }> } | null;
  mana_curve: Record<string, number> | null;
  curve_out_probability: Record<string, number | string> | null;
  consistency_issues: string[];
  price_usd: number | null;
  price_fetched_at: Date | null;
  wincon_summary: string | null;
  general_strategy: string | null;
  source: string | null;
  origin_draft_result_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeckCard {
  oracle_id: string;
  name: string;
  quantity: number;
  category: string;
  mana_cost: string | null;
  type_line: string;
  image_url: string | null;
}

interface DeckSummary {
  name: string;
  slug: string;
  format: string;
  price_usd: number | null;
  bracket: DeckDoc["bracket"];
  consistency_issues: string[];
  updated_at: Date;
}

interface DeckDetail {
  deck_id: string;
  deck_url: string;
  name: string;
  format: string;
  commander: DeckCard[];
  main_deck: DeckCard[];
  decklist_text: string;
  bracket: DeckDoc["bracket"];
  mana_curve: Record<string, number> | null;
  consistency_issues: string[];
  price_usd: number | null;
  wincon_summary: string | null;
  general_strategy: string | null;
}

/** Get the raw deck doc (for ownership checks etc) -- no card resolution. Used by manage_deck to
 *  load an existing deck's oracle_ids before editing. */
async function getDeckDoc(writeDb: Db, by: { deck_id?: string; slug?: string }): Promise<DeckDoc | null> {
  return writeDb.collection<DeckDoc>("decks").findOne(by.deck_id ? { _id: by.deck_id } : { slug: by.slug });
}

/** List the given owner's decks, summary fields only -- no per-card resolution (that's wasteful
 *  for a whole list; call queryDeckDetail for one specific deck instead). */
async function queryDeckList(writeDb: Db, ownerUserId: string): Promise<DeckSummary[]> {
  return writeDb
    .collection<DeckDoc>("decks")
    .find({ owner_user_id: ownerUserId })
    .sort({ updated_at: -1 })
    .project<DeckSummary>({ name: 1, slug: 1, format: 1, price_usd: 1, bracket: 1, consistency_issues: 1, updated_at: 1 })
    .toArray();
}

/** One deck, fully resolved: real card names/mana costs/images per oracle_id (via queryCards),
 *  plus a ready-to-paste decklist_text for feeding back into manage_deck. */
async function queryDeckDetail(readDb: Db, deck: DeckDoc): Promise<DeckDetail> {
  const commanderOracleIds = deck.commander?.oracle_ids ?? [];
  const allOracleIds = Array.from(new Set([...commanderOracleIds, ...deck.cards]));

  const cards = await queryCards(readDb, { oracle_ids: allOracleIds });
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));

  const qtyByOracleId = new Map<string, number>();
  for (const id of deck.cards) qtyByOracleId.set(id, (qtyByOracleId.get(id) ?? 0) + 1);

  const toCard = (id: string, quantity: number): DeckCard => {
    const c = byId.get(id);
    return {
      oracle_id: id,
      name: c?.name ?? id,
      quantity,
      category: c?.category ?? "Other",
      mana_cost: c?.mana_cost ?? null,
      type_line: c?.type_line ?? "",
      image_url: c?.image_url ?? null,
    };
  };

  const commanderCards = commanderOracleIds.map((id) => toCard(id, 1));
  const mainDeckCards = Array.from(qtyByOracleId.entries()).map(([id, qty]) => toCard(id, qty));

  const decklistTextLines = [
    "Commander", ...commanderCards.map((c) => `1 ${c.name}`), "",
    "Deck", ...mainDeckCards.map((c) => `${c.quantity} ${c.name}`),
  ];

  return {
    deck_id: deck._id,
    deck_url: `https://manaramp.com/decks/${deck.slug}`,
    name: deck.name,
    format: deck.format,
    commander: commanderCards,
    main_deck: mainDeckCards,
    decklist_text: decklistTextLines.join("\n"),
    bracket: deck.bracket,
    mana_curve: deck.mana_curve,
    consistency_issues: deck.consistency_issues,
    price_usd: deck.price_usd,
    wincon_summary: deck.wincon_summary,
    general_strategy: deck.general_strategy,
  };
}

export { getDeckDoc, queryDeckList, queryDeckDetail };
export type { DeckDoc, DeckCard, DeckSummary, DeckDetail };
