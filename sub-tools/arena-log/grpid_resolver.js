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
 *
 * Real-draft bug fix: a live Quick Draft session showed calls getting steadily slower (~1min by
 * Pack 3) plus a handful of grpIds intermittently failing to resolve. Root-caused with real data:
 * a fresh live query for every "failed" grpId resolved FINE outside the draft's concurrent load
 * (only a genuine one -- a special-art land variant Scryfall's arena_id field simply doesn't have
 * -- was a real 404). The actual causes were (1) every call re-resolved the ENTIRE pick history
 * from scratch (no cross-call cache), so cost grew without bound as the draft went on, and (2)
 * that growing burst of concurrent requests exposed a race in scryfallFetch's rate-limit pacing
 * (fixed separately in scryfall/client.js), which let concurrent callers bypass the pacing and
 * trip Scryfall's real limit under load. Fixed here via an optional caller-supplied cache (see
 * `options.cache`) -- a grpId only needs to be looked up once for the life of the process, ever,
 * including a confirmed miss (a permanent 404 won't resolve differently on a later retry).
 */

/**
 * @param {number[]} grpIds - distinct grpIds to resolve
 * @param {(query: string) => Promise<object[]>} searchCardsFn -
 *        should call the MCP's existing search_cards tool and return its
 *        parsed array response, e.g. via
 *        (query) => callTool('search_cards', { query })
 * @param {{ cache?: Map<number, object|null> }} [options] -
 *        Optional pre-existing grpId -> card (or null) cache to read through and write into.
 *        Pass the SAME Map across calls (e.g. one draft session, or the whole process) to avoid
 *        ever re-resolving a grpId this process has already seen -- including a confirmed miss.
 * @returns {Promise<{ cards: Map<number, object|null>, errors: Map<number, string> }>}
 *        `cards`: grpId -> card data (or null if not found/failed).
 *        `errors`: grpId -> the actual failure message, for any grpId whose lookup threw (a
 *        genuine 404, a network error, etc) -- present ONLY for entries resolved during this
 *        call, not for cache hits (a cached failure's original reason isn't preserved).
 */
async function resolveGrpIds(grpIds, searchCardsFn, options = {}) {
  const cache = options.cache ?? new Map();
  const uniqueIds = [...new Set(grpIds)];
  const cards = new Map();
  const errors = new Map();

  const toFetch = [];
  for (const grpId of uniqueIds) {
    if (cache.has(grpId)) {
      cards.set(grpId, cache.get(grpId));
    } else {
      toFetch.push(grpId);
    }
  }

  // Sequential with small concurrency cap rather than Promise.all(all-at-once):
  // avoids hammering Scryfall if a match/draft surfaces dozens of distinct ids.
  const CONCURRENCY = 5;
  let index = 0;

  async function worker() {
    while (index < toFetch.length) {
      const grpId = toFetch[index++];
      let card = null;
      try {
        const matches = await searchCardsFn(`arena_id:${grpId}`);
        card = matches && matches.length ? matches[0] : null;
      } catch (err) {
        errors.set(grpId, err.message);
      }
      cards.set(grpId, card);
      cache.set(grpId, card); // cache the outcome either way -- see module comment
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, worker)
  );

  return { cards, errors };
}

/**
 * Convenience: take a buildMatchTimeline() timeline + instanceToGrpId map,
 * resolve every distinct grpId referenced in it, and return the timeline
 * with card names/data attached instead of bare grpIds.
 */
async function enrichTimeline(timeline, searchCardsFn, options = {}) {
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

  const { cards } = await resolveGrpIds(grpIds, searchCardsFn, options);

  const attachCard = (obj) => {
    if (obj && typeof obj === 'object') {
      if (obj.grpId != null) {
        obj.card = cards.get(obj.grpId) || null;
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
