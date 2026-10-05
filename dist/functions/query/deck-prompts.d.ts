import { Db } from 'mongodb';

/**
 * functions/query/deck-prompts.ts
 *
 * manaramp-mcp's side of manaramp's `deck_prompts` collection (see manaramp's
 * src/lib/server/schema/deck_prompts.ts, 2026-09-27) -- the stored "Create with AI" brief. Read by
 * deck_plan_guide / fill_deck_plan by id; created here when a user asks the AI for a deck directly in
 * chat (skipping the website form), so every AI-built deck has the same shape. Kept as a separate
 * copy of the types, per this repo's boundary (manaramp doesn't depend on manaramp-mcp or vice versa).
 */

interface DeckPromptConstraints {
    colors: string[];
    max_price_usd: number | null;
    bracket: number | null;
    /** What the deck should DO -- "bats", "ping opponents when creatures enter" (2026-09-28). */
    theme?: string | null;
    /** What to AVOID / hard rules -- "no aristocrats", "no infinite combos". */
    restrictions: string | null;
    build_style: "original" | "community";
    use_synergies: boolean;
    use_combos: boolean;
    /** User-set card-type counts (Land, Creature, ...) summing to the deck size minus commander, or
     *  null for the defaults (2026-09-28, Create with AI sliders). */
    type_targets?: Record<string, number> | null;
    /** User-set role counts (ramp, card_draw, removal, ...), or null for the defaults. */
    role_targets?: Record<string, number> | null;
}
interface DeckPromptDoc extends DeckPromptConstraints {
    _id: string;
    owner_user_id: string;
    name: string | null;
    format: string;
    platform: string | null;
    commander: {
        oracle_id: string;
        name: string;
        color_identity: string[];
    } | null;
    prompt_text: string;
    status: "pending" | "built" | "expired";
    deck_ids: string[];
    source?: "website" | "chat";
    /** The deck this prompt's build saves into, in place: the deck being rebuilt ("Edit with AI",
     *  2026-09-28), or -- for a new Commander deck from the website (2026-10-03) -- the empty
     *  placeholder deck made with the prompt, so the user can watch it fill in. Cleared by manaramp if
     *  that placeholder is cleaned up unused. */
    deck_id?: string | null;
    created_at: Date;
    updated_at: Date;
}
/** Accepts "k7f2q9" or "#k7f2q9". Null when missing or owned by someone else. */
declare function getDeckPrompt(db: Db, id: string, ownerUserId: string): Promise<DeckPromptDoc | null>;
declare function constraintsOf(p: DeckPromptDoc): DeckPromptConstraints;
declare function createChatDeckPrompt(db: Db, ownerUserId: string, input: {
    format: string;
    name: string | null;
    commander: DeckPromptDoc["commander"];
    constraints: DeckPromptConstraints;
}): Promise<string>;
/** The prompt's target deck id, but only if that deck still exists and belongs to the caller
 *  (2026-10-04). A placeholder can be cleaned up or deleted by the user before the prompt is run --
 *  then the build just makes a new deck instead of failing with "No deck '...'". */
declare function promptDeckId(db: Db, prompt: DeckPromptDoc | null, ownerUserId: string): Promise<string | null>;
/** What to tell the model when a prompt id doesn't resolve for this account (2026-10-04). The
 *  common real case: the user made the prompt signed in to one Manaramp account on the website, but
 *  this assistant is connected to ANOTHER. Previously the model was told to "continue without one",
 *  so it built on the connected account while the website's placeholder deck sat empty on the
 *  other -- now it's told to stop and explain. Only says the prompt exists elsewhere; never reveals
 *  anything about the other account. */
declare function promptNotFoundMessage(db: Db, id: string, ownerUserId: string, accountLabel: string | null): Promise<string>;
declare function markPromptBuilt(db: Db, id: string, deckId: string): Promise<void>;

export { type DeckPromptConstraints, type DeckPromptDoc, constraintsOf, createChatDeckPrompt, getDeckPrompt, markPromptBuilt, promptDeckId, promptNotFoundMessage };
