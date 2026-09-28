/**
 * functions/query/card-view.ts
 *
 * The card shape fill_deck_plan / edit_deck return to the model (2026-09-27) -- enough to judge a pick
 * and see synergies WITHOUT the raw Forge effects tree:
 *
 *   abilities[] -- one per ability: what fires it (`on` + `on_what`), what it does (`does`, in chain
 *                  order), what it hits (`targets`), its cost, and whether it's optional ("you may").
 *   makes_tokens -- what it creates, resolved from Forge's token scripts ("1/1 red Goblin").
 *   roles        -- manaramp's precomputed role flags (ramp/draw/removal...), same rules as the website.
 *
 * Seeing "Goblin Instigator: on etb -> does Token, makes 1/1 red Goblin" next to "Impact Tremors: on
 * etb of Creature.YouCtrl -> does DealDamage to Player.Opponent" makes the loop visible without
 * guessing. Oracle text rides along as the ground truth for the fine print.
 *
 * The trigger-name normalization (etb/dies/attacks/...) is the one the website's card page used to
 * show; Forge's own Mode$ vocabulary, not guessed.
 */
import type { CardSummary, Effect, EffectStep, EffectValue, EffectCostPart } from "./cards.js";

interface CardAbility {
  kind: string;
  on: string | null;
  on_what: string | null;
  does: string[];
  targets: string | null;
  cost: string | null;
  optional: boolean;
}

/** Forge's EffectValue ([{type, modifiers}]) back to its own compact syntax, e.g. "Creature.YouCtrl". */
function valueText(value: EffectValue | string | undefined | null): string | null {
  if (!value) return null;
  const v = typeof value === "string" ? [{ type: value, modifiers: [] as string[] }] : value;
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.map((c) => (c.modifiers?.length ? `${c.type}.${c.modifiers.join("+")}` : c.type)).join(",");
}

const firstType = (value: EffectValue | undefined | null): string => (Array.isArray(value) ? (value[0]?.type ?? "") : "");

function costText(cost: EffectCostPart[] | null | undefined): string | null {
  if (!cost?.length) return null;
  return cost.map((p) => (p.mana !== null ? p.mana : p.args.length ? `${p.kind}<${p.args.join("/")}>` : p.kind)).join(", ");
}

