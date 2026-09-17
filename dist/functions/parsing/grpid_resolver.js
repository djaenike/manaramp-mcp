async function resolveGrpIds(grpIds, batchResolveFn, options = {}) {
  const cache = options.cache ?? /* @__PURE__ */ new Map();
  const uniqueIds = [...new Set(grpIds)];
  const cards = /* @__PURE__ */ new Map();
  const errors = /* @__PURE__ */ new Map();
  const toFetch = [];
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
        cache.set(grpId, card);
      }
    } catch (err) {
      for (const grpId of toFetch) errors.set(grpId, err.message);
    }
  }
  return { cards, errors };
}
async function enrichTimeline(timeline, batchResolveFn, options = {}) {
  const grpIds = [];
  const collect = (obj) => {
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
  const attachCard = (obj) => {
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
export {
  enrichTimeline,
  resolveGrpIds
};
