/**
 * tools/edit-deck.ts -- edit_deck (2026-09-27)
 *
 * One-call iteration on a saved deck: remove/add cards by name, and/or `add_search` for the server to
 * pick replacements matching filters (within the deck's colors, legality and stored constraints). The
 * result is re-validated with the same analysis validate_and_submit uses, saved in place, logged as a
 * revision (last 20 kept on the deck), and only the CHANGE comes back -- no decklist retyping, no
 * read-then-rewrite loop. Constraint changes ("keep it under $100") update the deck's stored rules.
 *
 * `commander` swaps the commander in place: the old one leaves, cards outside the new color identity
 * are pulled (and listed), and add_search in the same call refills within the NEW colors. A full
 * rebuild around a new commander goes through deck_plan_guide -> fill_deck_plan instead.
 */
import { z } from "zod";
import { filterShape } from "./shared/filter-shape.js";
import { getDeckDoc } from "../functions/query/decks.js";
import { queryCards, type QueryCardsFilters } from "../functions/query/cards.js";
import { findCandidates, seededShuffle } from "../functions/query/candidates.js";
import { toBriefPlanCard } from "../functions/query/card-view.js";
import { pushDeck } from "../functions/push/deck.js";
import { analyzeDecklist, toDecklistText } from "./shared/deck-analysis.js";
import { FORMAT_RULES } from "../functions/reference/deck-plan-guide-data.js";
import type { DeckPromptConstraints } from "../functions/query/deck-prompts.js";
import type { ToolDefinition } from "./types.js";


const inputSchema = {
  deck_id: z.string().describe("The deck to edit (from read_deck, or a submit's deck_id)."),
  commander: z
    .string()
    .optional()
    .describe("Swap to this commander, keeping the cards that still fit its color identity (off-identity cards are removed and listed). Pair with add_search to refill the gaps."),
  remove: z.array(z.string()).optional().describe("Card names to take out entirely."),
  add: z.array(z.string()).optional().describe("Card names to add (1 each; '3 Mountain' for multiples)."),
  add_search: z
    .array(z.object({ count: z.number().int().min(1).max(30), sort: z.enum(["varied", "cmc", "price"]).optional(), ...filterShape }))
    .optional()
    .describe("Server-picked additions: { count, ...query_cards filters } -- e.g. { count: 3, roles_any: ['removal'], max_price_usd: 5 }. Colors, legality and the deck's stored constraints apply automatically."),
  constraints: z
    .object({ max_price_usd: z.number().nullable().optional(), bracket: z.number().nullable().optional(), restrictions: z.string().nullable().optional() })
    .optional()
    .describe("Update the deck's stored rules when the user changes one."),
  request: z.string().optional().describe("The user's ask, in a few words -- logged with the revision."),
  deck_name: z.string().optional(),
  wincon_summary: z.string().optional(),
  general_strategy: z.string().optional(),
  bracket_estimate: z.string().optional().describe("Re-judged Commander bracket, if the edit changed it."),
};

