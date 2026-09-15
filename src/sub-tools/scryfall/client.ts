/**
 * sub-tools/scryfall/client.ts
 *
 * Verbatim port of index.js's Scryfall client + rate-limit pacing.
 * Every Scryfall fetch anywhere in this MCP MUST go through scryfallFetch —
 * a raw fetch(SCRYFALL_BASE...) bypasses the pacing entirely and risks a
 * real 429/ban, which is exactly what prompted this in the first place.
 */

const SCRYFALL_BASE = "https://api.scryfall.com";

type ScryfallCategory = "search" | "named" | "random" | "collection" | "default";

// Scryfall's documented hard rate limits: /cards/search, /cards/named, /cards/random, and
// /cards/collection are each 2/second (500ms apart); everything else is 10/second (100ms apart).
// A small safety margin is added on top of both (520ms/110ms) rather than the bare minimum.
const SCRYFALL_MIN_INTERVAL_MS: Record<ScryfallCategory, number> = {
  search: 520, named: 520, random: 520, collection: 520, default: 110,
};
const scryfallLastRequestAt: Record<ScryfallCategory, number> = {
  search: 0, named: 0, random: 0, collection: 0, default: 0,
};

// Real-world bug found via a live draft session: grpid_resolver.js fires several concurrent
// searches (concurrency 5), and a plain "read last-request-time, sleep, then write" pacing check
// is NOT safe under concurrency -- multiple concurrent callers can all read the same stale
// timestamp before any of them writes it back, so they all compute the same wait and then all
// fire at once, defeating the pacing entirely and tripping Scryfall's real rate limit. A
// per-category promise chain serializes just the "wait your turn, then stamp" gate itself (not
// the actual fetch), so concurrent callers queue through it one at a time instead of racing.
const scryfallPacingQueue: Record<ScryfallCategory, Promise<void>> = {
  search: Promise.resolve(), named: Promise.resolve(), random: Promise.resolve(),
  collection: Promise.resolve(), default: Promise.resolve(),
};

// Scryfall requires an accurate User-Agent and an Accept header on every request
const HEADERS: Record<string, string> = {
  "User-Agent": "scryfall-mcp/1.0 (personal project)",
  "Accept": "application/json",
};

// Proactively paces every Scryfall call by endpoint category — not just reactive retry-after-429.
// This module-level state persists for this MCP process's entire session lifetime, so it actually
// coordinates separate tool calls fired back-to-back, not just chunks within one call.
async function scryfallFetch(url: string, options: RequestInit, category: ScryfallCategory = "default"): Promise<Response> {
  const minInterval = SCRYFALL_MIN_INTERVAL_MS[category] ?? SCRYFALL_MIN_INTERVAL_MS.default;

  const mySlot = scryfallPacingQueue[category].then(async () => {
    const waitMs = scryfallLastRequestAt[category] + minInterval - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    scryfallLastRequestAt[category] = Date.now();
  });
  // Keep the queue alive even if something upstream throws -- a rejected link would otherwise
  // permanently wedge every later caller waiting on this category.
  scryfallPacingQueue[category] = mySlot.catch(() => {});
  await mySlot;

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
export type { ScryfallCategory };
