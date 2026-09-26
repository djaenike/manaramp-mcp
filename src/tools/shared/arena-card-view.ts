/**
 * tools/shared/arena-card-view.ts
 *
 * Token-lean card shapes for the two Arena tools' responses (2026-09-25). Their grpId cache holds
 * the full query_cards record (effects tree, legalities, every 17Lands row), which is right for
 * the cache but measured at ~1,500 tokens per card when sent to the model as-is. A 13-card pack
 * cost ~21k tokens, and arena_draft_assistance also re-sent every card picked so far, so by pack 3
 * one pick call was ~80k tokens, piling up with each pick until the draft ran out of credits.
 *
 * Everything here reads BOTH record shapes: the full CardSummary field names (games_in_hand_win_rate
 * etc., what the cache holds) and query_cards' compact summary names (gih_wr etc.), so a cache file
 * written by either version works.
 */

type CardRecord = Record<string, any>;

interface DraftStats {
  gih_wr: number | null;
  alsa: number | null;
  ata: number | null;
  iih: number | null;
  gih_n: number | null;
  /** Only set when these stats come from a different format than the current event's. */
  stats_format?: string;
}

/** "QuickDraft_HOB_20260915" -> { format: "QuickDraft", set: "HOB" }. */
function parseEventName(eventName: string | null): { format: string | null; set: string | null } {
  const m = eventName?.match(/^([A-Za-z]+)_([A-Za-z0-9]+)_/);
  return m ? { format: m[1], set: m[2].toUpperCase() } : { format: null, set: null };
}

const round = (n: unknown, places: number): number | null =>
  typeof n === "number" ? Math.round(n * 10 ** places) / 10 ** places : null;

/** The one 17Lands row matching this event's set+format; else the same set in another format
 *  (labelled via stats_format); else null. */
function statsFor(card: CardRecord, set: string | null, format: string | null): { stats: DraftStats; rarity: string | null } | null {
  const rows: CardRecord[] = Array.isArray(card.format_stats) ? card.format_stats : [];
  const setOf = (r: CardRecord) => String(r.set_code ?? r.set ?? "").toUpperCase();
  const sameSet = set ? rows.filter((r) => setOf(r) === set) : rows;
  const row = sameSet.find((r) => r.format === format) ?? sameSet.find((r) => r.format === "PremierDraft") ?? sameSet[0];
  if (!row) return null;
  const stats: DraftStats = {
    gih_wr: round(row.games_in_hand_win_rate ?? row.gih_wr, 3),
    alsa: round(row.avg_last_seen_at ?? row.alsa, 2),
    ata: round(row.avg_taken_at ?? row.ata, 2),
    iih: round(row.improvement_in_hand ?? row.iih, 3),
    gih_n: row.games_in_hand_sample_size ?? row.gih_n ?? null,
  };
  if (row.format !== format) stats.stats_format = row.format;
  return { stats, rarity: row.rarity ?? null };
}

function pt(card: CardRecord): string | undefined {
  if (card.pt) return card.pt;
  if (card.power == null && card.toughness == null) return undefined;
  return `${card.power ?? "?"}/${card.toughness ?? "?"}`;
}

/** A pack card: everything needed to judge the pick, nothing else. `seen_late` (2026-09-26) flags a
 *  card still in the pack more than a pick past its ALSA -- the "this color may be open" signal the
 *  tool description tells the model to weigh for pivots, precomputed so it isn't left to mental
 *  arithmetic across 14 cards. */
function packCardView(grpId: string, card: CardRecord | null, set: string | null, format: string | null, pickNumber?: number) {
  if (!card) return { grpId, card: null };
  const s = statsFor(card, set, format);
  const alsa = s?.stats.alsa;
  return {
    grpId,
    name: card.name,
    mana_cost: card.mana_cost || undefined,
    type_line: card.type_line,
    oracle_text: card.oracle_text || undefined,
    pt: pt(card),
    rarity: s?.rarity ?? undefined,
    colors: cardColors(card).join("") || "C",
    ...(s?.stats ?? {}),
    seen_late: pickNumber != null && alsa != null && pickNumber > alsa + 1 ? true : undefined,
  };
}

type PackCardView = ReturnType<typeof packCardView>;

