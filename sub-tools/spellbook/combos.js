/**
 * sub-tools/spellbook/combos.js
 * Commander Spellbook is a real, MIT-licensed combo database with an official
 * REST API. Query param semantics empirically verified (see original index.js
 * comments): space-separated card:"X" card:"Y" is AND; "or" does NOT behave as
 * boolean OR reliably, so findCombosInDeck queries one card at a time and
 * unions results itself, then verifies every piece is actually present.
 */

import { HEADERS, SCRYFALL_BASE, scryfallFetch } from "../scryfall/client.js";

const COMMANDER_SPELLBOOK_BASE = "https://backend.commanderspellbook.com";
const FAST_COMBO_MAX_CMC = 6; // rough proxy for "comes online by ~turn 6", not a real simulation

async function findCombos(card_names, limit) {
  const query = card_names.map((name) => `card:"${name}"`).join(" ");
  const url = `${COMMANDER_SPELLBOOK_BASE}/variants/?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(
      `Commander Spellbook request failed: ${res.status} ${res.statusText}. ` +
      `If this persists, the "q" query param may not match their current API.`
    );
  }

  const data = await res.json();
  const results = data?.results ?? [];

  return results.map((v) => ({
    id: v.id,
    cards: (v.uses ?? []).map((u) => u.card?.name).filter(Boolean),
    prerequisites: v.easyPrerequisites || v.prerequisites || null,
    steps: v.description || v.steps || null,
    results: (v.produces ?? []).map((p) => p.feature?.name).filter(Boolean),
    permalink: v.id ? `https://commanderspellbook.com/combo/${v.id}` : null,
  }));
}

/** Finds combos FULLY assembled by a given decklist (every required piece present). */
async function findCombosInDeck(allCardNames) {
  const nameSet = new Set(allCardNames.map((n) => n.toLowerCase()));
  const candidatesById = new Map();

  for (const name of allCardNames) {
    const query = `card:"${name}"`;
    const url = `${COMMANDER_SPELLBOOK_BASE}/variants/?q=${encodeURIComponent(query)}&limit=50`;
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) {
      const data = await res.json();
      for (const v of data?.results ?? []) {
        if (v.id) candidatesById.set(v.id, v);
      }
    }
    await new Promise((r) => setTimeout(r, 60)); // best-effort pacing
  }

  const fullyAssembled = [];
  for (const v of candidatesById.values()) {
    const pieces = (v.uses ?? []).map((u) => u.card?.name).filter(Boolean);
    if (pieces.length === 0) continue;
    const allPresent = pieces.every((p) => nameSet.has(p.toLowerCase()));
    if (allPresent) fullyAssembled.push({ id: v.id, pieces });
  }
  return fullyAssembled;
}

/** Classifies each fully-assembled combo fast/slow by summing its pieces' mana values. */
async function classifyComboSpeed(combos) {
  if (combos.length === 0) return [];
  const allPieceNames = Array.from(new Set(combos.flatMap((c) => c.pieces)));
  const cmcByName = new Map();

  for (let i = 0; i < allPieceNames.length; i += 75) {
    const chunk = allPieceNames.slice(i, i + 75);
    const res = await scryfallFetch(`${SCRYFALL_BASE}/cards/collection`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
    }, "collection");
    if (!res.ok) continue;
    const data = await res.json();
    for (const card of data.data ?? []) {
      cmcByName.set(card.name.toLowerCase(), card.cmc ?? 0);
    }
  }

  return combos.map((c) => {
    const totalCmc = c.pieces.reduce((sum, name) => sum + (cmcByName.get(name.toLowerCase()) ?? 0), 0);
    return { pieces: c.pieces, total_cmc: totalCmc, speed: totalCmc <= FAST_COMBO_MAX_CMC ? "fast" : "slow" };
  });
}

export { findCombos, findCombosInDeck, classifyComboSpeed, FAST_COMBO_MAX_CMC, COMMANDER_SPELLBOOK_BASE };
