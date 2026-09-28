import { buildCardQuery } from "./cards.js";
async function findCandidates(db, filters, limit, priceSource = "cardkingdom", opts = {}) {
  const [first, second] = priceSource === "manapool" ? ["manapool", "cardkingdom"] : ["cardkingdom", "manapool"];
  return db.collection("cards").aggregate([
    { $match: buildCardQuery(filters) },
    // sample: a fresh random draw from ALL matches each call (commander suggestions reshuffle on
    // every request) instead of the first N in natural order.
    opts.sample ? { $sample: { size: limit } } : { $limit: limit },
    {
      $project: {
        name: 1,
        cmc: 1,
        type_line: 1,
        roles: { $ifNull: ["$role_flags", []] },
        color_identity: { $ifNull: ["$color_identity", []] },
        price_usd: {
          $let: {
            vars: {
              latest: { $first: { $sortArray: { input: { $ifNull: ["$scryfall_printings", []] }, sortBy: { released_at: -1 } } } }
            },
            in: {
              $let: {
                vars: {
                  m: { $first: { $filter: { input: { $ifNull: ["$market_data", []] }, as: "m", cond: { $eq: ["$$m.scryfall_id", "$$latest.scryfall_id"] } } } }
                },
                in: { $ifNull: [`$$m.${first}.price_usd`, `$$m.${second}.price_usd`] }
              }
            }
          }
        }
      }
    }
  ]).toArray();
}
function seededShuffle(items, seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = h << 13 | h >>> 19;
  let a = h >>> 0;
  const rand = () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export {
  findCandidates,
  seededShuffle
};
