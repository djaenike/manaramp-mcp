/**
 * functions/reference/deck-validation.ts (renamed from sub-tools/deck-building/consistency.ts,
 * 2026-09-17, sixth pass) -- PURE: takes already-fetched card data instead of querying Mongo
 * itself. It used to run its OWN `cards.find()` batch query, a THIRD independent implementation of
 * the same query functions/query/cards.ts's queryCards already does -- tools/shared/deck-analysis.ts (optimize_deck/publish_deck) calls
 * queryCards ONCE and passes the result in here, so there's exactly one place `cards` actually
 * gets queried.
 *
 * Validates deck size, singleton, color identity, Commander legality, and computes mana curve +
 * curve-out probability. Does NOT detect combos -- that's functions/reference/bracket-facts.ts's
 * job.
 */

import type { CardSummary } from "../query/cards.js";

interface DeckEntry {
  qty: number;
  name: string;
}

interface CardDetail {
  oracle_id: string;
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

interface DeckValidationResult {
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

// nCr via iterative running product/division -- stays numerically small throughout.
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// P(at least `need` successes drawn in `draws` cards from a `librarySize`-card population
// containing `successes` total). Standard hypergeometric survival function.
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

/** `cards` is every card queryCards found for this decklist's names (commander_names +
 *  deck_entries' unique names) -- fetch it ONCE via queryCards before calling this. */
function validateDeck(cards: CardSummary[], commander_names: string[], deck_entries: DeckEntry[]): DeckValidationResult {
  const uniqueDeckNames = Array.from(new Set(deck_entries.map((e) => e.name)));
  const allIdentifierNames = Array.from(new Set([...commander_names, ...uniqueDeckNames]));

  const cardByName = new Map(cards.map((c) => [c.name.toLowerCase(), c]));
  const notFound = allIdentifierNames.filter((n) => !cardByName.has(n.toLowerCase()));

  const isLand = (card: CardSummary | undefined) => (card?.type_line ?? "").includes("Land");
  const isBasicLand = (card: CardSummary | undefined) => (card?.type_line ?? "").includes("Basic Land");

  // Per-card detail lookup, keyed by the exact deck-entry/commander name as supplied (not
  // lowercased) -- tools/shared/deck-analysis.ts (optimize_deck/publish_deck) needs oracle_id (persistence) and mana_cost/oracle_text/
  // image_url per card, and reuses this instead of a second lookup.
  const cardDetails = new Map<string, CardDetail>();
  for (const name of allIdentifierNames) {
    const card = cardByName.get(name.toLowerCase());
    if (!card) continue;
    cardDetails.set(name, {
      oracle_id: card.oracle_id,
      mana_cost: card.mana_cost ?? "",
      type_line: card.type_line ?? "",
      oracle_text: card.oracle_text ?? "",
      image_url: card.image_url ?? null,
      cmc: card.cmc ?? 0,
    });
  }

  // CORRECTION 2026-09-18: when NO commander name resolved to a real card, commanderColorSet stays
  // empty -- which used to fall straight into the per-card check below, filtering EVERY card's
  // color_identity against an empty allowed set and false-flagging every colored card as "outside
  // commander's color identity" (confirmed live: Weftstalker Ardent, Squee Goblin Nabob,
  // Reassembling Skeleton all cascaded into that violation just because the commander itself was
  // `not_found`). commanderResolved tracks whether this is a real "colorless commander" (an actual
  // resolved card with an empty color_identity, e.g. a truly colorless commander) vs. "couldn't even
  // check" -- only the first is a legitimate empty set.
  const commanderColorSet = new Set<string>();
  let commanderResolved = false;
  for (const name of commander_names) {
    const card = cardByName.get(name.toLowerCase());
    if (card) commanderResolved = true;
    for (const c of card?.color_identity ?? []) commanderColorSet.add(c);
  }

  const totalCards = commander_names.length + deck_entries.reduce((sum, e) => sum + e.qty, 0);
  const sizeWarning = totalCards !== 100
    ? `Deck has ${totalCards} total cards (commander(s) + library) -- a standard Commander deck is exactly 100.`
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

    if (commanderResolved) {
      const cardColors: string[] = card.color_identity ?? [];
      const offendingColors = cardColors.filter((c) => !commanderColorSet.has(c));
      if (offendingColors.length) {
        colorIdentityViolations.push({ name: entry.name, card_color_identity: cardColors, offending_colors: offendingColors });
      }
    }

    if (card.legalities?.commander !== "legal") {
      notCommanderLegal.push({ name: entry.name, status: card.legalities?.commander ?? "unknown" });
    }

    if (isLand(card)) {
      landCount += entry.qty;
    } else {
      nonlandCount += entry.qty;
      nonlandCmcTotal += (card.cmc ?? 0) * entry.qty;
      const bucket = (card.cmc ?? 0) >= 7 ? "7+" : String(Math.max(0, Math.round(card.cmc ?? 0)));
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
  if (!commanderResolved && commander_names.length) {
    issues.push(`Commander(s) not found in manaramp's card database (${commander_names.join(", ")}) -- cannot verify color identity for any card until this is fixed.`);
  }
  if (notCommanderLegal.length) {
    issues.push(`Not legal in Commander: ${notCommanderLegal.map((v) => `${v.name} (${v.status})`).join(", ")}`);
  }
  if (notFound.length) {
    issues.push(`Not found in manaramp's card database (check spelling): ${notFound.join(", ")}`);
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

export { validateDeck, combinations, hypergeometricAtLeast };
export type { DeckEntry, CardDetail, DeckValidationResult };
