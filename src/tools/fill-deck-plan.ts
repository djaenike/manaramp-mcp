/**
 * tools/fill-deck-plan.ts -- fill_deck_plan (2026-09-27, standard core + direct save 2026-09-28)
 *
 * The one "build the deck" call: deck_plan_guide -> the model writes the THEME slots only ->
 * fill_deck_plan builds the whole deck and saves it. Two round trips, and the model's output is a
 * few theme slots instead of a full 100-card plan.
 *
 *   1. Theme slots (the model's): filled top-down, earlier slots claim cards first.
 *   2. Standard core (server): counts what the theme picks already do, then fills each role to its
 *      target -- ramp, draw, removal, wipes, counters, protection, recursion... -- from the deck
 *      prompt's role_targets (the user's Create with AI sliders) or the defaults
 *      (functions/reference/deck-targets.ts).
 *   3. Type gaps: remaining nonland slots go to card types still under target (creatures, instants...),
 *      then to more theme cards.
 *   4. Lands: utility lands, then basics split by the deck's colors, to exactly the deck size.
 *   5. Saved directly (tools/shared/save-deck.ts, same path as validate_and_submit) and a compact
 *      summary returned -- no card text. Only when the list fails validation (or review: true) is it
 *      kept as a draft for validate_and_submit.
 *
 * Every slot gets the deck's colors, format legality, exclusions and budget cap automatically.
 */
import { z } from "zod";
import { filterShape } from "./shared/filter-shape.js";
import { queryCards, type QueryCardsFilters, type CardSummary } from "../functions/query/cards.js";
import { findCandidates, seededShuffle, type Candidate } from "../functions/query/candidates.js";
import { toPlanCard, toBriefPlanCard } from "../functions/query/card-view.js";
import { getDeckPrompt, constraintsOf, createChatDeckPrompt, type DeckPromptConstraints } from "../functions/query/deck-prompts.js";
import { saveDraft, type DraftSlot } from "../functions/push/deck-drafts.js";
import { querySynergies } from "../functions/query/synergies.js";
import { FORMAT_RULES } from "../functions/reference/deck-plan-guide-data.js";
import { resolveTargets, ROLE_GROUPS, ROLE_SLOT_HINTS, TYPE_KEYS } from "../functions/reference/deck-targets.js";
import { GAME_CHANGERS, MASS_LAND_DENIAL_CARDS, EXTRA_TURN_CARDS } from "../functions/reference/bracket-reference-data.js";
import { toDecklistText } from "./shared/deck-analysis.js";
import { saveDecklist } from "./shared/save-deck.js";
import type { ToolDefinition } from "./types.js";


const inputSchema = {
  prompt_id: z.string().optional().describe("Manaramp deck prompt id -- commander, rules and targets are read from it."),
  format: z.string().optional().describe("Default 'commander' (or the prompt's format)."),
  commander: z.string().optional().describe("Exact commander name. Omit when the prompt already has one."),
  deck_id: z.string().optional().describe("Rebuild THIS deck in place (a prompt made with Edit with AI carries it already)."),
  deck_name: z.string().optional(),
  wincon_summary: z.string().optional().describe("How the deck wins -- saved with it."),
  general_strategy: z.string().optional().describe("How to pilot it, one short paragraph -- saved with it."),
  bracket_estimate: z.string().optional().describe("Your Commander bracket judgment, e.g. 'Bracket 2 (Core)'."),
  is_public: z.boolean().optional(),
  constraints: z
    .object({
      colors: z.array(z.string()).optional(),
      max_price_usd: z.number().optional(),
      bracket: z.number().optional(),
      theme: z.string().optional(),
      restrictions: z.string().optional(),
      build_style: z.enum(["original", "community"]).optional(),
      use_synergies: z.boolean().optional(),
      use_combos: z.boolean().optional(),
    })
    .optional()
    .describe("Only when there's no prompt_id (the user asked in chat) -- saved as a new deck prompt."),
  // Loose on purpose: the same filter keys as a slot, without repeating that whole schema here.
  exclude: z.array(z.record(z.string(), z.unknown())).optional().describe("Deck-wide exclusions -- filter sets with the same keys as a slot (e.g. an archetype's exclude list); a card matching any is never picked."),
  slots: z
    .array(
      z.object({
        label: z.string(),
        count: z.number().int().min(1).max(99),
        copies: z.number().int().min(1).max(4).optional().describe("60-card formats: copies per card (default 4)."),
        sort: z.enum(["varied", "cmc", "price", "synergy"]).optional(),
        ...filterShape,
      })
    )
    .max(20)
    .describe("THEME slots only (payoffs, enablers, synergy pieces), highest priority first. The server adds ramp/draw/removal/wipes/types/lands to the targets."),
  auto_core: z.boolean().optional().describe("Default true: server fills the standard core + lands to the targets. false = your slots + basic_lands must be the whole deck."),
  basic_lands: z.record(z.number().int().min(0).max(99)).optional().describe("Only with auto_core: false, e.g. { Mountain: 30 }."),
  review: z.boolean().optional().describe("Default false: build AND save. true: return the full list with card details as a draft to review, then validate_and_submit."),
};

