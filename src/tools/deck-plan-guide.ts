/**
 * tools/deck-plan-guide.ts -- deck_plan_guide (2026-09-27)
 *
 * Entry point for BOTH new decks and edits, called once per session before fill_deck_plan /
 * edit_deck. Returns, in one response, everything needed to act precisely:
 *   - the user's constraints: from a Manaramp deck prompt (prompt_id), an existing deck (deck_id), or
 *     what they said in chat (colors / max_price_usd) -- plus what's still `missing`;
 *   - the commander: analyzed (abilities + what it `rewards`) when known, or `commander_candidates`
 *     when none is set -- including when the model passes commander: null to change commanders.
 *     Candidates are a fresh random draw every call, so asking again gives new options;
 *   - format rules, composition targets, bracket criteria, archetype patterns, budget words;
 *   - the filter vocabulary: roles, real effect names (with card counts, from manaramp's ingest --
 *     never hand-written) and meanings, triggers, params, idea -> filter examples;
 *   - the returned-card schema, the plan schema with an example, and step-by-step instructions.
 *
 * Supersedes format_guidelines for building (that tool stays for bracket lookups).
 */
import { z } from "zod";
import { getDeckPrompt, constraintsOf, promptDeckId, promptNotFoundMessage } from "../functions/query/deck-prompts.js";
import { getDeckDoc } from "../functions/query/decks.js";
import { queryCards, type CardSummary } from "../functions/query/cards.js";
import { findCandidates } from "../functions/query/candidates.js";
import { toPlanCard, commanderRewards } from "../functions/query/card-view.js";
import { COMMANDER_BRACKETS } from "../functions/reference/format-guidelines-data.js";
import {
  FORMAT_RULES,
  COMPOSITION_TARGETS,
  ROLES,
  EFFECT_MEANINGS,
  TRIGGERS,
  PARAM_KEYS,
  CARD_SCHEMA,
  PLAN_SCHEMA,
  PLAN_EXAMPLE,
  IDEA_EXAMPLES,
  INSTRUCTIONS,
  ARCHETYPES,
  BUDGET_WORDS,
} from "../functions/reference/deck-plan-guide-data.js";
import { resolveTargets } from "../functions/reference/deck-targets.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  prompt_id: z.string().optional().describe("Manaramp deck prompt id if the user pasted one (e.g. 'k7f2q9')."),
  deck_id: z.string().optional().describe("Editing an existing deck: its id. Returns the deck's commander, stored constraints and edit instructions."),
  commander: z
    .string()
    .nullable()
    .optional()
    .describe("A commander name to analyze, or null to get commander_candidates instead (e.g. the user wants a different commander). Omit to use the prompt's/deck's own."),
  format: z.string().optional().describe("Without a prompt/deck: 'commander' (default), 'standard', 'modern', ..."),
  colors: z.array(z.string()).optional().describe("Without a prompt/deck: WUBRG letters the user asked for (drives commander_candidates)."),
  max_price_usd: z.number().optional().describe("Without a prompt/deck: the budget you're planning with."),
  all_effects: z.boolean().optional().describe("Include every effect name (~200+), not just the common ones. Rarely needed."),
  detail: z.enum(["compact", "full"]).optional().describe("Default compact. 'full' adds the card schema, param keys, trigger modes and effect card counts -- only if you're writing unusual filters."),
};

interface VocabDoc {
  _id: string;
  effects: Array<{ name: string; cards: number }>;
  trigger_modes: Array<{ name: string; cards: number }>;
}

const CANDIDATE_COUNT = 10;

