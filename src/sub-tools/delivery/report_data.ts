/**
 * sub-tools/delivery/report_data.ts
 * Assembles the `actualOutput` shape defined in deck_report_template.json from the
 * already-computed consistency/bracket/price results -- no fetches of its own, pure
 * data shaping. Consumed by index.js's runChecksAndDeliver, then handed to
 * html_renderer.js to produce the final html_report.
 */

import { classifyCategory, isManaRock, isCardDraw, isRemoval } from "../scryfall/classify.js";
import type { DeckEntry, CardDetail, DeckConsistencyResult } from "../deck-building/consistency.js";
import type { BracketRating } from "../bracket/rating.js";
import type { DeckPriceTotalResult } from "../cardkingdom/pricing.js";

// NOTE: card images are deliberately left as plain Scryfall URLs here, NOT base64-inlined.
// A previous version of this file called scryfall/images.js's inlineCardImages() to embed
// every card's image directly -- that broke real decks: the MCP tool response (this data,
// wrapped in JSON, alongside the rendered HTML that embeds a second copy of it) has a hard
// client-enforced ~1MB cap, and ~90 base64-inlined images alone already blow past that for
// any real 100-card deck. images.js/inlineCardImages still exists and works for anyone who
// wants to manually re-embed images before publishing report_path's file as a shareable
// web Artifact elsewhere (that path isn't subject to the MCP tool-result cap) -- see
// CLAUDE.md's "Deck delivery pipeline" section. It is NOT called by default here.

interface BuildActualOutputArgs {
  commanderNames: string[];
  deckEntries: DeckEntry[];
  decklistText: string;
  consistency: DeckConsistencyResult;
  bracket: BracketRating;
  price: DeckPriceTotalResult;
  wincon_summary: string;
  general_strategy: string;
  bracket_level_requested?: string | null;
}

interface DeckListEntry {
  name: string;
  quantity: number;
  category: string;
  priceUsd: number | null;
  imageUrl: string | null;
  manaCost: string;
  typeLine: string;
  oracleText: string;
}

interface ActualOutput {
  commander: string;
  priceUsd: number;
  bracket: string;
  combos: Array<{ pieces: string[]; speed: string }>;
  strategy: string;
  wincons: string[];
  fullDeckList: DeckListEntry[];
  moxfieldImport: string;
  numberOfLands: number;
  numberOfManaRocks: number;
  numberOfInstants: number;
  numberOfSorceries: number;
  numberOfEnchantments: number;
  numberOfArtifacts: number;
  numberOfCreatures: number;
  numberOfPlaneswalkers: number;
  cardDrawCount: number;
  removalCount: number;
  manaCurve: Record<string, number> | null;
  curveOutProbability: Record<string, number | string> | null;
  consistencyIssues: string[];
  bracketLevelMatchesRequest: boolean | null;
  otherRelevantInfo: string | null;
}

function extractBracketNumber(s: unknown): string | null {
  const m = String(s ?? "").match(/\d+/);
  return m ? m[0] : null;
}

function buildActualOutput({
  commanderNames, deckEntries, decklistText, consistency, bracket, price,
  wincon_summary, general_strategy, bracket_level_requested,
}: BuildActualOutputArgs): ActualOutput {
  const cardDetails: Map<string, CardDetail> = consistency.card_details ?? new Map();

  const priceByName = new Map<string, number>();
  for (const p of price.breakdown ?? []) {
    if (!priceByName.has(p.name)) priceByName.set(p.name, p.price_usd);
  }

  const toListEntry = (name: string, qty: number, category: string): DeckListEntry => {
    const details = cardDetails.get(name);
    return {
      name,
      quantity: qty,
      category,
      priceUsd: priceByName.get(name) ?? null,
      imageUrl: details?.image_url ?? null,
      manaCost: details?.mana_cost ?? "",
      typeLine: details?.type_line ?? "",
      oracleText: details?.oracle_text ?? "",
    };
  };

  const fullDeckList: DeckListEntry[] = [
    ...commanderNames.map((name) => toListEntry(name, 1, "Commander")),
    ...deckEntries.map((e) => toListEntry(e.name, e.qty, classifyCategory(cardDetails.get(e.name)?.type_line))),
  ];

  const counts = {
    numberOfLands: 0, numberOfManaRocks: 0, numberOfInstants: 0, numberOfSorceries: 0,
    numberOfEnchantments: 0, numberOfArtifacts: 0, numberOfCreatures: 0, numberOfPlaneswalkers: 0,
    cardDrawCount: 0, removalCount: 0,
  };
  const categoryToCountKey: Record<string, keyof typeof counts> = {
    Land: "numberOfLands", Instant: "numberOfInstants", Sorcery: "numberOfSorceries",
    Enchantment: "numberOfEnchantments", Artifact: "numberOfArtifacts", Creature: "numberOfCreatures",
    Planeswalker: "numberOfPlaneswalkers",
  };
  for (const entry of deckEntries) {
    const details = cardDetails.get(entry.name);
    const countKey = categoryToCountKey[classifyCategory(details?.type_line)];
    if (countKey) counts[countKey] += entry.qty;
    if (isManaRock(details)) counts.numberOfManaRocks += entry.qty;
    if (isCardDraw(details)) counts.cardDrawCount += entry.qty;
    if (isRemoval(details)) counts.removalCount += entry.qty;
  }

  const wincons = wincon_summary.split(/;|\n/).map((s) => s.trim()).filter(Boolean);

  const otherRelevantInfoParts: string[] = [];
  if (consistency.not_found?.length) {
    otherRelevantInfoParts.push(`Not found on Scryfall (excluded from price/report detail): ${consistency.not_found.join(", ")}.`);
  }

  return {
    commander: commanderNames.join(" / "),
    priceUsd: price.total_usd,
    bracket: bracket.bracket_estimate,
    combos: (bracket.combos_found ?? []).map((c) => ({ pieces: c.pieces, speed: c.speed })),
    strategy: general_strategy,
    wincons: wincons.length ? wincons : [wincon_summary],
    fullDeckList,
    moxfieldImport: decklistText,
    ...counts,
    manaCurve: consistency.mana_curve ?? null,
    curveOutProbability: consistency.curve_out_probability ?? null,
    consistencyIssues: consistency.issues ?? [],
    bracketLevelMatchesRequest: bracket_level_requested
      ? extractBracketNumber(bracket_level_requested) === extractBracketNumber(bracket.bracket_estimate)
      : null,
    otherRelevantInfo: otherRelevantInfoParts.length ? otherRelevantInfoParts.join(" ") : null,
  };
}

export { buildActualOutput };
export type { ActualOutput, BuildActualOutputArgs, DeckListEntry };