const BASICS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes", "snow-covered plains", "snow-covered island", "snow-covered swamp", "snow-covered mountain", "snow-covered forest"]);
const BASIC_FOR: Record<string, string> = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const isLand = (typeLine: string | null | undefined) => /\bLand\b/.test((typeLine ?? "").split(" // ")[0]);

/** A slot: the model's theme slots, or one the server adds. `nonland` drops lands from its candidates;
 *  `core` slots take the most-reprinted matches in order (staples), theme slots shuffle among them. */
type SlotDef = { label: string; count: number; copies?: number; sort?: "varied" | "cmc" | "price" | "synergy"; nonland?: boolean; core?: boolean } & QueryCardsFilters;

/** Largest-remainder split of `total` across weights (all >= 0). */
function apportion(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0);
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  const out: Record<string, number> = {};
  if (!sum || total <= 0) return out;
  const raw = keys.map((k) => ({ k, v: (weights[k] / sum) * total }));
  let used = 0;
  for (const r of raw) used += out[r.k] = Math.floor(r.v);
  raw.sort((a, b) => (b.v % 1) - (a.v % 1));
  for (let i = 0; used < total && i < raw.length; i++, used++) out[raw[i].k] += 1;
  return out;
}

const fillDeckPlanTool: ToolDefinition<typeof inputSchema> = {
  name: "fill_deck_plan",
  description:
    "Build AND save a whole deck in ONE call (call deck_plan_guide first). Send only the THEME slots ({ label, count, " +
    "...filters }) plus deck_name, wincon_summary, general_strategy, bracket_estimate. The server fills ramp/draw/removal/" +
    "wipes and card types to the deck's targets (counting what theme cards already do), adds lands to exactly the deck " +
    "size, applies colors/legality/budget/exclusions, saves, and returns the link with a compact summary.",
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
          theme: args.constraints?.theme ?? null,
          restrictions: args.constraints?.restrictions ?? null,
          build_style: args.constraints?.build_style ?? "original",
          use_synergies: !!args.constraints?.use_synergies,
          use_combos: !!args.constraints?.use_combos,
        };
    const deckId = args.deck_id ?? prompt?.deck_id ?? null;

    // --- commander ---
    const commanderName = args.commander ?? prompt?.commander?.name ?? null;
    let commander: CardSummary | null = null;
    if (rules.commander) {
      if (!commanderName) return text("This format needs a commander -- pass `commander` (deck_plan_guide lists candidates).");
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

    const autoCore = args.auto_core !== false;
    const targets = resolveTargets(format, colors, constraints);
    const singleton = !!rules.commander;
    const budget = constraints.max_price_usd;
    // Per-card cap from the budget spread over the whole deck (x3 headroom so a few key cards can
    // cost more than average); a slot's own max_price_usd can go lower.
    const perCardCap = budget ? Math.max(0.5, Math.round((budget / targets.deck_size) * 3 * 100) / 100) : undefined;
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
    // Bracket guardrails (2026-09-28): brackets 1-2 allow no Game Changers, mass land denial or extra
    // turns; bracket 3 allows a few Game Changers (the theme may pick them, the core won't) and no MLD.
    const bracket = constraints.bracket;
    const bannedEverywhere = bracket != null && bracket <= 2 ? [...GAME_CHANGERS, ...MASS_LAND_DENIAL_CARDS, ...EXTRA_TURN_CARDS] : bracket === 3 ? [...MASS_LAND_DENIAL_CARDS] : [];
    const bannedInCore = bracket === 3 ? GAME_CHANGERS : [];
    const used = new Set<string>(commander ? [commander.oracle_id] : []);
    const info = new Map<string, Candidate>();
    const slots: DraftSlot[] = [];
    const warnings: string[] = [];
    const themeRemainders: Candidate[][] = [];
    /** slot label -> unpicked candidates, cheapest-swap source for the budget pass. */
    const pools = new Map<string, Candidate[]>();
    const ANY_ROLE = [...new Set(Object.values(ROLE_GROUPS).flat()), "player_damage", "extra_land_drop"];

    // One phase = a batch of slots queried in parallel, then deduped top-down against every earlier pick.
    const runSlots = async (defs: SlotDef[], opts: { keepRemainder?: boolean; alternates?: number } = {}) => {
      const lists = await Promise.all(
        defs.map((slot) => {
          const { label: _l, count, copies, sort: _s, nonland: _n, core, ...slotFilters } = slot;
          const distinct = singleton ? count : Math.ceil(count / (copies ?? 4));
          const banned = core ? [...bannedEverywhere, ...bannedInCore] : bannedEverywhere;
          const caps = [slotFilters.max_price_usd, perCardCap].filter((x): x is number => x != null);
          const filters: QueryCardsFilters = {
            ...slotFilters,
            color_identity_subset_of: colors.length ? colors : undefined,
            legal_in: rules.legality_key,
            max_price_usd: caps.length ? Math.min(...caps) : undefined,
            nor: args.exclude?.length ? (args.exclude as QueryCardsFilters[]) : undefined,
            exclude_oracle_ids: [...used],
            exclude_names: banned.length ? banned : undefined,
          };
          // Theme slots draw a wider pool so the shuffle has room; core takes the top staples.
          return findCandidates(ctx.readDb, filters, Math.min(120, distinct * (core ? 2 : 4) + 12), priceSource, { rankByPrintings: true });
        })
      );
      defs.forEach((slot, i) => {
        const copies = singleton ? 1 : (slot.copies ?? 4);
        const distinct = singleton ? slot.count : Math.ceil(slot.count / copies);
        const sort = slot.core ? "staple" : (slot.sort ?? (synergyRank.size ? "synergy" : "varied"));
        let list = lists[i].filter((c) => !used.has(c._id) && !BASICS.has(c.name.toLowerCase()) && !(slot.nonland && isLand(c.type_line)));
        if (sort === "staple") {
          // already most-reprinted first
        } else if (sort === "cmc") list.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || a.name.localeCompare(b.name));
        else if (sort === "price") list.sort((a, b) => (a.price_usd ?? 1e9) - (b.price_usd ?? 1e9));
        else if (sort === "synergy" && synergyRank.size) {
          list = seededShuffle(list, seed + slot.label).sort((a, b) => (synergyRank.get(b.name.toLowerCase()) ?? -1) - (synergyRank.get(a.name.toLowerCase()) ?? -1));
        } else list = seededShuffle(list, seed + slot.label);
        const picks = list.slice(0, distinct);
        picks.forEach((c) => {
          used.add(c._id);
          info.set(c._id, c);
        });
        if (opts.keepRemainder) themeRemainders.push(list.slice(distinct));
        pools.set(slot.label, list.slice(distinct));
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
        // Core shortfalls are normal (mono-red has little protection) -- the type/flex steps fill in.
        if (picks.length < distinct && !slot.core) warnings.push(`'${slot.label}': only ${picks.length} of ${distinct} matching cards.`);
      });
    };
    const allPicks = () => slots.flatMap((s) => s.picks);
    const countWhere = (pred: (c: Candidate) => boolean) => allPicks().reduce((n, p) => n + (info.get(p.oracle_id) && pred(info.get(p.oracle_id)!) ? p.qty : 0), 0);
    const nonlandCount = () => countWhere((c) => !isLand(c.type_line));
    const landCount = () => countWhere((c) => isLand(c.type_line));

    // 1. Theme slots.
    await runSlots(args.slots as SlotDef[], { keepRemainder: true });

    let basics: Array<{ oracle_id: string; name: string; qty: number }> = [];
    if (autoCore) {
      // 2. Roles: fill each to target, counting what the theme picks already do.
      const roleNeeds: Record<string, number> = {};
      for (const [role, target] of Object.entries(targets.roles)) {
        const group = ROLE_GROUPS[role] ?? [role];
        const have = countWhere((c) => c.roles.some((r) => group.includes(r)));
        if (target > have) roleNeeds[role] = target - have;
      }
      const room = Math.max(0, targets.spell_slots - nonlandCount());
      const needTotal = Object.values(roleNeeds).reduce((a, b) => a + b, 0);
      const roleCounts = needTotal > room ? apportion(room, roleNeeds) : roleNeeds;
      if (needTotal > room) warnings.push(`Theme slots left room for ${room} of ${needTotal} role cards -- roles were scaled down.`);
      await runSlots(
        Object.entries(roleCounts)
          .filter(([, n]) => n > 0)
          .map(([role, n]) => ({ label: `core: ${role.replace(/_/g, " ")}`, count: n, core: true, roles_any: ROLE_GROUPS[role] ?? [role], ...(ROLE_SLOT_HINTS[role] ?? {}) }))
      );

      // 3. Types still under target, then more theme cards, then any cheap nonland card.
      let typeRoom = targets.spell_slots - nonlandCount();
      if (typeRoom > 0) {
        const deficits: Record<string, number> = {};
        for (const t of TYPE_KEYS) {
          if (t === "Land") continue;
          const have = countWhere((c) => new RegExp(`\\b${t}\\b`).test(c.type_line.split(" // ")[0]));
          if ((targets.types[t] ?? 0) > have) deficits[t] = (targets.types[t] ?? 0) - have;
        }
        const defTotal = Object.values(deficits).reduce((a, b) => a + b, 0);
        const byType = defTotal > typeRoom ? apportion(typeRoom, deficits) : deficits;
        // On-theme first: leftovers from the theme slots that are the missing type.
        const themeExtra: Candidate[] = [];
        for (const [t, n] of Object.entries(byType)) {
          const re = new RegExp(`\\b${t}\\b`);
          let taken = 0;
          for (const pool of themeRemainders) {
            for (let k = 0; k < pool.length && taken < n; k++) {
              const cand = pool[k];
              if (used.has(cand._id) || isLand(cand.type_line) || !re.test(cand.type_line.split(" // ")[0])) continue;
              used.add(cand._id);
              info.set(cand._id, cand);
              themeExtra.push(cand);
              pool.splice(k--, 1);
              taken++;
            }
          }
          byType[t] = n - taken;
        }
        if (themeExtra.length) slots.push({ label: "theme: more", requested: themeExtra.length, picks: themeExtra.map((c) => ({ oracle_id: c._id, name: c.name, qty: 1 })), alternates: [] });
        await runSlots(
          Object.entries(byType)
            .filter(([, n]) => n > 0)
            // roles_any: only cards that do something -- no vanilla core-set filler.
            .map(([t, n]) => ({ label: `core: ${t === "Sorcery" ? "sorceries" : `${t.toLowerCase()}s`}`, count: n, core: true, type_line_contains: t, cmc_max: 5, nonland: true, roles_any: ANY_ROLE }))
        );
      }
      typeRoom = targets.spell_slots - nonlandCount();
      if (typeRoom > 0) {
        // More of the theme -- the best leftovers from the theme slots, round-robin.
        const extra: Candidate[] = [];
        for (let i = 0; extra.length < typeRoom && themeRemainders.some((r) => r.length); i = (i + 1) % Math.max(1, themeRemainders.length)) {
          const c = themeRemainders[i]?.shift();
          if (c && !used.has(c._id) && !isLand(c.type_line)) {
            used.add(c._id);
            info.set(c._id, c);
            extra.push(c);
          }
        }
        if (extra.length) slots.push({ label: "theme: extra", requested: typeRoom, picks: extra.map((c) => ({ oracle_id: c._id, name: c.name, qty: 1 })), alternates: [] });
        const still = targets.spell_slots - nonlandCount();
        if (still > 0) await runSlots([{ label: "core: flex", count: still, cmc_max: 4, nonland: true, core: true, roles_any: ANY_ROLE }]);
      }

      // 4. Lands: utility lands that make mana, then basics by color, to exactly the deck size.
      const landRoom = Math.max(0, targets.deck_size - nonlandCount() - landCount());
      const utilityWanted = Math.min(landRoom, colors.length >= 2 ? Math.min(12, Math.round(landRoom * 0.3)) : 4);
      if (utilityWanted > 0) await runSlots([{ label: "core: lands", count: utilityWanted, core: true, category: "Land", effect_in: ["Mana"] }]);
      const basicTotal = Math.max(0, targets.deck_size - nonlandCount() - landCount());
      if (basicTotal > 0) {
        const weights: Record<string, number> = {};
        for (const p of allPicks()) for (const col of info.get(p.oracle_id)?.color_identity ?? []) if (BASIC_FOR[col]) weights[col] = (weights[col] ?? 0) + p.qty;
        for (const col of colors) if (BASIC_FOR[col]) weights[col] = (weights[col] ?? 0) + 1;
        const split = Object.keys(weights).length ? apportion(basicTotal, weights) : { C: basicTotal };
        const names = Object.entries(split).filter(([, n]) => n > 0).map(([col, n]) => [col === "C" ? "Wastes" : BASIC_FOR[col], n] as const);
        const docs = await queryCards(ctx.readDb, { names: names.map(([n]) => n) }, priceSource, preferredPrinting);
        basics = names.flatMap(([name, qty]) => {
          const doc = docs.find((d) => d.name.toLowerCase() === name.toLowerCase());
          return doc ? [{ oracle_id: doc.oracle_id, name: doc.name, qty }] : [];
        });
      }
    } else {
      const basicNames = Object.entries(args.basic_lands ?? {}).filter(([, n]) => n > 0);
      const docs = basicNames.length ? await queryCards(ctx.readDb, { names: basicNames.map(([n]) => n) }, priceSource, preferredPrinting) : [];
      basics = basicNames.flatMap(([name, qty]) => {
        const doc = docs.find((d) => d.name.toLowerCase() === name.toLowerCase());
        if (!doc) warnings.push(`Basic land '${name}' not found.`);
        return doc ? [{ oracle_id: doc.oracle_id, name: doc.name, qty }] : [];
      });
    }

    // Budget pass (2026-09-28): swap the priciest server-picked cards (then theme cards) for the
    // cheapest leftover from the same slot until the estimate fits. Candidate prices are the
    // default printing's -- close to what the save prices, which is authoritative.
    if (budget) {
      const BASIC_EST = 0.25;
      const estimate = () =>
        (commander?.price_usd ?? 0) + allPicks().reduce((n, p) => n + (info.get(p.oracle_id)?.price_usd ?? 0) * p.qty, 0) + basics.reduce((n, b) => n + BASIC_EST * b.qty, 0);
      for (let guard = 0; guard < 60 && estimate() > budget * 0.97; guard++) {
        let best: { slot: DraftSlot; idx: number; price: number } | null = null;
        for (const pass of [true, false]) {
          for (const slot of slots) {
            if (slot.label.startsWith("core:") !== pass) continue;
            if (!(pools.get(slot.label) ?? []).some((c) => !used.has(c._id) && c.price_usd != null)) continue;
            slot.picks.forEach((p, idx) => {
              const price = info.get(p.oracle_id)?.price_usd ?? 0;
              if (!best || price > best.price) best = { slot, idx, price };
            });
          }
          if (best) break;
        }
        if (!best) break;
        const { slot, idx, price } = best as { slot: DraftSlot; idx: number; price: number };
        const cheaper = (pools.get(slot.label) ?? []).filter((c) => !used.has(c._id) && c.price_usd != null && c.price_usd < price).sort((a, b) => (a.price_usd ?? 0) - (b.price_usd ?? 0))[0];
        if (!cheaper) {
          pools.set(slot.label, []);
          continue;
        }
        used.add(cheaper._id);
        info.set(cheaper._id, cheaper);
        slot.picks[idx] = { oracle_id: cheaper._id, name: cheaper.name, qty: slot.picks[idx].qty };
      }
    }

    const totalCards = (commander ? 1 : 0) + allPicks().reduce((n, p) => n + p.qty, 0) + basics.reduce((n, b) => n + b.qty, 0);
    const deckName = args.deck_name ?? prompt?.name ?? (commander ? `${commander.name}${constraints.theme ? ` -- ${constraints.theme}` : ""}` : "New deck");
    const summary = () => {
      const types: Record<string, number> = {};
      const roles: Record<string, number> = {};
      for (const p of allPicks()) {
        const c = info.get(p.oracle_id);
        if (!c) continue;
        for (const t of TYPE_KEYS) if (new RegExp(`\\b${t}\\b`).test(c.type_line.split(" // ")[0])) types[t] = (types[t] ?? 0) + p.qty;
        for (const [role, group] of Object.entries(ROLE_GROUPS)) if (c.roles.some((r) => group.includes(r))) roles[role] = (roles[role] ?? 0) + p.qty;
      }
      if (basics.length) types.Land = (types.Land ?? 0) + basics.reduce((n, b) => n + b.qty, 0);
      return { types, roles };
    };

    // 5. Save directly -- unless reviewing, or the format can't be validated yet.
    if (!args.review && rules.validate_supported) {
      const entries = [...allPicks().map((p) => ({ name: p.name, qty: p.qty })), ...basics.map((b) => ({ name: b.name, qty: b.qty }))];
      const result = await saveDecklist(ctx, {
        decklist_text: toDecklistText(commander ? [commander.name] : [], entries),
        deck_name: deckName,
        format,
        wincon_summary: args.wincon_summary ?? `Built around ${commanderName ?? "its theme"}${constraints.theme ? ` -- ${constraints.theme}` : ""}.`,
        general_strategy: args.general_strategy ?? "Develop mana early, deploy the theme pieces, and use the interaction to protect them.",
        bracket_estimate: args.bracket_estimate ?? null,
        is_public: args.is_public,
        deck_id: deckId,
        prompt_id: promptId,
        constraints: { ...constraints, colors },
        source: "fill_deck_plan",
        requireClean: true,
      });
      if (result.saved) {
        const { types, roles } = summary();
        const price = result.analysis.priceTotal;
        return text({
          saved: true,
          deck_url: result.deck_url,
          deck_id: result.deck_id,
          deck_name: deckName,
          commander: commander?.name,
          total_cards: result.analysis.totalCards,
          price_usd: price,
          budget_usd: budget ?? undefined,
          over_budget: budget && price > budget ? `$${price} is over the $${budget} budget -- offer to swap pricier cards with edit_deck.` : undefined,
          types,
          roles,
          mana_curve: result.analysis.consistency.mana_curve,
          slots: slots.map((s) => ({ label: s.label, cards: s.picks.map((p) => (p.qty > 1 ? `${p.qty} ${p.name}` : p.name)) })),
          basic_lands: Object.fromEntries(basics.map((b) => [b.name, b.qty])),
          warnings: warnings.length ? warnings : undefined,
          next: "Done -- reply in under ~100 words: commander, the plan in one line, price vs budget, the deck link. Offer changes via edit_deck.",
        });
      }
      if (result.error && !result.analysis) return text(result.error);
      warnings.push(...(result.analysis?.consistency.issues ?? []));
      if (result.analysis?.consistency.not_found.length) warnings.push(`Not found: ${result.analysis.consistency.not_found.join(", ")}`);
    } else if (rules.commander && totalCards !== 100) {
      warnings.push(`Deck has ${totalCards} cards; Commander needs exactly 100.`);
    }

    // Not saved: keep it as a draft with card details so the model can fix it in validate_and_submit.
    const draftId = await saveDraft(ctx.writeDb, {
      owner_user_id: ctx.ownerUserId,
      prompt_id: promptId,
      format,
      deck_name: deckName,
      commander: commander ? { oracle_id: commander.oracle_id, name: commander.name, color_identity: commander.color_identity } : null,
      constraints: { ...constraints, colors },
      slots,
      basics,
    });
    const detailIds = [...new Set(allPicks().map((p) => p.oracle_id))];
    const details = detailIds.length ? await queryCards(ctx.readDb, { oracle_ids: detailIds }, priceSource, preferredPrinting) : [];
    const byId = new Map(details.map((d) => [d.oracle_id, d]));
    return text({
      saved: false,
      draft_id: draftId,
      prompt_id: promptId,
      deck_id: deckId ?? undefined,
      commander: commander ? toPlanCard(commander, "commander") : null,
      total_cards: totalCards,
      ...summary(),
      warnings: warnings.length ? warnings : undefined,
      slots: slots.map((s) => ({
        label: s.label,
        picks: s.picks.map((p) => {
          const d = byId.get(p.oracle_id);
          const view = d ? (isLand(d.type_line) ? toBriefPlanCard(d) : args.review ? toPlanCard(d) : toBriefPlanCard(d)) : { name: p.name };
          return p.qty > 1 ? { ...view, qty: p.qty } : view;
        }),
      })),
      basic_lands: Object.fromEntries(basics.map((b) => [b.name, b.qty])),
      next: `Fix the warnings, then validate_and_submit({ draft_id, swaps: [{ out, in }], submit: true, deck_name, wincon_summary, general_strategy, bracket_estimate${deckId ? ", deck_id" : ""} }).`,
    });
  },
};

export { fillDeckPlanTool };
