/**
 * sub-tools/deck-building/consistency.ts
 * Validates deck size, singleton, color identity, Commander legality, and
 * computes mana curve + curve-out probability. Does NOT detect combos —
 * that's bracket/rating.js's job. Also returns card_details (mana_cost,
 * type_line, oracle_text, image_url, cmc) per card, reused by
 * delivery/report_data.js to build the full deck report without a second
 * Scryfall fetch.
 */

import { SCRYFALL_BASE, HEADERS, scryfallFetch } from "../scryfall/client.js";

interface DeckEntry {
  qty: number;
  name: string;
}

interface CardDetail {
  mana_cost: string;
  type_line: string;
  oracle_text: string;
  image_url: string | null;
  cmc: number;
}

interface ColorIdentityViolation {
  name: string;
  card_color_identity: string[];
  offending_colors: string[];
}

interface CommanderLegalityViolation {
  name: string;
  status: string;
}

interface DeckConsistencyResult {
  issues: string[];
  total_cards: number;
  land_count: number;
  nonland_count: number;
  avg_nonland_cmc: number;
  mana_curve: Record<string, number>;
  curve_out_probability: Record<string, number | string>;
  duplicate_violations: Array<{ name: string; qty: number }>;
  color_identity_violations: ColorIdentityViolation[];
  not_commander_legal: CommanderLegalityViolation[];
  not_found: string[];
  commander_color_identity: string[];
  card_details: Map<string, CardDetail>;
}

// nCr via iterative running product/division — stays numerically small throughout.
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// P(at least `need` successes drawn in `draws` cards from a `librarySize`-card
// population containing `successes` total). Standard hypergeometric survival function.
function hypergeometricAtLeast(librarySize: number, successes: number, draws: number, need: number): number {
  const upper = Math.min(draws, successes);
  if (need > upper) return 0;
  const total = combinations(librarySize, draws);
  if (total === 0) return 0;
  let sum = 0;
  for (let i = need; i <= upper; i++) {
    sum += (combinations(successes, i) * combinations(librarySize - successes, draws - i)) / total;
  }
  return sum;
}

