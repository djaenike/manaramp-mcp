function parseEventName(eventName) {
  const m = eventName?.match(/^([A-Za-z]+)_([A-Za-z0-9]+)_/);
  return m ? { format: m[1], set: m[2].toUpperCase() } : { format: null, set: null };
}
const round = (n, places) => typeof n === "number" ? Math.round(n * 10 ** places) / 10 ** places : null;
function statsFor(card, set, format) {
  const rows = Array.isArray(card.format_stats) ? card.format_stats : [];
  const setOf = (r) => String(r.set_code ?? r.set ?? "").toUpperCase();
  const sameSet = set ? rows.filter((r) => setOf(r) === set) : rows;
  const row = sameSet.find((r) => r.format === format) ?? sameSet.find((r) => r.format === "PremierDraft") ?? sameSet[0];
  if (!row) return null;
  const stats = {
    gih_wr: round(row.games_in_hand_win_rate ?? row.gih_wr, 3),
    alsa: round(row.avg_last_seen_at ?? row.alsa, 2),
    ata: round(row.avg_taken_at ?? row.ata, 2),
    iih: round(row.improvement_in_hand ?? row.iih, 3),
    gih_n: row.games_in_hand_sample_size ?? row.gih_n ?? null
  };
  if (row.format !== format) stats.stats_format = row.format;
  return { stats, rarity: row.rarity ?? null };
}
function pt(card) {
  if (card.pt) return card.pt;
  if (card.power == null && card.toughness == null) return void 0;
  return `${card.power ?? "?"}/${card.toughness ?? "?"}`;
}
function packCardView(grpId, card, set, format, pickNumber) {
  if (!card) return { grpId, card: null };
  const s = statsFor(card, set, format);
  const alsa = s?.stats.alsa;
  return {
    grpId,
    name: card.name,
    mana_cost: card.mana_cost || void 0,
    type_line: card.type_line,
    oracle_text: card.oracle_text || void 0,
    pt: pt(card),
    rarity: s?.rarity ?? void 0,
    colors: cardColors(card).join("") || "C",
    ...s?.stats ?? {},
    seen_late: pickNumber != null && alsa != null && pickNumber > alsa + 1 ? true : void 0
  };
}
function sortPackForPicking(pack) {
  const gih = (c) => "gih_wr" in c && typeof c.gih_wr === "number" ? c.gih_wr : null;
  const alsa = (c) => "alsa" in c && typeof c.alsa === "number" ? c.alsa : null;
  const tier = (c) => "card" in c && c.card === null ? 2 : gih(c) != null ? 0 : 1;
  return [...pack].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (tier(a) === 0) return gih(b) - gih(a);
    return (alsa(a) ?? 99) - (alsa(b) ?? 99);
  });
}
function cardColors(card) {
  const colors = card.colors;
  if (Array.isArray(colors)) return colors.filter((c) => typeof c === "string");
  const found = /* @__PURE__ */ new Set();
  for (const m of String(card.mana_cost ?? "").matchAll(/[WUBRG]/g)) found.add(m[0]);
  return [...found];
}
function effectNamesOf(card) {
  const out = /* @__PURE__ */ new Set();
  if (Array.isArray(card.effect_names)) {
    for (const n of card.effect_names) out.add(String(n).split(":").pop());
    return out;
  }
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node;
    if (typeof obj.effect === "string") out.add(obj.effect);
    for (const [k, v] of Object.entries(obj)) if (k !== "params" && k !== "conditions" && k !== "formulas" && k !== "tokens") walk(v);
  };
  walk(card.effects);
  return out;
}
const ROLE_EFFECTS = {
  removal: ["Destroy", "DestroyAll", "Exile", "ExileAll", "DealDamage", "DamageAll", "Fight", "Sacrifice", "SacrificeAll", "Counter"],
  card_advantage: ["Draw", "Dig", "ChangeZone"],
  tokens: ["Token", "CopyPermanent"]
};
function poolSummary(cards, set, format) {
  const colors = {};
  const gihSums = {};
  const curve = {};
  const roles = { removal: 0, card_advantage: 0, tokens: 0 };
  let creatures = 0;
  let noncreatures = 0;
  for (const card of cards) {
    if (!card) continue;
    const gih = statsFor(card, set, format)?.stats.gih_wr ?? null;
    for (const c of cardColors(card)) {
      colors[c] ??= { cards: 0, avg_gih_wr: null };
      colors[c].cards++;
      if (gih != null) {
        gihSums[c] ??= { sum: 0, n: 0 };
        gihSums[c].sum += gih;
        gihSums[c].n++;
      }
    }
    const type = String(card.type_line ?? "");
    if (!/\bLand\b/.test(type)) {
      const cmc = typeof card.cmc === "number" ? Math.min(card.cmc, 6) : null;
      if (cmc != null) curve[cmc === 6 ? "6+" : String(cmc)] = (curve[cmc === 6 ? "6+" : String(cmc)] ?? 0) + 1;
      if (/\bCreature\b/.test(type)) creatures++;
      else noncreatures++;
    }
    const names = effectNamesOf(card);
    for (const [role, effects] of Object.entries(ROLE_EFFECTS)) if (effects.some((e) => names.has(e))) roles[role]++;
  }
  for (const [c, { sum, n }] of Object.entries(gihSums)) colors[c].avg_gih_wr = Math.round(sum / n * 1e3) / 1e3;
  const ranked = Object.entries(colors).sort((a, b) => b[1].cards - a[1].cards).map(([c]) => c);
  return { colors, leading_colors: ranked.slice(0, 2).join(""), curve, creatures, noncreatures, roles };
}
function poolCardLine(grpId, card, set, format) {
  if (!card) return `grpId ${grpId} (unresolved)`;
  const gih = statsFor(card, set, format)?.stats.gih_wr;
  return [card.name, card.mana_cost, `-- ${card.type_line}`, gih != null ? `(gih ${gih})` : null].filter(Boolean).join(" ");
}
function gameCardView(card) {
  if (!card) return null;
  return {
    name: card.name,
    mana_cost: card.mana_cost || void 0,
    type_line: card.type_line,
    oracle_text: card.oracle_text || void 0,
    pt: pt(card)
  };
}
export {
  gameCardView,
  packCardView,
  parseEventName,
  poolCardLine,
  poolSummary,
  sortPackForPicking
};
