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
function packCardView(grpId, card, set, format) {
  if (!card) return { grpId, card: null };
  const s = statsFor(card, set, format);
  return {
    grpId,
    name: card.name,
    mana_cost: card.mana_cost || void 0,
    type_line: card.type_line,
    oracle_text: card.oracle_text || void 0,
    pt: pt(card),
    rarity: s?.rarity ?? void 0,
    ...s?.stats ?? {}
  };
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
  poolCardLine
};
