/**
 * sub-tools/delivery/report_data.js
 * Assembles the `actualOutput` shape defined in deck_report_template.json from the
 * already-computed consistency/bracket/price results -- no fetches of its own, pure
 * data shaping. Consumed by index.js's runChecksAndDeliver, then handed to
 * html_renderer.js to produce the final html_report.
 */

import { classifyCategory, isManaRock, isCardDraw, isRemoval } from "../scryfall/classify.js";

// NOTE: card images are deliberately left as plain Scryfall URLs here, NOT base64-inlined.
// A previous version of this file called scryfall/images.js's inlineCardImages() to embed
// every card's image directly -- that broke real decks: the MCP tool response (this data,
// wrapped in JSON, alongside the rendered HTML that embeds a second copy of it) has a hard
// client-enforced ~1MB cap, and ~90 base64-inlined images alone already blow past that for
// any real 100-card deck. images.js/inlineCardImages still exists and works for anyone who
// wants to manually re-embed images before publishing report_path's file as a shareable
// web Artifact elsewhere (that path isn't subject to the MCP tool-result cap) -- see
// CLAUDE.md's "Deck delivery pipeline" section. It is NOT called by default here.

function extractBracketNumber(s) {
  const m = String(s ?? "").match(/\d+/);
  return m ? m[0] : null;
}

function buildActualOutput({
  commanderNames, deckEntries, decklistText, consistency, bracket, price,
  wincon_summary, general_strategy, bracket_level_requested,
}) {
  const cardDetails = consistency.card_details ?? new Map();

  const priceByName = new Map();
  for (const p of price.breakdown ?? []) {
    if (!priceByName.has(p.name)) priceByName.set(p.name, p.price_usd);
  }

  const toListEntry = (name, qty, category) => {
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

  const fullDeckList = [
    ...commanderNames.map((name) => toListEntry(name, 1, "Commander")),
    ...deckEntries.map((e) => toListEntry(e.name, e.qty, classifyCategory(cardDetails.get(e.name)?.type_line))),
  ];

  const counts = {
    numberOfLands: 0, numberOfManaRocks: 0, numberOfInstants: 0, numberOfSorceries: 0,
    numberOfEnchantments: 0, numberOfArtifacts: 0, numberOfCreatures: 0, numberOfPlaneswalkers: 0,
    cardDrawCount: 0, removalCount: 0,
  };
  const categoryToCountKey = {
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

  const otherRelevantInfoParts = [];
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
