function valueText(value) {
  if (!value) return null;
  const v = typeof value === "string" ? [{ type: value, modifiers: [] }] : value;
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.map((c) => c.modifiers?.length ? `${c.type}.${c.modifiers.join("+")}` : c.type).join(",");
}
const firstType = (value) => Array.isArray(value) ? value[0]?.type ?? "" : "";
function costText(cost) {
  if (!cost?.length) return null;
  return cost.map((p) => p.mana !== null ? p.mana : p.args.length ? `${p.kind}<${p.args.join("/")}>` : p.kind).join(", ");
}
function triggerName(trigger) {
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
  const direct = {
    SpellCast: "cast_spell",
    SpellAbilityCast: "cast_spell",
    Attacks: "attacks",
    AttackersDeclared: "attacks",
    Blocks: "blocks",
    Drawn: "draws",
    DamageDone: "deals_damage",
    DamageDoneOnce: "deals_damage",
    Sacrificed: "sacrificed",
    Destroyed: "destroyed",
    LifeGained: "life_gained",
    LifeLost: "life_lost",
    CounterAdded: "counter_added",
    CounterAddedOnce: "counter_added",
    TokenCreated: "token_created",
    Discarded: "discards",
    Taps: "taps",
    Untaps: "untaps",
    Exploited: "exploited",
    Cycled: "cycled"
  };
  return direct[mode] ?? mode.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function triggerSubject(trigger) {
  const c = trigger.conditions ?? {};
  return valueText(trigger.zone_change?.what ?? c.ValidCard ?? c.ValidSource ?? c.ValidTarget ?? c.ValidActivatingPlayer ?? null);
}
function flattenSteps(steps) {
  const out = [];
  const visit = (step) => {
    out.push(step);
    for (const n of step.nested_effects ?? []) n.result.forEach(visit);
    if (step.branch) {
      step.branch.true_result.forEach(visit);
      step.branch.false_result.forEach(visit);
    }
    for (const choice of Object.values(step.choices ?? {})) choice.forEach(visit);
  };
  steps.forEach(visit);
  return out;
}
function abilitiesOf(effects) {
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
      optional: "OptionalDecider" in (e.trigger.conditions ?? {}) || steps.some((s) => "OptionalDecider" in (s.params ?? {}))
    };
  });
}
function tokensOf(effects) {
  const out = /* @__PURE__ */ new Set();
  const walk = (effectsList) => {
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
const realKeywords = (k) => (k ?? []).filter((x) => !x.includes(":"));
function toPlanCard(c, slot, opts = {}) {
  const pt = c.power != null || c.toughness != null ? `${c.power ?? "?"}/${c.toughness ?? "?"}` : void 0;
  const out = {
    name: c.name,
    slot,
    mana_cost: c.mana_cost ?? void 0,
    cmc: c.cmc ?? void 0,
    type_line: c.type_line,
    color_identity: c.color_identity.join("") || "C",
    pt,
    loyalty: c.loyalty ?? void 0
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
const toBriefPlanCard = (c, slot) => toPlanCard(c, slot, { withText: false });
function commanderRewards(c) {
  const out = /* @__PURE__ */ new Set();
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
export {
  abilitiesOf,
  commanderRewards,
  toBriefPlanCard,
  toPlanCard,
  tokensOf
};
