function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return result;
}
function hypergeometricAtLeast(librarySize, successes, draws, need) {
  const upper = Math.min(draws, successes);
  if (need > upper) return 0;
  const total = combinations(librarySize, draws);
  if (total === 0) return 0;
  let sum = 0;
  for (let i = need; i <= upper; i++) {
    sum += combinations(successes, i) * combinations(librarySize - successes, draws - i) / total;
  }
  return sum;
}
function validateDeck(cards, commander_names, deck_entries) {
  const uniqueDeckNames = Array.from(new Set(deck_entries.map((e) => e.name)));
  const allIdentifierNames = Array.from(/* @__PURE__ */ new Set([...commander_names, ...uniqueDeckNames]));
  const cardByName = new Map(cards.map((c) => [c.name.toLowerCase(), c]));
  const notFound = allIdentifierNames.filter((n) => !cardByName.has(n.toLowerCase()));
  const isLand = (card) => (card?.type_line ?? "").includes("Land");
  const isBasicLand = (card) => (card?.type_line ?? "").includes("Basic Land");
  const cardDetails = /* @__PURE__ */ new Map();
  for (const name of allIdentifierNames) {
    const card = cardByName.get(name.toLowerCase());
    if (!card) continue;
    cardDetails.set(name, {
      oracle_id: card.oracle_id,
      mana_cost: card.mana_cost ?? "",
      type_line: card.type_line ?? "",
      oracle_text: card.oracle_text ?? "",
      image_url: card.image_url ?? null,
      cmc: card.cmc ?? 0
    });
  }
  const commanderColorSet = /* @__PURE__ */ new Set();
  for (const name of commander_names) {
    const card = cardByName.get(name.toLowerCase());
    for (const c of card?.color_identity ?? []) commanderColorSet.add(c);
  }
  const totalCards = commander_names.length + deck_entries.reduce((sum, e) => sum + e.qty, 0);
  const sizeWarning = totalCards !== 100 ? `Deck has ${totalCards} total cards (commander(s) + library) -- a standard Commander deck is exactly 100.` : null;
  const duplicateViolations = [];
  const colorIdentityViolations = [];
  const notCommanderLegal = [];
  let landCount = 0;
  let nonlandCount = 0;
  let nonlandCmcTotal = 0;
  const manaCurve = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7+": 0 };
  for (const entry of deck_entries) {
    const card = cardByName.get(entry.name.toLowerCase());
    if (!card) continue;
    if (entry.qty > 1 && !isBasicLand(card)) {
      duplicateViolations.push({ name: entry.name, qty: entry.qty });
    }
    const cardColors = card.color_identity ?? [];
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
  const curveOutProbability = {};
  for (let turn = 1; turn <= 6; turn++) {
    const draws = Math.min(7 + turn, librarySize);
    curveOutProbability[`turn_${turn}`] = Math.round(hypergeometricAtLeast(librarySize, landCount, draws, turn) * 1e3) / 1e3;
  }
  const issues = [];
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
    issues.push(`Not found in manaramp's card database (check spelling): ${notFound.join(", ")}`);
  }
  return {
    issues,
    total_cards: totalCards,
    land_count: landCount,
    nonland_count: nonlandCount,
    avg_nonland_cmc: nonlandCount ? Math.round(nonlandCmcTotal / nonlandCount * 100) / 100 : 0,
    mana_curve: manaCurve,
    curve_out_probability: {
      note: "Simplified model: 7-card opening hand + 1 draw/turn, no mulligans/scry/ramp/card-draw spells modeled.",
      ...curveOutProbability
    },
    duplicate_violations: duplicateViolations,
    color_identity_violations: colorIdentityViolations,
    not_commander_legal: notCommanderLegal,
    not_found: notFound,
    commander_color_identity: Array.from(commanderColorSet),
    card_details: cardDetails
  };
}
export {
  combinations,
  hypergeometricAtLeast,
  validateDeck
};