async function computeDeckConsistency(commander_names: string[], deck_entries: DeckEntry[]): Promise<DeckConsistencyResult> {
  const uniqueDeckNames = Array.from(new Set(deck_entries.map((e) => e.name)));
  const allIdentifierNames = Array.from(new Set([...commander_names, ...uniqueDeckNames]));

  const cardByName = new Map<string, any>();
  const notFound: string[] = [];
  for (let i = 0; i < allIdentifierNames.length; i += 75) {
    const chunk = allIdentifierNames.slice(i, i + 75);
    const res = await scryfallFetch(`${SCRYFALL_BASE}/cards/collection`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
    }, "collection");
    if (!res.ok) {
      throw new Error(`Scryfall collection request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as any;
    for (const card of data.data ?? []) {
      cardByName.set(card.name.toLowerCase(), card);
    }
    for (const nf of data.not_found ?? []) {
      if (nf?.name) notFound.push(nf.name);
    }
  }

  const isLand = (card: any) => (card?.type_line ?? "").includes("Land");
  const isBasicLand = (card: any) => (card?.type_line ?? "").includes("Basic Land");

  // Per-card detail lookup, keyed by the exact deck-entry/commander name as supplied (not
  // lowercased) -- report_data.js's buildActualOutput needs mana_cost/oracle_text/image_url
  // per card and reuses this instead of a second Scryfall round-trip.
  const cardDetails = new Map<string, CardDetail>();
  for (const name of allIdentifierNames) {
    const card = cardByName.get(name.toLowerCase());
    if (!card) continue;
    cardDetails.set(name, {
      mana_cost: card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? "",
      type_line: card.type_line ?? "",
      oracle_text: card.oracle_text ?? card.card_faces?.[0]?.oracle_text ?? "",
      // "small" (~146x204, a few KB) not "normal" -- this ends up base64-inlined into the
      // HTML report (see scryfall/images.js), so a smaller source image matters here.
      image_url: card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null,
      cmc: card.cmc ?? 0,
    });
  }

  const commanderColorSet = new Set<string>();
  for (const name of commander_names) {
    const card = cardByName.get(name.toLowerCase());
    for (const c of card?.color_identity ?? []) commanderColorSet.add(c);
  }

  const totalCards = commander_names.length + deck_entries.reduce((sum, e) => sum + e.qty, 0);
  const sizeWarning = totalCards !== 100
    ? `Deck has ${totalCards} total cards (commander(s) + library) — a standard Commander deck is exactly 100.`
    : null;

  const duplicateViolations: Array<{ name: string; qty: number }> = [];
  const colorIdentityViolations: ColorIdentityViolation[] = [];
  const notCommanderLegal: CommanderLegalityViolation[] = [];
  let landCount = 0;
  let nonlandCount = 0;
  let nonlandCmcTotal = 0;
  const manaCurve: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7+": 0 };

  for (const entry of deck_entries) {
    const card = cardByName.get(entry.name.toLowerCase());
    if (!card) continue;

    if (entry.qty > 1 && !isBasicLand(card)) {
      duplicateViolations.push({ name: entry.name, qty: entry.qty });
    }

    const cardColors: string[] = card.color_identity ?? [];
    const offendingColors = cardColors.filter((c) => !commanderColorSet.has(c));
    if (offendingColors.length) {
      colorIdentityViolations.push({ name: entry.name, card_color_identity: cardColors, offending_colors: offendingColors });
    }

    if (card.legalities?.commander !== "legal") {
      notCommanderLegal.push({ name: entry.name, status: card.legalities?.commander ?? "unknown" });
    }

    if (isLand(card)) {
      landCount += entry.qty;
    } else {
      nonlandCount += entry.qty;
      nonlandCmcTotal += (card.cmc ?? 0) * entry.qty;
      const bucket = card.cmc >= 7 ? "7+" : String(Math.max(0, Math.round(card.cmc ?? 0)));
      manaCurve[bucket] = (manaCurve[bucket] ?? 0) + entry.qty;
    }
  }

  for (const name of commander_names) {
    const card = cardByName.get(name.toLowerCase());
    if (card && card.legalities?.commander !== "legal") {
      notCommanderLegal.push({ name, status: card.legalities?.commander ?? "unknown" });
    }
  }

  const librarySize = totalCards - commander_names.length;
  const curveOutProbability: Record<string, number> = {};
  for (let turn = 1; turn <= 6; turn++) {
    const draws = Math.min(7 + turn, librarySize);
    curveOutProbability[`turn_${turn}`] = Math.round(hypergeometricAtLeast(librarySize, landCount, draws, turn) * 1000) / 1000;
  }

  const issues: string[] = [];
  if (sizeWarning) issues.push(sizeWarning);
  if (duplicateViolations.length) {
    issues.push(`Singleton violations: ${duplicateViolations.map((d) => `${d.name} x${d.qty}`).join(", ")}`);
  }
  if (colorIdentityViolations.length) {
    issues.push(`Outside commander's color identity: ${colorIdentityViolations.map((v) => v.name).join(", ")}`);
  }
  if (notCommanderLegal.length) {
    issues.push(`Not legal in Commander: ${notCommanderLegal.map((v) => `${v.name} (${v.status})`).join(", ")}`);
  }
  if (notFound.length) {
    issues.push(`Not found on Scryfall (check spelling): ${notFound.join(", ")}`);
  }

  return {
    issues,
    total_cards: totalCards,
    land_count: landCount,
    nonland_count: nonlandCount,
    avg_nonland_cmc: nonlandCount ? Math.round((nonlandCmcTotal / nonlandCount) * 100) / 100 : 0,
    mana_curve: manaCurve,
    curve_out_probability: {
      note: "Simplified model: 7-card opening hand + 1 draw/turn, no mulligans/scry/ramp/card-draw spells modeled.",
      ...curveOutProbability,
    },
    duplicate_violations: duplicateViolations,
    color_identity_violations: colorIdentityViolations,
    not_commander_legal: notCommanderLegal,
    not_found: notFound,
    commander_color_identity: Array.from(commanderColorSet),
    card_details: cardDetails,
  };
}

export { computeDeckConsistency, combinations, hypergeometricAtLeast };
export type { DeckEntry, CardDetail, DeckConsistencyResult };
