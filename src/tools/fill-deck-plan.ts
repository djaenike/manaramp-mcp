/**
 * tools/fill-deck-plan.ts -- fill_deck_plan (2026-09-27)
 *
 * The one "find the cards" call in the new deck flow: deck_plan_guide -> the model writes ONE plan
 * -> fill_deck_plan fills every slot -> the model reviews and calls validate_and_submit once with
 * { draft_id, swaps }. The model decides WHAT the deck needs (slots, counts, filters); the server does
 * retrieval: every slot's candidates in parallel with the deck's colors/legality/exclusions/budget cap
 * applied, dedupe top-down (earlier slots claim cards first), then full card detail for the picks
 * only. The filled list is stored as a draft so it's never retyped.
 *
 * Shortfalls are reported, never padded -- if only 9 cards match a 14-card slot, the model sees that
 * and fixes it from the alternates at submit.
 */
import { z } from "zod";
import { queryCards, type QueryCardsFilters, type CardSummary } from "../functions/query/cards.js";
import { findCandidates, seededShuffle, type Candidate } from "../functions/query/candidates.js";
import { toPlanCard, toBriefPlanCard } from "../functions/query/card-view.js";
import { getDeckPrompt, constraintsOf, createChatDeckPrompt, type DeckPromptConstraints } from "../functions/query/deck-prompts.js";
import { saveDraft, type DraftSlot } from "../functions/push/deck-drafts.js";
import { querySynergies } from "../functions/query/synergies.js";
import { FORMAT_RULES } from "../functions/reference/deck-plan-guide-data.js";
import type { ToolDefinition } from "./types.js";

// Filters a slot (or an exclude entry) can use -- the query_cards vocabulary, minus batch lookups.
const filterShape = {
  roles_any: z.array(z.string()).optional(),
  effect_in: z.array(z.string()).optional(),
  effects_all: z.array(z.string()).optional(),
  trigger_kind: z.enum(["cast", "activate", "triggered", "static", "replacement"]).optional(),
  trigger_event: z.string().optional().describe("etb, dies, leaves_battlefield, attacks, blocks, cast_spell, deals_damage, draws, discards, sacrificed, token_created, counter_added, life_gained, life_lost, upkeep, end_step, combat"),
  trigger_watches: z.object({ type: z.string().optional(), modifier: z.string().optional() }).optional().describe("What the trigger watches, e.g. { type: 'Creature', modifier: 'YouCtrl' } = creatures you control"),
  effect_param_contains: z.object({ key: z.string(), value_contains: z.string() }).optional(),
  cost_contains: z.object({ kind: z.string(), arg: z.string().optional() }).optional().describe("Ability cost includes this, e.g. { kind: 'Sac', arg: 'Creature' } = sacrifice-a-creature outlets"),
  type_line_contains: z.string().optional(),
  name_contains: z.string().optional(),
  oracle_text_contains: z.string().optional(),
  category: z.string().optional(),
  colors_include: z.array(z.string()).optional(),
  cmc_min: z.number().optional(),
  cmc_max: z.number().optional(),
  max_price_usd: z.number().optional(),
};

const inputSchema = {
  prompt_id: z.string().optional().describe("Manaramp deck prompt id (from the user's pasted prompt) -- commander and constraints are read from it."),
  format: z.string().optional().describe("Default 'commander' (or the prompt's format)."),
  commander: z.string().optional().describe("Exact commander name. Omit when the prompt already has one."),
  deck_name: z.string().optional(),
  constraints: z
    .object({
      colors: z.array(z.string()).optional(),
      max_price_usd: z.number().optional(),
      bracket: z.number().optional(),
      restrictions: z.string().optional(),
      build_style: z.enum(["original", "community"]).optional(),
      use_synergies: z.boolean().optional(),
      use_combos: z.boolean().optional(),
    })
    .optional()
    .describe("Only when there's no prompt_id (the user asked in chat) -- saved as a new deck prompt."),
  exclude: z.array(z.object(filterShape)).optional().describe("Deck-wide exclusions: any card matching ANY entry is never picked (e.g. 'no aristocrats')."),
  slots: z
    .array(
      z.object({
        label: z.string(),
        count: z.number().int().min(1).max(99),
        copies: z.number().int().min(1).max(4).optional().describe("60-card formats only: copies per card (default 4). Commander is always singleton."),
        sort: z.enum(["varied", "cmc", "price", "synergy"]).optional(),
        ...filterShape,
      })
    )
    .min(1)
    .max(30)
    .describe("Ordered by priority -- filled top-down, earlier slots claim cards first. See deck_plan_guide for the filter vocabulary."),
  basic_lands: z.record(z.number().int().min(0).max(99)).optional().describe("e.g. { Mountain: 30 }"),
  alternates_per_slot: z.number().int().min(0).max(4).optional(),
};

