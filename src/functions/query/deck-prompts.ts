/**
 * functions/query/deck-prompts.ts
 *
 * manaramp-mcp's side of manaramp's `deck_prompts` collection (see manaramp's
 * src/lib/server/schema/deck_prompts.ts, 2026-09-27) -- the stored "Create with AI" brief. Read by
 * deck_plan_guide / fill_deck_plan by id; created here when a user asks the AI for a deck directly in
 * chat (skipping the website form), so every AI-built deck has the same shape. Kept as a separate
 * copy of the types, per this repo's boundary (manaramp doesn't depend on manaramp-mcp or vice versa).
 */
import type { Db } from "mongodb";

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
  commander: { oracle_id: string; name: string; color_identity: string[] } | null;
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

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function shortId(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/** Accepts "k7f2q9" or "#k7f2q9". Null when missing or owned by someone else. */
async function getDeckPrompt(db: Db, id: string, ownerUserId: string): Promise<DeckPromptDoc | null> {
  const doc = await db.collection<DeckPromptDoc>("deck_prompts").findOne({ _id: id.replace(/^#/, "").trim().toLowerCase() });
  return doc && doc.owner_user_id === ownerUserId ? doc : null;
}

function constraintsOf(p: DeckPromptDoc): DeckPromptConstraints {
  return {
    colors: p.colors ?? [],
    max_price_usd: p.max_price_usd ?? null,
    bracket: p.bracket ?? null,
    theme: p.theme ?? null,
    restrictions: p.restrictions ?? null,
    build_style: p.build_style ?? "original",
    use_synergies: !!p.use_synergies,
    use_combos: !!p.use_combos,
    type_targets: p.type_targets ?? null,
    role_targets: p.role_targets ?? null,
  };
}

async function createChatDeckPrompt(
  db: Db,
  ownerUserId: string,
  input: { format: string; name: string | null; commander: DeckPromptDoc["commander"]; constraints: DeckPromptConstraints }
): Promise<string> {
  const col = db.collection<DeckPromptDoc>("deck_prompts");
  let id = shortId();
  for (let i = 0; i < 5 && (await col.findOne({ _id: id }, { projection: { _id: 1 } })); i++) id = shortId();
  const now = new Date();
  await col.insertOne({
    _id: id,
    owner_user_id: ownerUserId,
    name: input.name,
    format: input.format,
    platform: null,
    commander: input.commander,
    ...input.constraints,
    prompt_text: "(created from chat by the AI assistant -- no website prompt)",
    status: "pending",
    deck_ids: [],
    source: "chat",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** The prompt's target deck id, but only if that deck still exists and belongs to the caller
 *  (2026-10-04). A placeholder can be cleaned up or deleted by the user before the prompt is run --
 *  then the build just makes a new deck instead of failing with "No deck '...'". */
async function promptDeckId(db: Db, prompt: DeckPromptDoc | null, ownerUserId: string): Promise<string | null> {
  if (!prompt?.deck_id) return null;
  const deck = await db.collection<{ _id: string; owner_user_id: string }>("decks").findOne({ _id: prompt.deck_id, owner_user_id: ownerUserId }, { projection: { _id: 1 } });
  return deck ? deck._id : null;
}

/** What to tell the model when a prompt id doesn't resolve for this account (2026-10-04). The
 *  common real case: the user made the prompt signed in to one Manaramp account on the website, but
 *  this assistant is connected to ANOTHER. Previously the model was told to "continue without one",
 *  so it built on the connected account while the website's placeholder deck sat empty on the
 *  other -- now it's told to stop and explain. Only says the prompt exists elsewhere; never reveals
 *  anything about the other account. */
async function promptNotFoundMessage(db: Db, id: string, ownerUserId: string, accountLabel: string | null): Promise<string> {
  const cleanId = id.replace(/^#/, "").trim().toLowerCase();
  const exists = await db.collection<DeckPromptDoc>("deck_prompts").findOne({ _id: cleanId }, { projection: { owner_user_id: 1 } });
  if (exists && exists.owner_user_id !== ownerUserId) {
    const who = accountLabel ? ` (${accountLabel})` : "";
    return (
      `Deck prompt '#${cleanId}' was made on a different Manaramp account than the one this assistant is connected to${who}. ` +
      "Do NOT build the deck and do not continue without the prompt -- that would put the deck on the wrong account. " +
      `Tell the user briefly: this assistant is signed in to Manaramp as ${accountLabel ?? "a different account"}; either sign in to manaramp.com ` +
      "with that account and create the prompt again, or reconnect the assistant's Manaramp connector to the account that made the prompt."
    );
  }
  return `No deck prompt '#${cleanId}' exists -- check the id with the user, or build from what they said in chat instead.`;
}

async function markPromptBuilt(db: Db, id: string, deckId: string): Promise<void> {
  await db
    .collection<DeckPromptDoc>("deck_prompts")
    .updateOne({ _id: id }, { $set: { status: "built", updated_at: new Date() }, $addToSet: { deck_ids: deckId } });
}

export { getDeckPrompt, constraintsOf, createChatDeckPrompt, markPromptBuilt, promptDeckId, promptNotFoundMessage };
export type { DeckPromptDoc, DeckPromptConstraints };
