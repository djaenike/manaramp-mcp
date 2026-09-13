/**
 * schema/draft_sessions.js
 *
 * Live per-user Arena draft state -- separate from `cards` since it's session state, not card
 * reference data. A single query returns the current pack plus this user's full pick history.
 * Design only -- not wired into index.js yet.
 *
 * Mirrored at manaramp/src/lib/server/schema/draft_sessions.ts -- keep both in sync.
 */

const DRAFT_SESSIONS = {
  bsonType: "object",
  required: ["_id", "user_id", "set_code", "format", "started_at"],
  properties: {
    _id: { bsonType: "string", description: "Arena's own draft_id from the log." },
    user_id: { bsonType: "string", description: "Anonymous per-install UUID (index.js getOrCreateUserId)." },
    event_name: { bsonType: "string" },
    set_code: { bsonType: "string" },
    format: { bsonType: "string" },
    started_at: { bsonType: "date" },
    updated_at: { bsonType: "date" },
    picks: {
      bsonType: "array",
      description: "Full pick history, in order.",
      items: {
        bsonType: "object",
        properties: {
          pack_number: { bsonType: "int" },
          pick_number: { bsonType: "int" },
          grp_id: { bsonType: "int" },
          oracle_id: { bsonType: ["string", "null"] },
          picked_at: { bsonType: "date" },
        },
      },
    },
    current_pack: {
      bsonType: ["object", "null"],
      properties: {
        pack_number: { bsonType: "int" },
        pick_number: { bsonType: "int" },
        grp_ids: { bsonType: "array", items: { bsonType: "int" } },
      },
    },
  },
};

export { DRAFT_SESSIONS };
