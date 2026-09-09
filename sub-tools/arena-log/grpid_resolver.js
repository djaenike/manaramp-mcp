/**
 * grpid_resolver.js
 *
 * Resolves Arena's numeric grpIds to real card data via the existing MCP's
 * Scryfall-backed `search_cards` tool.
 *
 * Confirmed live tonight: Scryfall's search syntax accepts `arena_id:<id>` as
 * a filter even though it is not Scryfall's officially documented dedicated
 * endpoint (`/cards/arena/:id`). One query per id via search_cards works today;
 * if resolving many ids at once becomes a bottleneck, Scryfall's `/cards/collection`
 * POST endpoint (batch lookup) is the natural next optimization -- not needed yet.
 *
 * This module is intentionally decoupled from HOW search_cards is invoked
 * (direct MCP tool call vs. an injected function), so it can be unit-tested
 * with a fake resolver.
 */

/**
 * @param {number[]} grpIds - distinct grpIds to resolve
 * @param {(query: string) => Promise<object[]>} searchCardsFn -
 *        should call the MCP's existing search_cards tool and return its
 *        parsed array response, e.g. via
 *        (query) => callTool('search_cards', { query })
 * @returns {Promise<Map<number, object|null>>} grpId -> card data (or null if not found)
 */
async function resolveGrpIds(grpIds, searchCardsFn) {
  const uniqueIds = [...new Set(grpIds)];
  const results = new Map();

  // Sequential with small concurrency cap rather than Promise.all(all-at-once):
  // avoids hammering Scryfall if a match/draft surfaces dozens of distinct ids.
  const CONCURRENCY = 5;
  let index = 0;

  async function worker() {
    while (index < uniqueIds.length) {
      const grpId = uniqueIds[index++];
      try {
        const matches = await searchCardsFn(`arena_id:${grpId}`);
        results.set(grpId, matches && matches.length ? matches[0] : null);
      } catch (err) {
        results.set(grpId, null);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, uniqueIds.length) }, worker)
  );

  return results;
}

/**
 * Convenience: take a buildMatchTimeline() timeline + instanceToGrpId map,
 * resolve every distinct grpId referenced in it, and return the timeline
 * with card names/data attached instead of bare grpIds.
 */
async function enrichTimeline(timeline, searchCardsFn) {
  const grpIds = [];
  const collect = (obj) => {
    if (obj && typeof obj === 'object') {
      if (obj.grpId != null) grpIds.push(obj.grpId);
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(collect);
        else if (typeof v === 'object') collect(v);
      }
    }
  };
  timeline.forEach(collect);

  const resolved = await resolveGrpIds(grpIds, searchCardsFn);

  const attachCard = (obj) => {
    if (obj && typeof obj === 'object') {
      if (obj.grpId != null) {
        obj.card = resolved.get(obj.grpId) || null;
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(attachCard);
        else if (typeof v === 'object') attachCard(v);
      }
    }
  };
  timeline.forEach(attachCard);

  return timeline;
}

export { resolveGrpIds, enrichTimeline };