/** Mode$ -> a small plain vocabulary (etb, dies, attacks...), CamelCase -> snake_case fallback. */
function triggerName(trigger: Effect["trigger"]): string | null {
  const mode = trigger.mode;
  if (trigger.kind === "cast") return "cast";
  if (trigger.kind === "activate") return "activated";
  if (!mode) return trigger.kind === "static" ? "static" : null;
  if (mode === "ChangesZone" || mode === "ChangesZoneAll") {
    const from = firstType(trigger.zone_change?.from);
    const to = firstType(trigger.zone_change?.to);
    if (to === "Battlefield") return "etb";
    if (from === "Battlefield" && to === "Graveyard") return "dies";
    if (from === "Battlefield" && to === "Exile") return "exiled";
    if (from === "Battlefield" && to === "Hand") return "bounced";
    if (from === "Battlefield") return "leaves_battlefield";
    if (to === "Graveyard") return "put_into_graveyard";
    return "changes_zone";
  }
  if (mode === "Phase") {
    const phase = firstType(trigger.conditions?.Phase);
    if (/upkeep/i.test(phase)) return "upkeep";
    if (/draw/i.test(phase)) return "draw_step";
    if (/end.?of.?combat/i.test(phase)) return "end_of_combat";
    if (/end.?of.?turn|cleanup/i.test(phase)) return "end_step";
    if (/main/i.test(phase)) return "main_phase";
    return "phase";
  }
  const direct: Record<string, string> = {
    SpellCast: "cast_spell", SpellAbilityCast: "cast_spell", Attacks: "attacks", AttackersDeclared: "attacks",
    Blocks: "blocks", Drawn: "draws", DamageDone: "deals_damage", DamageDoneOnce: "deals_damage",
    Sacrificed: "sacrificed", Destroyed: "destroyed", LifeGained: "life_gained", LifeLost: "life_lost",
    CounterAdded: "counter_added", CounterAddedOnce: "counter_added", TokenCreated: "token_created",
    Discarded: "discards", Taps: "taps", Untaps: "untaps", Exploited: "exploited", Cycled: "cycled",
  };
  return direct[mode] ?? mode.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Which objects fire a trigger (ValidCard$ / ValidTarget$ style condition), e.g. "Creature.YouCtrl". */
function triggerSubject(trigger: Effect["trigger"]): string | null {
  const c = trigger.conditions ?? {};
  return valueText(trigger.zone_change?.what ?? c.ValidCard ?? c.ValidSource ?? c.ValidTarget ?? c.ValidActivatingPlayer ?? null);
}

/** A step and everything chained under it (nested effects, branch arms, charm modes), in order. */
function flattenSteps(steps: EffectStep[]): EffectStep[] {
  const out: EffectStep[] = [];
  const visit = (step: EffectStep) => {
    out.push(step);
    for (const n of step.nested_effects ?? []) n.result.forEach(visit);
    if (step.branch) { step.branch.true_result.forEach(visit); step.branch.false_result.forEach(visit); }
    for (const choice of Object.values(step.choices ?? {})) choice.forEach(visit);
  };
  steps.forEach(visit);
  return out;
}

function abilitiesOf(effects: Effect[]): CardAbility[] {
  return effects.map((e) => {
    const steps = flattenSteps(e.result);
    const targetStep = steps.find((s) => s.params?.ValidTgts || s.params?.Defined || s.params?.ValidCards || s.params?.Affected);
    const p = targetStep?.params ?? {};
    return {
      kind: e.trigger.kind,
      on: triggerName(e.trigger),
      on_what: e.trigger.kind === "triggered" ? triggerSubject(e.trigger) : null,
      does: [...new Set(steps.map((s) => s.effect).filter((x) => x && x !== "Cleanup"))],
      targets: valueText(p.ValidTgts ?? p.Defined ?? p.ValidCards ?? p.Affected ?? null),
      cost: costText(e.trigger.cost),
      optional: "OptionalDecider" in (e.trigger.conditions ?? {}) || steps.some((s) => "OptionalDecider" in (s.params ?? {})),
    };
  });
}

function tokensOf(effects: Effect[]): string[] {
  const out = new Set<string>();
  const walk = (effectsList: Effect[]) => {
    for (const e of effectsList) {
      for (const step of flattenSteps(e.result)) {
        for (const t of Object.values(step.tokens ?? {})) {
          const colors = t.colors ? `${t.colors.toLowerCase()} ` : "";
          out.add([t.pt, `${colors}${t.name.replace(/ Token$/, "")}`].filter(Boolean).join(" "));
        }
      }
      walk(e.trigger.nested_effects ?? []);
    }
  };
  walk(effects);
  return [...out];
}

/** Real keywords only -- Forge also records internal script tokens as "keywords" (they contain ':'). */
const realKeywords = (k: string[] | null) => (k ?? []).filter((x) => !x.includes(":"));

/** A pick in a fill/edit response. `slot` = the plan slot that chose it. */
function toPlanCard(c: CardSummary, slot?: string, opts: { withText?: boolean } = {}) {
  const pt = c.power != null || c.toughness != null ? `${c.power ?? "?"}/${c.toughness ?? "?"}` : undefined;
  const out: Record<string, unknown> = {
    name: c.name,
    slot,
    mana_cost: c.mana_cost ?? undefined,
    cmc: c.cmc ?? undefined,
    type_line: c.type_line,
    color_identity: c.color_identity.join("") || "C",
    pt,
    loyalty: c.loyalty ?? undefined,
  };
  if (opts.withText !== false && c.oracle_text) out.oracle_text = c.oracle_text;
  const kw = realKeywords(c.keywords);
  if (kw.length) out.keywords = kw;
  const abilities = abilitiesOf(c.effects ?? []);
  if (abilities.length) out.abilities = abilities;
  const tokens = tokensOf(c.effects ?? []);
  if (tokens.length) out.makes_tokens = tokens;
  if (c.roles?.length) out.roles = c.roles;
  if (c.price_usd != null) out.price_usd = c.price_usd;
  return out;
}

/** Alternates / utility lands: same shape minus oracle text. */
const toBriefPlanCard = (c: CardSummary, slot?: string) => toPlanCard(c, slot, { withText: false });

/** What a commander REWARDS (2026-09-27) -- a rules-based read of its abilities + text, so a model
 *  building with no stated theme starts from what this commander actually pays off, not from a
 *  remembered "typical" list. Hints, not verdicts: the model still reads the abilities itself. */
function commanderRewards(c: CardSummary): string[] {
  const out = new Set<string>();
  const text = (c.oracle_text ?? "").toLowerCase();
  for (const a of abilitiesOf(c.effects ?? [])) {
    const what = (a.on_what ?? "").toLowerCase();
    const does = a.does;
    if (a.on === "etb" && what.includes("creature") && !what.includes("self")) out.add("go-wide: tokens, cheap creatures, blink/flicker (creatures entering)");
    if (a.on === "etb" && what.includes("land")) out.add("landfall: land ramp, fetch lands, extra land drops");
    if (a.on === "dies" || a.on === "sacrificed") out.add("sacrifice / death triggers (aristocrats)");
    if (a.on === "cast_spell") out.add(/instant|sorcery/.test(text) ? "spellslinger: cheap instants and sorceries, copy effects" : "casting lots of spells");
    if (a.on === "attacks" || a.on === "deals_damage") out.add("combat: evasion, extra combats, haste, attackers");
    if (a.on === "counter_added" || does.includes("PutCounter") || does.includes("PutCounterAll")) out.add("+1/+1 counters: counter sources, proliferate");
    if (a.on === "life_gained" || does.includes("GainLife")) out.add("lifegain payoffs");
    if (a.on === "token_created" || does.includes("Token")) out.add("tokens: token makers, anthems, token doublers");
    if (a.kind === "triggered" && does.includes("Draw")) out.add("card-draw engine: whatever triggers its draw");
    if (does.includes("DealDamage") && (a.targets ?? "").toLowerCase().includes("opponent")) out.add("direct damage / drain to opponents");
    if (does.includes("ChangeZone") && /graveyard/.test(text)) out.add("graveyard: self-mill, reanimation, recursion");
    if (a.on === "discards" || does.includes("Discard")) out.add("discard / madness / wheels");
    if (does.includes("ReduceCost") || does.includes("Mana")) out.add("ramp into big spells");
    if (a.cost?.startsWith("Sac")) out.add("sacrifice fodder: tokens and recursive creatures");
  }
  if (/equip|aura|enchanted creature|equipped creature/.test(text)) out.add("voltron: equipment and auras on one threat");
  if (/artifact/.test(text)) out.add("artifacts matter");
  if (/enchantment/.test(text) && !/enchanted/.test(text)) out.add("enchantments matter");
  if (out.size === 0) out.add("value/midrange built around its own abilities");
  return [...out];
}

export { toPlanCard, toBriefPlanCard, abilitiesOf, tokensOf, commanderRewards };
export type { CardAbility };
