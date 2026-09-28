/**
 * functions/push/deck-drafts.ts
 *
 * `deck_drafts` (2026-09-27) -- fill_deck_plan's filled deck, held server-side so the model can
 * submit it with a few swaps instead of retyping ~100 lines (validate_and_submit's draft_id path).
 * Short-lived working state: expires_at is 7 days out, and nothing reads a draft after it's
 * submitted except a re-submit of the same draft.
 */
import type { Db } from "mongodb";
import type { DeckPromptConstraints } from "../query/deck-prompts.js";

interface DraftEntry {
  oracle_id: string;
  name: string;
  qty: number;
}

interface DraftSlot {
  label: string;
  requested: number;
  picks: DraftEntry[];
  alternates: Array<{ oracle_id: string; name: string }>;
}

interface DeckDraftDoc {
  _id: string;
  owner_user_id: string;
  prompt_id: string | null;
  format: string;
  deck_name: string | null;
  commander: { oracle_id: string; name: string; color_identity: string[] } | null;
  constraints: DeckPromptConstraints;
  slots: DraftSlot[];
  basics: DraftEntry[];
  created_at: Date;
  expires_at: Date;
}

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function saveDraft(db: Db, draft: Omit<DeckDraftDoc, "_id" | "created_at" | "expires_at">): Promise<string> {
  const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const now = new Date();
  await db.collection<DeckDraftDoc>("deck_drafts").insertOne({ _id: id, ...draft, created_at: now, expires_at: new Date(now.getTime() + DRAFT_TTL_MS) });
  return id;
}

async function getDraft(db: Db, id: string, ownerUserId: string): Promise<DeckDraftDoc | null> {
  const doc = await db.collection<DeckDraftDoc>("deck_drafts").findOne({ _id: id.trim() });
  if (!doc || doc.owner_user_id !== ownerUserId) return null;
  return doc.expires_at < new Date() ? null : doc;
}

export { saveDraft, getDraft };
export type { DeckDraftDoc, DraftSlot, DraftEntry };
