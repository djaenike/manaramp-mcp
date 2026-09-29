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
  /** Set when the prompt REBUILDS an existing deck ("Edit with AI", 2026-09-28) -- the build
   *  overwrites that deck instead of creating a new one. */
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

async function markPromptBuilt(db: Db, id: string, deckId: string): Promise<void> {
  await db
    .collection<DeckPromptDoc>("deck_prompts")
    .updateOne({ _id: id }, { $set: { status: "built", updated_at: new Date() }, $addToSet: { deck_ids: deckId } });
}

export { getDeckPrompt, constraintsOf, createChatDeckPrompt, markPromptBuilt };
export type { DeckPromptDoc, DeckPromptConstraints };
