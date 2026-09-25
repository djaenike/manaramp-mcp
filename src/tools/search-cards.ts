/**
 * tools/search-cards.ts -- query_cards
 *
 * Promoted from tools/internal-tools.ts (2026-09-18) into a real, conversational, model-facing
 * tool -- it used to be marked "internal use only" purely so the local Arena tools' own remote
 * calls (which reuse this exact name via callRemoteTool, see tools/shared/remote-client.ts) had
 * something to call, with an explicit description discouraging a calling model from reaching for it
 * directly. That framing actively backfired: a real testing session found a model respecting the
 * "internal only" wording and avoiding it even when it was exactly the right tool for looking up
 * real cards before assembling a decklist -- pushing it toward guessing from general MTG knowledge
 * instead of manaramp's own database, the opposite of what's wanted.
 *
 * Tool NAME stays exactly "query_cards" (unchanged) -- the local Arena tools' own
 * resolveGrpIdsViaManaramp call reaches this by that literal string over HTTP, and renaming it here
 * would silently break that internal contract. Only the description/framing changed; the schema and
 * handler are untouched (still a thin wrapper -- functions/query/cards.ts's queryCards has the real
 * logic).
 */

import { z } from "zod";
import { queryCards, type CardSummary } from "../functions/query/cards.js";
import type { ToolDefinition } from "./types.js";

// Compact per-card shape (2026-09-25) -- the default response. The full CardSummary measured at
// ~1,250 tokens PER CARD against real data (a default 25-card search was ~110KB / ~31k tokens):
// the raw Forge effects tree was 37% of it, the every-format legalities map 19%, every 17Lands
// row with all its sample sizes 15%, and pretty-print indentation nearly doubled the lot. A deck
// build runs many searches, and every result stays in the conversation, which is what burned
// through a user's credits in 2-3 minutes. This keeps what card choice actually needs:
// oracle text for what a card does, effect_names for Forge-vocabulary discovery (what effect_in
// matches against), price, and a trimmed format_stats. detail: "full" still returns the
// untouched CardSummary.
interface CompactCard {
  name: string;
  oracle_id: string;
  mana_cost?: string;
  cmc?: number;
  type_line: string;
  oracle_text?: string;
  pt?: string;
  loyalty?: string;
  color_identity: string;
  keywords?: string[];
  effect_names?: string[];
  price_usd?: number;
  format_stats?: Array<{ set: string; format: string; gih_wr: number | null; alsa: number | null; ata: number | null; iih: number | null; gih_n: number | null }>;
}

/** Every distinct Forge effect name anywhere in a card's effects tree (result steps, charm choices,
 *  branches, nested effects -- not created tokens' own abilities), prefixed with the owning ability's trigger kind -- e.g.
 *  ["cast:Charm", "cast:Destroy", "cast:Animate"]. Walks generically rather than per-field so a
 *  new nesting key in the Forge shape can't silently drop names. */
function effectNames(effects: CardSummary["effects"]): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, kind: string) => {
    if (Array.isArray(node)) { for (const n of node) walk(n, kind); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const trigger = obj.trigger as { kind?: string } | undefined;
    const k = trigger?.kind ?? kind;
    if (typeof obj.effect === "string") out.add(`${k}:${obj.effect}`);
    for (const [key, value] of Object.entries(obj)) {
      // tokens: a created token's OWN abilities aren't this card's (oracle text already says what
      // it makes).
      if (key === "params" || key === "conditions" || key === "formulas" || key === "tokens") continue;
      walk(value, k);
    }
  };
  walk(effects, "?");
  return [...out];
}

function toCompact(c: CardSummary): CompactCard {
  const out: CompactCard = { name: c.name, oracle_id: c.oracle_id, type_line: c.type_line, color_identity: c.color_identity.join("") || "C" };
  if (c.mana_cost) out.mana_cost = c.mana_cost;
  if (c.cmc != null) out.cmc = c.cmc;
  if (c.oracle_text) out.oracle_text = c.oracle_text;
  if (c.power != null || c.toughness != null) out.pt = `${c.power ?? "?"}/${c.toughness ?? "?"}`;
  if (c.loyalty != null) out.loyalty = c.loyalty;
  if (c.keywords?.length) out.keywords = c.keywords;
  const names = effectNames(c.effects);
  if (names.length) out.effect_names = names;
  if (c.price_usd != null) out.price_usd = c.price_usd;
  if (c.format_stats?.length) {
    out.format_stats = c.format_stats.map((f) => ({
      set: f.set_code,
      format: f.format,
      gih_wr: f.games_in_hand_win_rate,
      alsa: f.avg_last_seen_at,
      ata: f.avg_taken_at,
      iih: f.improvement_in_hand,
      gih_n: f.games_in_hand_sample_size,
    }));
  }
  return out;
}

