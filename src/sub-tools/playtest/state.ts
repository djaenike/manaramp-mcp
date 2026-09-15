/**
 * sub-tools/playtest/state.ts
 * State condensation + decklist text parsing shared across the playtest tools.
 */

import type { DeckEntry } from "../deck-building/consistency.js";

interface ParsedDecklist {
  commanderNames: string[];
  deckEntries: DeckEntry[];
}

function summarizeState(state: any) {
  const cardInfo = state.cardInfo || {};
  const describeHand = (c: any) => {
    const info = cardInfo[c.name.toLowerCase()];
    return info?.manaCost ? `${c.name} ${info.manaCost}` : c.name;
  };
  const describeBattlefield = (c: any) => {
    const bits = [c.name];
    if (c.tapped) bits.push("(tapped)");
    if (c.counters && Object.keys(c.counters).length) {
      bits.push(`[${Object.entries(c.counters).map(([t, n]) => `${n} ${t}`).join(", ")}]`);
    }
    return bits.join(" ");
  };
  const players: Record<string, any> = {};
  for (const [seatId, p] of Object.entries<any>(state.players || {})) {
    players[seatId] = {
      label: p.label,
      life: p.life,
      command: p.command.map((c: any) => c.name),
      hand: p.hand.map(describeHand),
      battlefield: p.battlefield.map(describeBattlefield),
      library_count: p.library.length,
      graveyard_count: p.graveyard.length,
      exile_count: p.exile.length,
      mulligans: p.mulligans,
    };
  }
  return {
    turn: state.turn,
    active: state.active,
    revision: state.revision,
    seats: state.seats,
    players,
    recent_log: state.log.slice(-8),
  };
}

function parsePlaytestDecklist(text: string): ParsedDecklist {
  const lines = text.split(/\r?\n/);
  let section = "deck";
  const commanderNames: string[] = [];
  const deckEntries: DeckEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)x?\s+(.+)$/i);
    if (!m) {
      const lower = line.toLowerCase();
      if (lower.startsWith("commander")) section = "commander";
      else if (lower.startsWith("sideboard")) section = "sideboard";
      else if (lower.startsWith("deck") || lower.startsWith("mainboard")) section = "deck";
      continue;
    }
    const qty = parseInt(m[1], 10);
    const name = m[2].trim();
    if (section === "commander") commanderNames.push(name);
    else if (section === "deck") deckEntries.push({ qty, name });
  }
  return { commanderNames, deckEntries };
}

export { summarizeState, parsePlaytestDecklist };
export type { ParsedDecklist };
