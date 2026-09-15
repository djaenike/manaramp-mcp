/**
 * sub-tools/deck-building/moxfield.ts
 * Moxfield has no official public API — hits the same undocumented endpoint
 * their own frontend calls. KNOWN ISSUE: anti-bot protection sometimes blocks
 * this outright (403) even with realistic headers — caller should fall back
 * to asking for pasted decklist text.
 */

import type { DeckEntry } from "./consistency.js";

const MOXFIELD_API_BASE = "https://api2.moxfield.com/v2/decks/all";
const MOXFIELD_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};

interface MoxfieldDecklist {
  deck_name: string;
  format: string;
  commander_names: string[];
  card_names: string[];
  deck_entries: DeckEntry[];
  decklist_text: string;
}

async function getMoxfieldDecklist(url: string): Promise<MoxfieldDecklist> {
  const match = url.match(/decks\/([^/?#]+)/);
  const deckId = match ? match[1] : url.trim();
  if (!deckId) {
    throw new Error("Couldn't find a deck id in that URL.");
  }

  let res: Response;
  try {
    res = await fetch(`${MOXFIELD_API_BASE}/${encodeURIComponent(deckId)}`, { headers: MOXFIELD_HEADERS });
  } catch (e: any) {
    throw new Error(`Couldn't reach Moxfield: ${e.message}. Paste the decklist text directly instead.`);
  }
  if (res.status === 404) {
    throw new Error(`No Moxfield deck found at that URL (deck id: ${deckId}) — it may be private, deleted, or the URL/id may be wrong.`);
  }
  if (res.status === 403) {
    throw new Error(
      "Moxfield blocked this request (anti-bot protection sometimes rejects non-browser requests, " +
      "even with realistic headers). Ask the user to paste the decklist text directly instead."
    );
  }
  if (!res.ok) {
    throw new Error(`Moxfield request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const commanderEntries: any[] = Object.values(data.commanders ?? {});
  const mainboardEntries: any[] = Object.values(data.mainboard ?? {});

  const commander_names = commanderEntries.map((e) => e.card?.name).filter(Boolean);
  const deckEntries: DeckEntry[] = mainboardEntries
    .map((e) => ({ qty: e.quantity ?? 1, name: e.card?.name }))
    .filter((e) => e.name);
  const card_names = [...commander_names, ...deckEntries.map((e) => e.name)];

  const textLines = ["Commander", ...commander_names.map((n) => `1 ${n}`), "", "Deck", ...deckEntries.map((e) => `${e.qty} ${e.name}`)];

  return {
    deck_name: data.name,
    format: data.format,
    commander_names,
    card_names,
    deck_entries: deckEntries,
    decklist_text: textLines.join("\n"),
  };
}

export { getMoxfieldDecklist, MOXFIELD_API_BASE, MOXFIELD_HEADERS };
export type { MoxfieldDecklist };