const editDeckTool: ToolDefinition<typeof inputSchema> = {
  name: "edit_deck",
  description:
    "Change a saved deck in ONE call: remove/add cards by name and/or add_search (server picks cards matching filters, within " +
    "the deck's colors, legality and stored budget/restrictions), and/or swap the commander. Re-validates, saves in place, logs the revision, and returns " +
    "only what changed (added cards with abilities, removed names, new price/curve, consistency issues). Use this for every " +
    "iteration -- no need to read the deck and resubmit the whole list.",
  inputSchema,
  handler: async (args, ctx) => {
    const text = (body: unknown) => ({ content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body) }] });
    const priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";
    const preferredPrinting = (await ctx.getPreferredPrintingPreference?.()) ?? "most_recent";

    const deck = await getDeckDoc(ctx.writeDb, { deck_id: args.deck_id });
    if (!deck) return text(`No deck with deck_id '${args.deck_id}'.`);
    if (deck.owner_user_id !== ctx.ownerUserId) return text("That deck isn't owned by this account.");
    const rules = FORMAT_RULES[deck.format] ?? FORMAT_RULES.commander;

    // Current contents, by name.
    const commanderIds = deck.commander?.oracle_ids ?? [];
    const allIds = [...new Set([...commanderIds, ...deck.cards])];
    const current = await queryCards(ctx.readDb, { oracle_ids: allIds }, priceSource, preferredPrinting);
    const nameById = new Map(current.map((c) => [c.oracle_id, c.name]));
    let commanderNames = commanderIds.map((id) => nameById.get(id)).filter((n): n is string => !!n);
    const entries = new Map<string, { name: string; qty: number }>();
    for (const id of deck.cards) {
      const name = nameById.get(id);
      if (!name) continue;
      const k = name.toLowerCase();
      entries.set(k, { name, qty: (entries.get(k)?.qty ?? 0) + 1 });
    }

    const removed: string[] = [];
    const notes: string[] = [];

    // Commander swap: resolve, check it can lead a deck, drop it from the 99 if it was there.
    let newIdentity: string[] | null = null;
    let offIdentity: string[] = [];
    if (args.commander) {
      if (!rules.commander) return text(`${deck.format} has no commander.`);
      const cmd = (await queryCards(ctx.readDb, { names: [args.commander] }, priceSource, preferredPrinting))[0];
      if (!cmd) return text(`Commander '${args.commander}' wasn't found -- check the exact name.`);
      const canLead = /legendary.*creature/i.test(cmd.type_line) || /can be your commander/i.test(cmd.oracle_text ?? "");
      if (!canLead) return text(`${cmd.name} can't be a commander (not a legendary creature and no "can be your commander").`);
      if (!commanderNames.includes(cmd.name)) {
        removed.push(...commanderNames.map((n) => `${n} (was commander)`));
        commanderNames = [cmd.name];
        entries.delete(cmd.name.toLowerCase());
        newIdentity = cmd.color_identity;
        const allowed = new Set(newIdentity);
        for (const c of current) {
          if (commanderIds.includes(c.oracle_id)) continue;
          const k = c.name.toLowerCase();
          if (entries.has(k) && !c.color_identity.every((x) => allowed.has(x))) {
            entries.delete(k);
            offIdentity.push(c.name);
          }
        }
        removed.push(...offIdentity);
      }
    }
    for (const n of args.remove ?? []) {
      const hit = entries.get(n.toLowerCase());
      if (hit) { entries.delete(n.toLowerCase()); removed.push(hit.name); } else notes.push(`'${n}' isn't in the deck`);
    }
    const added: string[] = [];
    for (const raw of args.add ?? []) {
      const m = raw.match(/^(\d+)\s+(.+)$/);
      const qty = m ? Number(m[1]) : 1;
      const name = (m ? m[2] : raw).trim();
      const k = name.toLowerCase();
      entries.set(k, { name: entries.get(k)?.name ?? name, qty: (entries.get(k)?.qty ?? 0) + qty });
      added.push(name);
    }

    // Stored rules: the deck's own constraints (AI-built decks), updated by this call if asked.
    const stored: DeckPromptConstraints = {
      colors: newIdentity ?? deck.commander?.color_identity ?? deck.constraints?.colors ?? [],
      max_price_usd: deck.constraints?.max_price_usd ?? null,
      bracket: deck.constraints?.bracket ?? null,
      restrictions: deck.constraints?.restrictions ?? null,
      build_style: deck.constraints?.build_style ?? "original",
      use_synergies: deck.constraints?.use_synergies ?? false,
      use_combos: deck.constraints?.use_combos ?? false,
    };
    const constraints: DeckPromptConstraints = {
      ...stored,
      ...(args.constraints?.max_price_usd !== undefined ? { max_price_usd: args.constraints.max_price_usd } : {}),
      ...(args.constraints?.bracket !== undefined ? { bracket: args.constraints.bracket } : {}),
      ...(args.constraints?.restrictions !== undefined ? { restrictions: args.constraints.restrictions } : {}),
    };

    // Server-picked additions.
    if (args.add_search?.length) {
      const inDeckIds = new Set(allIds);
      const perCardCap = constraints.max_price_usd ? Math.max(1, constraints.max_price_usd * 0.1) : undefined;
      const lists = await Promise.all(
        args.add_search.map(({ count, sort: _s, ...f }) => {
          const caps = [f.max_price_usd, perCardCap].filter((x): x is number => x != null);
          const filters: QueryCardsFilters = {
            ...f,
            color_identity_subset_of: constraints.colors.length ? constraints.colors : undefined,
            legal_in: rules.legality_key,
            max_price_usd: caps.length ? Math.min(...caps) : undefined,
            exclude_oracle_ids: [...inDeckIds],
          };
          return findCandidates(ctx.readDb, filters, Math.min(60, count * 4 + 10), priceSource);
        })
      );
      const seed = `${deck._id}:${deck.revisions?.length ?? 0}`;
      args.add_search.forEach((s, i) => {
        let list = lists[i].filter((c) => !entries.has(c.name.toLowerCase()));
        if (s.sort === "cmc") list.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99));
        else if (s.sort === "price") list.sort((a, b) => (a.price_usd ?? 1e9) - (b.price_usd ?? 1e9));
        else list = seededShuffle(list, seed + i);
        const picks = list.slice(0, s.count);
        if (picks.length < s.count) notes.push(`add_search #${i + 1}: only ${picks.length} of ${s.count} matching cards found`);
        for (const p of picks) { entries.set(p.name.toLowerCase(), { name: p.name, qty: 1 }); added.push(p.name); }
      });
    }

    if (offIdentity.length && !args.add_search?.length) {
      notes.push(`Swapping commanders removed ${offIdentity.length} off-color card(s) -- the deck is short until you add replacements (add_search).`);
    }

    if (!added.length && !removed.length && !args.constraints && !args.deck_name && !args.wincon_summary && !args.general_strategy) {
      return text({ note: "Nothing to change.", notes: notes.length ? notes : undefined });
    }

    let analysis;
    try {
      analysis = await analyzeDecklist(ctx.readDb, toDecklistText(commanderNames, [...entries.values()]), priceSource);
    } catch (e: any) {
      return text(e.message);
    }
    const { consistency, facts, priceTotal, totalCards, deckEntries } = analysis;
    const cmdIds = commanderNames.map((n) => consistency.card_details.get(n)?.oracle_id).filter((id): id is string => !!id);
    const cardIds = deckEntries
      .filter((e) => !commanderNames.includes(e.name))
      .flatMap((e) => {
        const id = consistency.card_details.get(e.name)?.oracle_id;
        return id ? Array(e.qty).fill(id) : [];
      });

    const pushed = await pushDeck(
      ctx.writeDb,
      ctx.ownerUserId,
      {
        name: args.deck_name ?? deck.name,
        format: deck.format,
        cards: cardIds,
        sideboard: deck.sideboard,
        size_summary: { main: cardIds.length, sideboard: deck.sideboard?.length ?? 0, commander: cmdIds.length, total: totalCards },
        commander: cmdIds.length ? { oracle_ids: cmdIds, color_identity: consistency.commander_color_identity } : deck.commander,
        bracket: args.bracket_estimate
          ? { estimate: args.bracket_estimate, combos_found: facts.combos_found.map((c) => ({ pieces: c.pieces, speed: c.speed })) }
          : deck.bracket,
        mana_curve: consistency.mana_curve,
        curve_out_probability: consistency.curve_out_probability,
        consistency_issues: consistency.issues,
        price_usd: priceTotal,
        price_fetched_at: new Date(),
        wincon_summary: args.wincon_summary ?? deck.wincon_summary,
        general_strategy: args.general_strategy ?? deck.general_strategy,
        source: deck.source ?? "edit_deck",
        prompt_id: deck.prompt_id ?? null,
        constraints,
      },
      deck
    );
    await ctx.writeDb.collection<{ _id: string }>("decks").updateOne(
      { _id: deck._id },
      { $push: { revisions: { $each: [{ at: new Date(), request: args.request ?? null, added, removed }], $slice: -20 } } } as never
    );
    // Stored deck stats (price/composition/curve), same recompute as a website edit -- see McpContext.onDeckSaved.
    await ctx.onDeckSaved?.(deck._id).catch(() => {});

    const addedDetail = added.length ? await queryCards(ctx.readDb, { names: [...new Set(added)] }, priceSource, preferredPrinting) : [];
    return text({
      deck_url: `https://manaramp.com/decks/${pushed.slug}`,
      commander: newIdentity ? commanderNames[0] : undefined,
      // Brief views (2026-09-28): name/type/roles/price, no card text -- the reply only needs what changed.
      added: addedDetail.map((c) => {
        const { name, type_line, cmc, roles, price_usd } = toBriefPlanCard(c) as Record<string, unknown>;
        return { name, type_line, cmc, roles, price_usd };
      }),
      removed,
      total_cards: totalCards,
      price_usd: priceTotal,
      over_budget: constraints.max_price_usd && priceTotal > constraints.max_price_usd ? `$${priceTotal} is over the $${constraints.max_price_usd} budget` : undefined,
      mana_curve: consistency.mana_curve,
      consistency_issues: consistency.issues.length ? consistency.issues : undefined,
      not_found: consistency.not_found.length ? consistency.not_found : undefined,
      notes: notes.length ? notes : undefined,
      next: "Reply in a few lines: what changed and the new price. Link the deck.",
    });
  },
};

export { editDeckTool };
