/**
 * tools/shared/save-deck.ts
 *
 * The one "analyze + persist a decklist" path (2026-09-28), shared by validate_and_submit and
 * fill_deck_plan's direct save -- so a deck saved straight from a fill is stored exactly like one
 * submitted after review (same consistency analysis, same fields, same stats refresh via
 * ctx.onDeckSaved, same prompt bookkeeping).
 */
import { getDeckDoc, type DeckDoc } from "../../functions/query/decks.js";
import { pushDeck } from "../../functions/push/deck.js";
import { getDeckPrompt, markPromptBuilt, promptDeckId, type DeckPromptConstraints } from "../../functions/query/deck-prompts.js";
import { analyzeDecklist, type DeckAnalysis } from "./deck-analysis.js";
import type { McpContext } from "../types.js";

interface SaveDeckInput {
  decklist_text: string;
  deck_name: string;
  format: string;
  wincon_summary: string;
  general_strategy: string;
  bracket_estimate?: string | null;
  is_public?: boolean;
  /** Overwrite this deck instead of creating one. Must belong to the caller. */
  deck_id?: string | null;
  prompt_id?: string | null;
  constraints?: DeckPromptConstraints | null;
  source: string;
  /** Only save when the analysis finds no blocking issue (wrong size, off-identity, illegal,
   *  unknown cards) -- fill_deck_plan's direct save. validate_and_submit saves regardless, as before. */
  requireClean?: boolean;
}

type SaveDeckResult =
  | { saved: true; deck_id: string; deck_url: string; analysis: DeckAnalysis; priceSource: string }
  | { saved: false; error?: string; analysis?: DeckAnalysis; priceSource: string };

async function saveDecklist(ctx: McpContext, input: SaveDeckInput): Promise<SaveDeckResult> {
  const priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";

  // No explicit deck_id but the list came from a prompt (2026-10-04): save into the prompt's own deck
  // (its rebuild target, or the website's empty placeholder) when it still exists. Without this, a
  // validate_and_submit of an unsaved fill_deck_plan draft only hit that deck if the model remembered
  // to pass deck_id -- otherwise it made a SECOND deck and left the placeholder empty.
  const deckId = input.deck_id ?? (input.prompt_id ? await promptDeckId(ctx.writeDb, await getDeckPrompt(ctx.writeDb, input.prompt_id, ctx.ownerUserId), ctx.ownerUserId) : null);
  let existingDeck: DeckDoc | null = null;
  if (deckId) {
    existingDeck = await getDeckDoc(ctx.writeDb, { deck_id: deckId });
    if (!existingDeck) return { saved: false, error: `No deck found with deck_id '${deckId}'.`, priceSource };
    if (existingDeck.owner_user_id !== ctx.ownerUserId) return { saved: false, error: `deck_id '${deckId}' isn't owned by this account.`, priceSource };
  }

  let analysis: DeckAnalysis;
  try {
    analysis = await analyzeDecklist(ctx.readDb, input.decklist_text, priceSource);
  } catch (e: any) {
    return { saved: false, error: e.message, priceSource };
  }
  const { commanderNames, deckEntries, consistency, facts, priceTotal, totalCards } = analysis;
  if (input.requireClean && (consistency.issues.length || consistency.not_found.length)) return { saved: false, analysis, priceSource };

  const commanderOracleIds = commanderNames.map((n) => consistency.card_details.get(n)?.oracle_id).filter((id): id is string => Boolean(id));
  const cardOracleIds = deckEntries
    .filter((e) => !commanderNames.includes(e.name))
    .flatMap((e) => {
      const oracleId = consistency.card_details.get(e.name)?.oracle_id;
      return oracleId ? Array(e.qty).fill(oracleId) : [];
    });

  const pushed = await pushDeck(
    ctx.writeDb,
    ctx.ownerUserId,
    {
      name: input.deck_name,
      format: input.format,
      cards: cardOracleIds,
      sideboard: null,
      size_summary: { main: cardOracleIds.length, sideboard: 0, commander: commanderOracleIds.length, total: totalCards },
      commander: commanderOracleIds.length ? { oracle_ids: commanderOracleIds, color_identity: consistency.commander_color_identity } : null,
      // Only when the model judged a bracket -- never auto-derived from combos_found.
      bracket: input.bracket_estimate ? { estimate: input.bracket_estimate, combos_found: facts.combos_found.map((c) => ({ pieces: c.pieces, speed: c.speed })) } : null,
      mana_curve: consistency.mana_curve,
      curve_out_probability: consistency.curve_out_probability,
      consistency_issues: consistency.issues,
      price_usd: priceTotal,
      price_fetched_at: new Date(),
      wincon_summary: input.wincon_summary,
      general_strategy: input.general_strategy,
      source: input.source,
      ...(input.prompt_id ? { prompt_id: input.prompt_id, constraints: input.constraints ?? null } : {}),
    },
    existingDeck,
    { is_public: input.is_public }
  );
  // Stored stats (price per source, composition, curve) -- manaramp recomputes them the same way a
  // website edit does. Never fails the save.
  await ctx.onDeckSaved?.(pushed.deck_id).catch(() => {});
  if (input.prompt_id) await markPromptBuilt(ctx.writeDb, input.prompt_id, pushed.deck_id);
  return { saved: true, deck_id: pushed.deck_id, deck_url: `https://manaramp.com/decks/${pushed.slug}`, analysis, priceSource };
}

export { saveDecklist };
export type { SaveDeckInput, SaveDeckResult };
