// Regression test for a real bug found via a live draft session: scryfallFetch's rate-limit
// pacing used a plain "read last-request-time, sleep, then write" check, which is NOT safe under
// concurrency -- grpid_resolver.js fires up to 5 concurrent lookups, and concurrent callers could
// all read the same stale timestamp before any of them wrote it back, letting them all fire near-
// simultaneously and defeating the pacing (this is what actually tripped Scryfall's real rate
// limit during the draft, not missing card data -- see grpid_resolver.js's header comment).
// Fixed via a per-category promise-chained queue in scryfall/client.js. This test fires 5
// concurrent requests through the "search" category (520ms min interval) and asserts they
// complete in a properly spaced sequence, not a burst.

global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });

const { scryfallFetch } = await import("../src/sub-tools/scryfall/client.js");

const start = Date.now();
const completionOffsets = [];
await Promise.all(
  Array.from({ length: 5 }, () =>
    scryfallFetch("https://api.scryfall.com/cards/search?q=test", {}, "search")
      .then(() => completionOffsets.push(Date.now() - start))
  )
);
completionOffsets.sort((a, b) => a - b);

const gaps = completionOffsets.slice(1).map((t, i) => t - completionOffsets[i]);
console.log("completion offsets (ms):", completionOffsets);
console.log("gaps between consecutive completions (ms):", gaps);

// The first request has nothing to wait for (gap 0 is correct there); every request AFTER the
// first must be spaced by roughly the category's min interval (520ms for "search"), not bursted.
const pass = completionOffsets.length === 5 && gaps.every((g) => g >= 500);

console.log(pass
  ? "\nPASS: concurrent requests to the same category are serialized through the pacing gate, not bursted."
  : "\nFAIL.");
