/**
 * functions/reference/price-sources.ts
 *
 * Which store a price comes from, and the fallback order (2026-10-06). A local copy of manaramp's
 * own src/lib/price-sources.ts (same repo-boundary rule as everything else here -- neither repo
 * imports the other). Keep the two in step.
 *
 *   tcgplayer   -- the default. TCGplayer market price (Scryfall's daily bulk prices.usd).
 *   manapool    -- the other store the website shows.
 *   cardkingdom -- still in market_data, but never used as a fallback: Card Kingdom isn't an
 *                  affiliate, so no price shown to a user should quietly come from it.
 */
import type { PriceSource } from "../../tools/types.js";

const DISPLAY_PRICE_SOURCES: PriceSource[] = ["tcgplayer", "manapool"];
const DEFAULT_PRICE_SOURCE: PriceSource = "tcgplayer";

/** Stores to try in order for `preferred`: it first, then the other displayed store. */
function priceFallbackOrder(preferred: PriceSource): PriceSource[] {
  if (preferred === "cardkingdom") return ["cardkingdom", ...DISPLAY_PRICE_SOURCES];
  return [preferred, ...DISPLAY_PRICE_SOURCES.filter((s) => s !== preferred)];
}

export { DISPLAY_PRICE_SOURCES, DEFAULT_PRICE_SOURCE, priceFallbackOrder };
