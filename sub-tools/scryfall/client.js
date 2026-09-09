/**
 * sub-tools/scryfall/client.js
 *
 * Verbatim port of index.js's Scryfall client + rate-limit pacing.
 * Every Scryfall fetch anywhere in this MCP MUST go through scryfallFetch —
 * a raw fetch(SCRYFALL_BASE...) bypasses the pacing entirely and risks a
 * real 429/ban, which is exactly what prompted this in the first place.
 */

const SCRYFALL_BASE = "https://api.scryfall.com";

// Scryfall's documented hard rate limits: /cards/search, /cards/named, /cards/random, and
// /cards/collection are each 2/second (500ms apart); everything else is 10/second (100ms apart).
// A small safety margin is added on top of both (520ms/110ms) rather than the bare minimum.
const SCRYFALL_MIN_INTERVAL_MS = { search: 520, named: 520, random: 520, collection: 520, default: 110 };
const scryfallLastRequestAt = { search: 0, named: 0, random: 0, collection: 0, default: 0 };

// Scryfall requires an accurate User-Agent and an Accept header on every request
const HEADERS = {
  "User-Agent": "scryfall-mcp/1.0 (personal project)",
  "Accept": "application/json",
};

// Proactively paces every Scryfall call by endpoint category — not just reactive retry-after-429.
// This module-level state persists for this MCP process's entire session lifetime, so it actually
// coordinates separate tool calls fired back-to-back, not just chunks within one call.
async function scryfallFetch(url, options, category = "default") {
  const minInterval = SCRYFALL_MIN_INTERVAL_MS[category] ?? SCRYFALL_MIN_INTERVAL_MS.default;
  const waitMs = scryfallLastRequestAt[category] + minInterval - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  scryfallLastRequestAt[category] = Date.now();

  const res = await fetch(url, options);
  if (res.status === 429) {
    // Scryfall's own documented behavior: a 429 means a fixed ~30s penalty window, not a transient
    // blip — one wait-then-retry (honoring Retry-After if present) matches that directly, rather
    // than a generic exponential-backoff loop meant for transient network errors.
    const retryMs = Math.min((Number(res.headers.get("Retry-After")) || 30) * 1000, 30000);
    await new Promise((r) => setTimeout(r, retryMs));
    scryfallLastRequestAt[category] = Date.now();
    return fetch(url, options);
  }
  return res;
}

export { SCRYFALL_BASE, HEADERS, scryfallFetch };
