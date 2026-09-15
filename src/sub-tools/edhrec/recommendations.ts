/**
 * sub-tools/edhrec/recommendations.ts
 * Same logic as index.js's edhrec_get_commander_recommendations /
 * edhrec_get_card_synergies / edhrec_get_average_decklist tools, returning
 * plain data instead of MCP-wrapped responses.
 */

import { EDHREC_BASE, slugify } from "./client.js";
import { HEADERS } from "../scryfall/client.js"; // generic HEADERS reused, no Scryfall-specific pacing needed here

interface RecommendationCategory {
  header: string;
  cards: Array<{ name: string; inclusion: number; potential_decks?: number }>;
}

interface CommanderRecommendations {
  commander: string;
  categories: RecommendationCategory[];
}

async function getCommanderRecommendations(commander_name: string): Promise<CommanderRecommendations> {
  const slug = slugify(commander_name);
  const res = await fetch(`${EDHREC_BASE}/commanders/${slug}.json`, { headers: HEADERS });

  if (res.status === 404) {
    throw new Error(`No EDHREC page found for commander '${commander_name}'. Check spelling.`);
  }
  if (!res.ok) {
    throw new Error(`EDHREC request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const cardlists = data?.container?.json_dict?.cardlists ?? [];
  if (cardlists.length === 0) {
    throw new Error(`No recommendation data found for '${commander_name}'.`);
  }

  const categories = cardlists.map((c: any) => ({
    header: c.header,
    cards: (c.cardviews ?? []).slice(0, 15).map((card: any) => ({
      name: card.name,
      inclusion: card.inclusion,
      potential_decks: card.potential_decks ?? card.num_decks,
    })),
  }));

  return { commander: commander_name, categories };
}

async function getCardSynergies(card_name: string): Promise<{ card: string; categories: RecommendationCategory[]; combos: any[] }> {
  const slug = slugify(card_name);
  const res = await fetch(`${EDHREC_BASE}/cards/${slug}.json`, { headers: HEADERS });

  if (res.status === 404) {
    throw new Error(`No EDHREC page found for card '${card_name}'. Check spelling.`);
  }
  if (!res.ok) {
    throw new Error(`EDHREC request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const cardlists = data?.container?.json_dict?.cardlists ?? [];
  const combos = (data?.panels?.combocounts ?? []).filter((c: any) => c.value !== "See More...");

  if (cardlists.length === 0 && combos.length === 0) {
    throw new Error(`No synergy data found for '${card_name}'.`);
  }

  const categories = cardlists.map((c: any) => ({
    header: c.header,
    cards: (c.cardviews ?? []).slice(0, 15).map((card: any) => ({
      name: card.name,
      inclusion: card.inclusion,
    })),
  }));

  return { card: card_name, categories, combos };
}

async function getAverageDecklist(commander_name: string): Promise<{ commander: string; deck: unknown }> {
  const slug = slugify(commander_name);
  const res = await fetch(`${EDHREC_BASE}/average-decks/${slug}.json`, { headers: HEADERS });

  if (res.status === 404) {
    throw new Error(`No EDHREC page found for commander '${commander_name}'. Check spelling.`);
  }
  if (!res.ok) {
    throw new Error(`EDHREC request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const deck = data?.deck;
  if (!deck) {
    throw new Error(`No average decklist found for '${commander_name}'.`);
  }

  return { commander: commander_name, deck };
}

export { getCommanderRecommendations, getCardSynergies, getAverageDecklist };
export type { RecommendationCategory, CommanderRecommendations };