const BASICS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes", "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);

const fillDeckPlanTool: ToolDefinition<typeof inputSchema> = {
  name: "fill_deck_plan",
  description:
    "Fill a whole deck plan in ONE call (call deck_plan_guide first for the rules, targets and filter vocabulary). " +
    "You send ordered slots ({ label, count, ...query_cards filters, sort }) plus basic_lands; the server applies the deck's " +
    "colors, format legality, exclusions and budget to every slot, picks cards top-down without repeats, and returns each " +
    "slot's picks (with abilities / makes_tokens / roles so synergies are visible) plus alternates, any shortfalls, price, " +
    "curve and role counts, and a draft_id. Then call validate_and_submit ONCE with { draft_id, swaps, submit: true, ... } -- " +
    "never retype the decklist.",
  inputSchema,
  handler: async (args, ctx) => {
    const priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";
    const preferredPrinting = (await ctx.getPreferredPrintingPreference?.()) ?? "most_recent";
    const text = (body: unknown) => ({ content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body) }] });

    // --- constraints: the stored prompt, or inline (saved as a new chat prompt) ---
    let promptId = args.prompt_id ? args.prompt_id.replace(/^#/, "").trim().toLowerCase() : null;
    const prompt = promptId ? await getDeckPrompt(ctx.writeDb, promptId, ctx.ownerUserId) : null;
    if (promptId && !prompt) return text(`No deck prompt '#${promptId}' on this account.`);
    const format = (prompt?.format ?? args.format ?? "commander").toLowerCase();
    const rules = FORMAT_RULES[format];
    if (!rules) return text(`Unknown format '${format}'. Use one of: ${Object.keys(FORMAT_RULES).join(", ")}.`);
    const constraints: DeckPromptConstraints = prompt
      ? constraintsOf(prompt)
      : {
          colors: args.constraints?.colors ?? [],
          max_price_usd: args.constraints?.max_price_usd ?? null,
          bracket: args.constraints?.bracket ?? null,
          restrictions: args.constraints?.restrictions ?? null,
          build_style: args.constraints?.build_style ?? "original",
          use_synergies: !!args.constraints?.use_synergies,
          use_combos: !!args.constraints?.use_combos,
        };

    // --- commander ---
    const commanderName = prompt?.commander?.name ?? args.commander ?? null;
    let commander: CardSummary | null = null;
    if (rules.commander) {
      if (!commanderName) return text("This format needs a commander -- pass `commander` (or ask the user / suggest one first).");
      commander = (await queryCards(ctx.readDb, { names: [commanderName] }, priceSource, preferredPrinting))[0] ?? null;
      if (!commander) return text(`Commander '${commanderName}' wasn't found -- check the exact name with query_cards.`);
    }
    const colors = commander ? commander.color_identity : constraints.colors;
    if (!prompt) {
      promptId = await createChatDeckPrompt(ctx.writeDb, ctx.ownerUserId, {
        format,
        name: args.deck_name ?? null,
        commander: commander ? { oracle_id: commander.oracle_id, name: commander.name, color_identity: commander.color_identity } : null,
        constraints: { ...constraints, colors },
      });
    }

    // --- per-slot candidates, in parallel ---
    const singleton = !!rules.commander;
    const alternates = args.alternates_per_slot ?? 2;
    const budget = constraints.max_price_usd;
    // Per-card price cap from the budget spread over the deck's non-basic slots (x3 headroom so a
    // few key cards can cost more than average); a slot's own max_price_usd can go lower.
    const spellSlots = args.slots.reduce((n, sl) => n + sl.count, 0);
    const perCardCap = budget ? Math.max(0.5, Math.round((budget / Math.max(1, spellSlots)) * 3 * 100) / 100) : undefined;
    const synergyRank = new Map<string, number>();
    if (constraints.build_style === "community" && constraints.use_synergies && commanderName) {
      try {
        const syn = await querySynergies(ctx.readDb, commanderName);
        for (const r of syn.recommended_cards) synergyRank.set(r.name.toLowerCase(), r.inclusion_pct ?? 0);
      } catch {
        // No synergy data for this commander -- 'synergy' sorts fall back to 'varied'.
      }
    }
    const seed = `${promptId}:${commanderName ?? ""}`;
    const excludeIds = commander ? [commander.oracle_id] : [];

    const candidateLists = await Promise.all(
      args.slots.map((slot) => {
        const { label: _l, count, copies, sort: _s, ...slotFilters } = slot;
        const distinct = singleton ? count : Math.ceil(count / (copies ?? 4));
        const maxPrice = [slotFilters.max_price_usd, perCardCap].filter((x): x is number => x != null);
        const filters: QueryCardsFilters = {
          ...slotFilters,
          color_identity_subset_of: colors.length ? colors : undefined,
          legal_in: rules.legality_key,
          max_price_usd: maxPrice.length ? Math.min(...maxPrice) : undefined,
          nor: args.exclude?.length ? args.exclude : undefined,
          exclude_oracle_ids: excludeIds,
        };
        // Enough headroom for cross-slot overlap and alternates, capped so no slot pulls hundreds.
        return findCandidates(ctx.readDb, filters, Math.min(90, distinct * 4 + alternates + 10), priceSource);
      })
    );

    // --- dedupe top-down: picks first for every slot, then alternates from what's left, so an
    // alternate is never a card another slot ended up picking (and never repeats across slots) ---
    const used = new Set<string>(excludeIds);
    const slots: DraftSlot[] = [];
    const warnings: string[] = [];
    const remainder: Candidate[][] = [];
    args.slots.forEach((slot, i) => {
      const copies = singleton ? 1 : (slot.copies ?? 4);
      const distinct = singleton ? slot.count : Math.ceil(slot.count / copies);
      const sort = slot.sort ?? (synergyRank.size ? "synergy" : "varied");
      let list: Candidate[] = candidateLists[i].filter((c) => !used.has(c._id) && !BASICS.has(c.name.toLowerCase()));
      if (sort === "cmc") list.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || a.name.localeCompare(b.name));
      else if (sort === "price") list.sort((a, b) => (a.price_usd ?? 1e9) - (b.price_usd ?? 1e9));
      else if (sort === "synergy" && synergyRank.size) {
        list = seededShuffle(list, seed + slot.label).sort((a, b) => (synergyRank.get(b.name.toLowerCase()) ?? -1) - (synergyRank.get(a.name.toLowerCase()) ?? -1));
      } else list = seededShuffle(list, seed + slot.label);

      const picks = list.slice(0, distinct);
      picks.forEach((c) => used.add(c._id));
      remainder.push(list.slice(distinct));
      let remaining = slot.count;
      slots.push({
        label: slot.label,
        requested: slot.count,
        picks: picks.map((c) => {
          const qty = Math.min(copies, remaining);
          remaining -= qty;
          return { oracle_id: c._id, name: c.name, qty };
        }),
        alternates: [],
      });
      if (picks.length < distinct) warnings.push(`'${slot.label}': only ${picks.length} of ${distinct} cards match -- widen the filters or fill from other slots' alternates at submit.`);
    });

    slots.forEach((slot, i) => {
      for (const c of remainder[i]) {
        if (slot.alternates.length >= alternates) break;
        if (used.has(c._id)) continue;
        used.add(c._id);
        slot.alternates.push({ oracle_id: c._id, name: c.name });
      }
    });

    // --- basics ---
    const basicNames = Object.entries(args.basic_lands ?? {}).filter(([, n]) => n > 0);
    const basicDocs = basicNames.length ? await queryCards(ctx.readDb, { names: basicNames.map(([n]) => n) }, priceSource, preferredPrinting) : [];
    const basics = basicNames.flatMap(([name, qty]) => {
      const doc = basicDocs.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (!doc) warnings.push(`Basic land '${name}' not found.`);
      return doc ? [{ oracle_id: doc.oracle_id, name: doc.name, qty }] : [];
    });

    // --- full detail for picks + alternates only ---
    const detailIds = [...new Set(slots.flatMap((s) => [...s.picks.map((p) => p.oracle_id), ...s.alternates.map((a) => a.oracle_id)]))];
    const details = detailIds.length ? await queryCards(ctx.readDb, { oracle_ids: detailIds }, priceSource, preferredPrinting) : [];
    const byId = new Map(details.map((d) => [d.oracle_id, d]));

    let price = commander?.price_usd ?? 0;
    const curve: Record<string, number> = {};
    const roleCounts: Record<string, number> = {};
    for (const s of slots) {
      for (const p of s.picks) {
        const d = byId.get(p.oracle_id);
        if (!d) continue;
        price += (d.price_usd ?? 0) * p.qty;
        if (!/\bLand\b/.test(d.type_line)) {
          const b = d.cmc == null ? "?" : d.cmc >= 7 ? "7+" : String(d.cmc);
          curve[b] = (curve[b] ?? 0) + p.qty;
        }
        for (const r of d.roles) roleCounts[r] = (roleCounts[r] ?? 0) + p.qty;
      }
    }
    for (const b of basics) price += (basicDocs.find((d) => d.oracle_id === b.oracle_id)?.price_usd ?? 0) * b.qty;
    price = Math.round(price * 100) / 100;

    const totalCards = (commander ? 1 : 0) + slots.reduce((n, s) => n + s.picks.reduce((m, p) => m + p.qty, 0), 0) + basics.reduce((n, b) => n + b.qty, 0);
    if (rules.commander && totalCards !== 100) warnings.push(`Deck has ${totalCards} cards; Commander needs exactly 100 -- adjust with swaps at submit.`);
    if (budget && price > budget) warnings.push(`Estimated $${price} is over the $${budget} budget -- swap pricier picks for alternates.`);

    const draftId = await saveDraft(ctx.writeDb, {
      owner_user_id: ctx.ownerUserId,
      prompt_id: promptId,
      format,
      deck_name: args.deck_name ?? prompt?.name ?? null,
      commander: commander ? { oracle_id: commander.oracle_id, name: commander.name, color_identity: commander.color_identity } : null,
      constraints: { ...constraints, colors },
      slots,
      basics,
    });

    return text({
      draft_id: draftId,
      prompt_id: promptId,
      format,
      commander: commander ? toPlanCard(commander, "commander") : null,
      total_cards: totalCards,
      price_usd: price,
      budget_usd: budget ?? undefined,
      curve,
      role_counts: roleCounts,
      warnings: warnings.length ? warnings : undefined,
      slots: slots.map((s) => ({
        label: s.label,
        filled: s.picks.reduce((n, p) => n + p.qty, 0),
        requested: s.requested,
        picks: s.picks.map((p) => {
          const d = byId.get(p.oracle_id);
          const view = d ? (/\bLand\b/.test(d.type_line) ? toBriefPlanCard(d) : toPlanCard(d)) : { name: p.name };
          return p.qty > 1 ? { ...view, qty: p.qty } : view;
        }),
        alternates: s.alternates.map((a) => {
          const d = byId.get(a.oracle_id);
          return d ? toBriefPlanCard(d) : { name: a.name };
        }),
      })),
      basic_lands: Object.fromEntries(basics.map((b) => [b.name, b.qty])),
      next: "Review, then validate_and_submit({ draft_id, swaps: [{ out, in }], submit: true, deck_name, wincon_summary, general_strategy, bracket_estimate }).",
    });
  },
};

export { fillDeckPlanTool };
