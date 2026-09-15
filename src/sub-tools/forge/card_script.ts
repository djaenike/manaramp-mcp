/**
 * sub-tools/forge/card_script.ts
 * Forge is an open-source MTG rules engine (GPL-3.0, github.com/Card-Forge/forge).
 * Read live from GitHub's raw file host rather than vendoring the folder, so this
 * stays current with Forge's repo and avoids bundling GPL-licensed files.
 */

import { HEADERS } from "../scryfall/client.js";

const FORGE_RAW_BASE = "https://raw.githubusercontent.com/Card-Forge/forge/master/forge-gui/res/cardsfolder";

// Converts a card name into Forge's cardsfolder filename convention:
// lowercase, spaces -> underscores, apostrophes/commas stripped.
function forgeFilename(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’,]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface CardScript {
  name: string;
  script: string;
  source: string;
}

async function getCardScript(name: string): Promise<CardScript> {
  const filename = forgeFilename(name);
  const firstLetter = filename.charAt(0);
  const url = `${FORGE_RAW_BASE}/${firstLetter}/${filename}.txt`;

  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 404) {
    throw new Error(
      `No Forge script found at expected path for '${name}' (tried ${filename}.txt). ` +
      `Forge's filename convention is lowercase with underscores for spaces; unusual ` +
      `punctuation or split/double-faced cards may not match this pattern. Fall back to ` +
      `Scryfall's oracle text (scryfall/cards.js getCardByName) for this card.`
    );
  }
  if (!res.ok) {
    throw new Error(`Forge script request failed: ${res.status} ${res.statusText}`);
  }

  const script = await res.text();
  return { name, script, source: "Card-Forge/forge (GPL-3.0, unofficial/community-maintained)" };
}

export { getCardScript, forgeFilename, FORGE_RAW_BASE };
export type { CardScript };
