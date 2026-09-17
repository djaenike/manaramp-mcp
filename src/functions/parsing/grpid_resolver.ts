/**
 * grpid_resolver.ts
 *
 * Resolves Arena's numeric grpIds to real card data via manaramp's own `cards` collection
 * (2026-09-17, second pass -- see CLAUDE.md's "Arena tools reach manaramp too now" section).
 * Previously did this via live Scryfall `arena_id:` search, one query per id through a
 * concurrency-capped worker pool -- gone entirely now, along with the concurrency pool: the
 * injected resolver is a single BATCH call (query_cards' arena_grp_ids filter, over the
 * authenticated remote client -- see tools/shared/arena-local-state.ts), so every still-unresolved
 * grpId for a call resolves in one request instead of N.
 *
 * This module is intentionally decoupled from HOW the batch lookup is invoked (direct Mongo query
 * vs. an injected function calling out over HTTP), so it can be unit-tested with a fake resolver.
 *
 * Cache behavior unchanged from the original design: a grpId only needs to be looked up once for
 * the life of the process (see `options.cache`), including a confirmed miss -- that's still a fact
 * about the card data itself, not about any one draft/game/session.
 */

/** A resolved card (or null for a confirmed miss), as returned by whatever query_cards-shaped
 *  function is injected -- this module doesn't care about the exact card shape beyond that. */
type ResolvedCard = Record<string, unknown> | null;

/** Batch resolver: takes every grpId that needs a fresh lookup this call, returns whatever it
 *  found keyed by grpId (a miss for a given id is simply absent from the returned Map, not an
 *  explicit null entry -- resolveGrpIds treats "not in the map" as a miss). */
type BatchResolveFn = (grpIds: number[]) => Promise<Map<number, ResolvedCard>>;

interface ResolveGrpIdsOptions {
  /**
   * Optional pre-existing grpId -> card (or null) cache to read through and write into.
   * Pass the SAME Map across calls (e.g. one draft session, or the whole process) to avoid
   * ever re-resolving a grpId this process has already seen -- including a confirmed miss.
   */
  cache?: Map<number, ResolvedCard>;
}

interface ResolveGrpIdsResult {
  /** grpId -> card data (or null if not found/failed). */
  cards: Map<number, ResolvedCard>;
  /**
   * grpId -> the actual failure message, for any grpId whose batch lookup threw (a network error,
   * etc) -- present ONLY for entries this call attempted to resolve, not for cache hits (a cached
   * failure's original reason isn't preserved). Every grpId in a failed batch shares the same
   * error message, since it's one request for the whole batch now, not one per id.
   */
  errors: Map<number, string>;
}

async function resolveGrpIds(
  grpIds: number[],
  batchResolveFn: BatchResolveFn,
  options: ResolveGrpIdsOptions = {}
): Promise<ResolveGrpIdsResult> {
  const cache = options.cache ?? new Map<number, ResolvedCard>();
  const uniqueIds = [...new Set(grpIds)];
  const cards = new Map<number, ResolvedCard>();
  const errors = new Map<number, string>();

  const toFetch: number[] = [];
  for (const grpId of uniqueIds) {
    if (cache.has(grpId)) {
      cards.set(grpId, cache.get(grpId) ?? null);
    } else {
      toFetch.push(grpId);
    }
  }

  if (toFetch.length) {
    try {
      const resolved = await batchResolveFn(toFetch);
      for (const grpId of toFetch) {
        const card = resolved.get(grpId) ?? null;
        cards.set(grpId, card);
        cache.set(grpId, card); // cache the outcome either way -- see module header
      }
    } catch (err: any) {
      for (const grpId of toFetch) errors.set(grpId, err.message);
    }
  }

  return { cards, errors };
}

/**
 * Convenience: take a buildMatchTimeline() timeline + instanceToGrpId map,
 * resolve every distinct grpId referenced in it, and return the timeline
 * with card names/data attached instead of bare grpIds.
 */
async function enrichTimeline(
  timeline: Array<Record<string, any>>,
  batchResolveFn: BatchResolveFn,
  options: ResolveGrpIdsOptions = {}
): Promise<Array<Record<string, any>>> {
  const grpIds: number[] = [];
  const collect = (obj: any) => {
    if (obj && typeof obj === "object") {
      if (obj.grpId != null) grpIds.push(obj.grpId);
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(collect);
        else if (typeof v === "object") collect(v);
      }
    }
  };
  timeline.forEach(collect);

  const { cards } = await resolveGrpIds(grpIds, batchResolveFn, options);

  const attachCard = (obj: any) => {
    if (obj && typeof obj === "object") {
      if (obj.grpId != null) {
        obj.card = cards.get(obj.grpId) || null;
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(attachCard);
        else if (typeof v === "object") attachCard(v);
      }
    }
  };
  timeline.forEach(attachCard);

  return timeline;
}

export { resolveGrpIds, enrichTimeline };
export type { ResolvedCard, BatchResolveFn, ResolveGrpIdsOptions, ResolveGrpIdsResult };