const deckPlanGuideTool: ToolDefinition<typeof inputSchema> = {
  name: "deck_plan_guide",
  description:
    "START HERE for any deck build or rebuild -- call once. Pass prompt_id (a pasted Manaramp prompt), deck_id, or colors/" +
    "max_price_usd (asked in chat). Returns constraints, the deck's targets, the commander analyzed (what it rewards) or " +
    "commander_candidates (commander: null reshuffles), archetype patterns, the filter vocabulary and the fill_deck_plan plan " +
    "shape. Then ONE fill_deck_plan call builds and saves the deck. Small edits: edit_deck directly.",
  inputSchema,
  handler: async (args, ctx) => {
    const text = (body: unknown) => ({ content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body) }] });
    const priceSource = (await ctx.getPriceSourcePreference?.()) ?? "cardkingdom";
    const preferredPrinting = (await ctx.getPreferredPrintingPreference?.()) ?? "most_recent";

    // --- context: prompt, existing deck, or chat ---
    const prompt = args.prompt_id ? await getDeckPrompt(ctx.writeDb, args.prompt_id, ctx.ownerUserId) : null;
    if (args.prompt_id && !prompt) return text(await promptNotFoundMessage(ctx.writeDb, args.prompt_id, ctx.ownerUserId, (await ctx.getAccountLabel?.()) ?? null));
    // A prompt's deck that's since been deleted (cleaned-up placeholder) is just a new build.
    const deckIdArg = args.deck_id ?? (await promptDeckId(ctx.writeDb, prompt, ctx.ownerUserId));
    const deck = deckIdArg ? await getDeckDoc(ctx.writeDb, { deck_id: deckIdArg }) : null;
    if (deckIdArg && (!deck || deck.owner_user_id !== ctx.ownerUserId)) return text(`No deck '${deckIdArg}' on this account.`);

    const format = (prompt?.format ?? deck?.format ?? args.format ?? "commander").toLowerCase();
    const rules = FORMAT_RULES[format];
    if (!rules) return text(`Unknown format '${format}'. Known: ${Object.keys(FORMAT_RULES).join(", ")}.`);

    const constraints = prompt
      ? constraintsOf(prompt)
      : deck?.constraints
        ? deck.constraints
        : {
            colors: args.colors ?? deck?.commander?.color_identity ?? [],
            max_price_usd: args.max_price_usd ?? null,
            bracket: null,
            restrictions: null,
            build_style: "original" as const,
            use_synergies: false,
            use_combos: false,
          };

    // --- commander: explicit arg > prompt > deck; null = suggest ---
    let commanderName: string | null = null;
    if (args.commander !== undefined) commanderName = args.commander;
    else if (prompt?.commander) commanderName = prompt.commander.name;
    else if (deck?.commander?.oracle_ids?.[0]) {
      commanderName = (await queryCards(ctx.readDb, { oracle_ids: [deck.commander.oracle_ids[0]] }, priceSource, preferredPrinting))[0]?.name ?? null;
    }

    let commander: CardSummary | null = null;
    if (rules.commander && commanderName) {
      commander = (await queryCards(ctx.readDb, { names: [commanderName] }, priceSource, preferredPrinting))[0] ?? null;
      if (!commander) return text(`Commander '${commanderName}' wasn't found -- check the exact name, or pass commander: null for suggestions.`);
    }

    // Candidates whenever a commander format has none set: a fresh random draw of Commander-legal
    // legends in exactly the requested colors (falling back to within them), cheap enough for the budget.
    let candidates: Array<Record<string, unknown>> | undefined;
    if (rules.commander && !commander) {
      const colors = args.colors ?? constraints.colors ?? [];
      const budget = args.max_price_usd ?? constraints.max_price_usd;
      const cap = budget ? Math.max(2, Math.min(budget * 0.2, 40)) : 40;
      const base = { type_line_contains: "Legendary Creature", legal_in: "commander", max_price_usd: cap };
      let chosen = await findCandidates(ctx.readDb, { ...base, color_identity_exact: colors.length ? colors : undefined }, CANDIDATE_COUNT, priceSource, { sample: true });
      // Too few exact matches (rare color combos under a tight budget): top up from within the colors.
      if (colors.length && chosen.length < CANDIDATE_COUNT) {
        const more = await findCandidates(
          ctx.readDb,
          { ...base, color_identity_subset_of: colors, exclude_oracle_ids: chosen.map((c) => c._id) },
          CANDIDATE_COUNT - chosen.length,
          priceSource,
          { sample: true }
        );
        chosen = [...chosen, ...more];
      }
      const details = chosen.length ? await queryCards(ctx.readDb, { oracle_ids: chosen.map((c) => c._id) }, priceSource, preferredPrinting) : [];
      // Short view -- ten full cards were the guide's single biggest section.
      candidates = details.map((d) => ({
        name: d.name,
        color_identity: d.color_identity.join("") || "C",
        cmc: d.cmc ?? undefined,
        price_usd: d.price_usd ?? undefined,
        rewards: commanderRewards(d),
        text: (d.oracle_text ?? "").replace(/\s+/g, " ").slice(0, 180),
      }));
    }

    // --- what's still unknown ---
    const missing: string[] = [];
    if (!prompt && !deck) {
      if (rules.commander && !commander) missing.push("commander -- pick from commander_candidates (or ask if the user seems to have one in mind)");
      if (args.max_price_usd == null) missing.push("budget -- see budget_words; assume and state it if the user said 'just build it'");
      if (format === "commander") missing.push("bracket 1-5 (or no preference)");
      missing.push("build style if unclear: 'original' (effects-driven) vs 'community' (may use EDHREC synergies/known combos)");
    } else if (rules.commander && !commander) {
      missing.push("commander -- pick from commander_candidates and tell the user why");
    }

    // --- live effect vocabulary ---
    const full = args.detail === "full";
    const vocab = await ctx.readDb.collection<VocabDoc>("effect_vocabulary").findOne({ _id: "current" });
    const effects = (vocab?.effects ?? []).filter((e) => args.all_effects || e.cards >= 25);
    const targets = resolveTargets(format, commander ? commander.color_identity : (constraints.colors ?? []), constraints);
    const bracket = constraints.bracket;

    return text({
      // An empty deck (the website's placeholder for a new prompt, 2026-10-04) is a new build, not a rebuild.
      mode: deck && deck.cards.length > 0 ? (prompt?.deck_id ? "rebuild" : "edit") : "new",
      format,
      rules,
      validate_supported: rules.validate_supported
        ? undefined
        : "Saving is Commander-only for now -- fill_deck_plan returns an unsaved draft for this format; tell the user.",
      prompt: prompt ? { id: prompt._id, deck_name: prompt.name, platform: prompt.platform } : undefined,
      deck: deck
        ? { deck_id: deck._id, name: deck.name, total_cards: deck.size_summary?.total ?? deck.cards.length, price_usd: deck.price_usd, url: `https://manaramp.com/decks/${deck.slug}` }
        : undefined,
      constraints,
      targets,
      commander: commander ? { ...toPlanCard(commander, "commander"), rewards: commanderRewards(commander) } : null,
      commander_candidates: candidates,
      missing,
      brackets:
        format === "commander"
          ? bracket
            ? COMMANDER_BRACKETS.filter((b) => b.level === bracket).map((b) => ({ level: b.level, name: b.name, rules: b.deck_building }))
            : COMMANDER_BRACKETS.map((b) => `${b.level} ${b.name}`)
          : undefined,
      archetypes: ARCHETYPES,
      budget_words: BUDGET_WORDS,
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.meaning])),
      effects: full
        ? effects.map((e) => (EFFECT_MEANINGS[e.name] ? { name: e.name, cards: e.cards, means: EFFECT_MEANINGS[e.name] } : { name: e.name, cards: e.cards }))
        : { names: effects.map((e) => e.name).join(", ") || Object.keys(EFFECT_MEANINGS).join(", "), key_meanings: EFFECT_MEANINGS, note: "Case-sensitive." },
      triggers: full ? { ...TRIGGERS, modes: vocab?.trigger_modes?.filter((m) => m.cards >= 50).map((m) => m.name) } : TRIGGERS.trigger_event_filter,
      param_keys: full ? PARAM_KEYS : undefined,
      idea_examples: IDEA_EXAMPLES,
      card_schema: full ? CARD_SCHEMA : undefined,
      plan_schema: PLAN_SCHEMA,
      plan_example: PLAN_EXAMPLE,
      instructions: INSTRUCTIONS,
    });
  },
};

export { deckPlanGuideTool };