const inputSchema = {
  names: z.array(z.string()).optional().describe("Exact (case-insensitive) name batch lookup. Takes precedence over every filter below."),
  oracle_ids: z.array(z.string()).optional().describe("Batch lookup by the `cards` collection's own _id. Same priority as names."),
  arena_grp_ids: z.array(z.number()).optional().describe("Arena's numeric grpIds -- batch lookup. Same priority as names/oracle_ids."),
  name_contains: z.string().optional().describe("Substring search against card names, case-insensitive."),
  color_identity_subset_of: z.array(z.string()).optional().describe("Cards whose color_identity is a SUBSET of this list -- the standard 'legal to include under this commander' filter, e.g. ['W','U','B'] for an Esper commander."),
  colors_include: z.array(z.string()).optional().describe("Cards whose `colors` array includes ALL of these."),
  category: z.string().optional().describe("e.g. 'Creature', 'Instant', 'Land', 'Artifact', 'Planeswalker', 'Other'."),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  oracle_text_contains: z.string().optional().describe("Substring search against oracle text, case-insensitive."),
  legal_in: z.string().optional().describe("A format key, e.g. 'commander', 'modern' -- only returns cards legal in that format."),
  max_price_usd: z.number().optional(),
  effect_in: z
    .array(z.string())
    .optional()
    .describe(
      "Ability search, rebuilt on each card's real Forge effect data (2026-09-22) -- matches any card with at least one " +
        "effect step whose Forge ApiType effect name is in this list (OR-matched, so hedge with a few candidate names " +
        "instead of guessing exactly one). Forge's real vocabulary is ~200 distinct names, mostly plain English verb-phrases: " +
        "Draw, Discard, Mill, Scry, GainLife, LoseLife, DealDamage, Tap, Untap, Counter (counterspells), PutCounter/" +
        "PutCounterAll, Token, Destroy/DestroyAll, Exile/ExileAll, Sacrifice/SacrificeAll, ChangeZone (tutors/recursion/" +
        "discard-selection -- see effect_param_contains to narrow by Origin$/Destination$). Examples: removal = " +
        "[\"Destroy\",\"DestroyAll\",\"Exile\",\"ExileAll\"]; direct damage = [\"DealDamage\"]; sac outlets = " +
        "[\"Sacrifice\",\"SacrificeAll\"]. When unsure of the exact spelling, run a query WITHOUT this filter first and " +
        "check a few results' effect_names values before narrowing.",
    ),
  trigger_kind: z
    .enum(["cast", "activate", "triggered", "static", "replacement"])
    .optional()
    .describe(
      "Narrows effect_in to steps belonging to an effect of this specific kind -- e.g. 'activate' for an ACTIVATED removal " +
        "ability specifically, vs any removal regardless of how it fires. Or use alone (no effect_in) for 'any static " +
        "ability, don't care what it does.' The kind and effect_in match MUST belong to the same ability on the card, not " +
        "just both exist somewhere on it.",
    ),
  effect_param_contains: z
    .object({
      key: z.string().describe("The raw Forge field name, e.g. 'Origin', 'Destination', 'ValidTgts', 'TokenScript'."),
      value_contains: z.string().describe("Case-insensitive substring to match against that field's value."),
    })
    .optional()
    .describe(
      "Precision filter within the SAME step matched by effect_in (or any step, if effect_in is omitted) -- checked " +
        "against that step's params and its own conditions. Tutors = effect_in: [\"ChangeZone\"], " +
        "effect_param_contains: {key: \"Origin\", value_contains: \"Library\"}. Player-targeted damage = " +
        "effect_in: [\"DealDamage\"], effect_param_contains: {key: \"ValidTgts\", value_contains: \"Player\"} (also try " +
        "\"Opponent\", scripts vary). Only one key/value pair per call -- run two queries and intersect results if you " +
        "need two conditions on the same step.",
    ),
  limit: z.number().optional().describe("Max results (default 25, capped at 100). Ignored for names/oracle_ids/arena_grp_ids batch lookups."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      "'summary' (default): name, mana cost, type, oracle text, P/T, color identity, price, effect_names (the Forge " +
        "effect names effect_in matches, as 'kind:Effect'), and trimmed 17Lands format_stats. 'full': the complete record " +
        "-- the raw Forge effects tree, every format's legality, printing/image, full 17Lands rows. Only ask for 'full' " +
        "when you genuinely need those; it's roughly 5x larger per card.",
    ),
};

const queryCardsTool: ToolDefinition<typeof inputSchema> = {
  name: "query_cards",
  description:
    "Look up real cards from manaramp's own database -- by exact name (batch), oracle_id, Arena " +
    "grpId, or a filtered search (color identity, mana value, ability search via effect_in/" +
    "trigger_kind/effect_param_contains -- Forge's own real effect data, see effect_in's own " +
    "description for the vocabulary and examples -- price, format legality, oracle-text substring, " +
    "etc). Prefer this over general knowledge when assembling or researching a decklist -- ground " +
    "card choices in what's actually here rather than guessing, then feed the assembled decklist " +
    "into validate_and_submit. A result with no effect_names means this card genuinely has no " +
    "scripted ability (a vanilla creature, a basic land) -- confirmed, not unclassified. Legality: " +
    "filter with legal_in rather than reading it off results (the per-format map is only in detail: 'full').",
  inputSchema,
  handler: async (args, ctx) => {
    // Falls back to 'cardkingdom'/'most_recent' for a legacy account with no preference saved yet,
    // AND for a local-stdio call where ctx has no such getter at all -- see tools/types.ts's
    // McpContext.
    const priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";
    const preferredPrinting = (await ctx.getPreferredPrintingPreference?.()) ?? "most_recent";
    const { detail, ...filters } = args;
    const cards = await queryCards(ctx.readDb, filters, priceSource, preferredPrinting);
    const body = detail === "full" ? cards : cards.map(toCompact);
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
  },
};

export { queryCardsTool };
