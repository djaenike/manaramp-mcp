import { getDeckDoc } from "../../functions/query/decks.js";
import { pushDeck } from "../../functions/push/deck.js";
import { getDeckPrompt, markPromptBuilt, promptDeckId } from "../../functions/query/deck-prompts.js";
import { analyzeDecklist } from "./deck-analysis.js";
async function saveDecklist(ctx, input) {
  const priceSource = await ctx.getPriceSourcePreference?.() ?? "cardkingdom";
  const deckId = input.deck_id ?? (input.prompt_id ? await promptDeckId(ctx.writeDb, await getDeckPrompt(ctx.writeDb, input.prompt_id, ctx.ownerUserId), ctx.ownerUserId) : null);
  let existingDeck = null;
  if (deckId) {
    existingDeck = await getDeckDoc(ctx.writeDb, { deck_id: deckId });
    if (!existingDeck) return { saved: false, error: `No deck found with deck_id '${deckId}'.`, priceSource };
    if (existingDeck.owner_user_id !== ctx.ownerUserId) return { saved: false, error: `deck_id '${deckId}' isn't owned by this account.`, priceSource };
  }
  let analysis;
  try {
    analysis = await analyzeDecklist(ctx.readDb, input.decklist_text, priceSource);
  } catch (e) {
    return { saved: false, error: e.message, priceSource };
  }
  const { commanderNames, deckEntries, consistency, facts, priceTotal, totalCards } = analysis;
  if (input.requireClean && (consistency.issues.length || consistency.not_found.length)) return { saved: false, analysis, priceSource };
  const commanderOracleIds = commanderNames.map((n) => consistency.card_details.get(n)?.oracle_id).filter((id) => Boolean(id));
  const cardOracleIds = deckEntries.filter((e) => !commanderNames.includes(e.name)).flatMap((e) => {
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
      price_fetched_at: /* @__PURE__ */ new Date(),
      wincon_summary: input.wincon_summary,
      general_strategy: input.general_strategy,
      source: input.source,
      ...input.prompt_id ? { prompt_id: input.prompt_id, constraints: input.constraints ?? null } : {}
    },
    existingDeck,
    { is_public: input.is_public }
  );
  await ctx.onDeckSaved?.(pushed.deck_id).catch(() => {
  });
  if (input.prompt_id) await markPromptBuilt(ctx.writeDb, input.prompt_id, pushed.deck_id);
  return { saved: true, deck_id: pushed.deck_id, deck_url: `https://manaramp.com/decks/${pushed.slug}`, analysis, priceSource };
}
export {
  saveDecklist
};
