import { Db } from 'mongodb';
import { DeckPromptConstraints } from '../query/deck-prompts.js';

/**
 * functions/push/deck-drafts.ts
 *
 * `deck_drafts` (2026-09-27) -- fill_deck_plan's filled deck, held server-side so the model can
 * submit it with a few swaps instead of retyping ~100 lines (validate_and_submit's draft_id path).
 * Short-lived working state: expires_at is 7 days out, and nothing reads a draft after it's
 * submitted except a re-submit of the same draft.
 */

interface DraftEntry {
    oracle_id: string;
    name: string;
    qty: number;
}
interface DraftSlot {
    label: string;
    requested: number;
    picks: DraftEntry[];
    alternates: Array<{
        oracle_id: string;
        name: string;
    }>;
}
interface DeckDraftDoc {
    _id: string;
    owner_user_id: string;
    prompt_id: string | null;
    format: string;
    deck_name: string | null;
    commander: {
        oracle_id: string;
        name: string;
        color_identity: string[];
    } | null;
    constraints: DeckPromptConstraints;
    slots: DraftSlot[];
    basics: DraftEntry[];
    created_at: Date;
    expires_at: Date;
}
declare function saveDraft(db: Db, draft: Omit<DeckDraftDoc, "_id" | "created_at" | "expires_at">): Promise<string>;
declare function getDraft(db: Db, id: string, ownerUserId: string): Promise<DeckDraftDoc | null>;

export { type DeckDraftDoc, type DraftEntry, type DraftSlot, getDraft, saveDraft };