/** Pack order for the response (2026-09-26): games-in-hand win rate first, highest to lowest --
 *  the primary pick-quality number. Cards with no GIH WR (17Lands withholds it below its sample
 *  threshold, common early in a set) follow, ordered by ALSA ascending (lower = usually taken
 *  earlier = stronger), then unresolved cards last. */
function sortPackForPicking(pack: PackCardView[]): PackCardView[] {
  const gih = (c: PackCardView) => ("gih_wr" in c && typeof c.gih_wr === "number" ? c.gih_wr : null);
  const alsa = (c: PackCardView) => ("alsa" in c && typeof c.alsa === "number" ? c.alsa : null);
  const tier = (c: PackCardView) => ("card" in c && c.card === null ? 2 : gih(c) != null ? 0 : 1);
  return [...pack].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (tier(a) === 0) return gih(b)! - gih(a)!;
    return (alsa(a) ?? 99) - (alsa(b) ?? 99);
  });
}

/** WUBRG colors of a card -- the record's own `colors` array, or parsed off the mana cost for a
 *  record shape that doesn't carry it. */
function cardColors(card: CardRecord): string[] {
  const colors: unknown = card.colors;
  if (Array.isArray(colors)) return colors.filter((c): c is string => typeof c === "string");
  const found = new Set<string>();
  for (const m of String(card.mana_cost ?? "").matchAll(/[WUBRG]/g)) found.add(m[0]);
  return [...found];
}

/** Every Forge effect name on a full record (effects tree) or a compact one (effect_names). */
function effectNamesOf(card: CardRecord): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(card.effect_names)) {
    for (const n of card.effect_names) out.add(String(n).split(":").pop()!);
    return out;
  }
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.effect === "string") out.add(obj.effect);
    for (const [k, v] of Object.entries(obj)) if (k !== "params" && k !== "conditions" && k !== "formulas" && k !== "tokens") walk(v);
  };
  walk(card.effects);
  return out;
}

const ROLE_EFFECTS: Record<string, string[]> = {
  removal: ["Destroy", "DestroyAll", "Exile", "ExileAll", "DealDamage", "DamageAll", "Fight", "Sacrifice", "SacrificeAll", "Counter"],
  card_advantage: ["Draw", "Dig", "ChangeZone"],
  tokens: ["Token", "CopyPermanent"],
};

/** The pool at a glance (2026-09-26) -- what the model weighs each pick against: color commitment,
 *  curve, creature count, and role coverage. Colors count cards (a gold card counts toward each of
 *  its colors), and each color also carries the average GIH WR of the pool's cards in it, so a
 *  pivot recommendation can compare "how deep and how good" rather than raw card counts alone. */
function poolSummary(cards: Array<CardRecord | null>, set: string | null, format: string | null) {
  const colors: Record<string, { cards: number; avg_gih_wr: number | null }> = {};
  const gihSums: Record<string, { sum: number; n: number }> = {};
  const curve: Record<string, number> = {};
  const roles: Record<string, number> = { removal: 0, card_advantage: 0, tokens: 0 };
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
  for (const [c, { sum, n }] of Object.entries(gihSums)) colors[c].avg_gih_wr = Math.round((sum / n) * 1000) / 1000;
  const ranked = Object.entries(colors).sort((a, b) => b[1].cards - a[1].cards).map(([c]) => c);
  return { colors, leading_colors: ranked.slice(0, 2).join(""), curve, creatures, noncreatures, roles };
}

/** A card already in the pool: one short line -- its full text was already shown when it was in a
 *  pack, so re-sending it every pick is the growing cost this replaces. */
function poolCardLine(grpId: string, card: CardRecord | null, set: string | null, format: string | null): string {
  if (!card) return `grpId ${grpId} (unresolved)`;
  const gih = statsFor(card, set, format)?.stats.gih_wr;
  return [card.name, card.mana_cost, `-- ${card.type_line}`, gih != null ? `(gih ${gih})` : null].filter(Boolean).join(" ");
}

/** Game-advice view: name/cost/type/text/PT only (no draft stats). */
function gameCardView(card: CardRecord | null) {
  if (!card) return null;
  return {
    name: card.name,
    mana_cost: card.mana_cost || undefined,
    type_line: card.type_line,
    oracle_text: card.oracle_text || undefined,
    pt: pt(card),
  };
}

export { parseEventName, packCardView, sortPackForPicking, poolSummary, poolCardLine, gameCardView };
