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

/** A pack card: everything needed to judge the pick, nothing else. */
function packCardView(grpId: string, card: CardRecord | null, set: string | null, format: string | null) {
  if (!card) return { grpId, card: null };
  const s = statsFor(card, set, format);
  return {
    grpId,
    name: card.name,
    mana_cost: card.mana_cost || undefined,
    type_line: card.type_line,
    oracle_text: card.oracle_text || undefined,
    pt: pt(card),
    rarity: s?.rarity ?? undefined,
    ...(s?.stats ?? {}),
  };
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

export { parseEventName, packCardView, poolCardLine, gameCardView };
