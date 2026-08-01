import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Commander Spellbook is a real, MIT-licensed combo database with an official REST
// API (github.com/SpaceCowMedia/commander-spellbook-backend). Its own docs site blocks
// automated fetching (robots.txt), so the exact query param below ("q", following
// Django REST Framework convention and matching their published syntax guide's
// examples like card:"Sol Ring") is a strong inference, not a 100%-confirmed spec —
// if searches come back empty, verify the param name against their live docs manually.
const COMMANDER_SPELLBOOK_BASE = "https://backend.commanderspellbook.com";

// EDHREC has no official API — this hits the same undocumented JSON endpoints
// their own site uses to render pages. May change or break without notice.
const EDHREC_BASE = "https://json.edhrec.com/pages";

// Forge is an open-source MTG rules engine (GPL-3.0, github.com/Card-Forge/forge).
// Its card behavior is defined in plain-text scripts, one file per card, under
// forge-gui/res/cardsfolder/<first-letter>/<card_name>.txt on the master branch.
// We read these live via GitHub's raw file host rather than vendoring the folder,
// so this stays current with Forge's repo and avoids bundling GPL-licensed files
// into this project.
const FORGE_RAW_BASE = "https://raw.githubusercontent.com/Card-Forge/forge/master/forge-gui/res/cardsfolder";

// Card Kingdom has no official developer API, but publishes a public bulk pricelist
// used by community tools (confirmed schema via github.com/mtgban/go-cardkingdom).
// Response shape: { meta, data: [Product] } where each Product has name, edition,
// is_foil, scryfall_id, price_retail (all numeric/bool fields returned AS STRINGS —
// must be parsed). This is a single large file covering all CK singles, so it's
// fetched once per lookup and filtered in memory rather than queried per-card.
const CARDKINGDOM_PRICELIST_URL = "https://api.cardkingdom.com/api/v2/pricelist";

// Scryfall requires an accurate User-Agent and an Accept header on every request
const HEADERS = {
  "User-Agent": "scryfall-mcp/1.0 (personal project)",
  "Accept": "application/json",
};

// Converts a card/commander name into EDHREC's URL slug format.
// e.g. "Atraxa, Grand Unifier" -> "atraxa-grand-unifier"
function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Converts a card name into Forge's cardsfolder filename convention:
// lowercase, spaces -> underscores, apostrophes/commas stripped.
// e.g. "Krenko, Mob Boss" -> "krenko_mob_boss"
function forgeFilename(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’,]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Create the MCP server instance
const server = new McpServer({
  name: "scryfall-mcp",
  version: "1.0.0",
});

// --- Tool 1: search_cards ---
server.tool(
  "search_cards",
  "Search Magic: The Gathering cards using Scryfall's search syntax (e.g. 'c:red t:creature cmc<=3'). Returns name, mana cost, type, oracle text, and legalities for each match. NOTE ON PRICING: the max_price_usd filter and returned 'usd' field use Scryfall's bundled market price (TCGPlayer-sourced), which is a fast bulk estimate but NOT the standardized price source for this server. For an exact, purchasable price on any specific card, call get_cardkingdom_price separately — especially before finalizing a budget deck total.",
  {
    query: z.string().describe("Scryfall search query, e.g. 'c:red t:creature cmc<=3'"),
    max_price_usd: z.number().optional().describe("Optional: filter out cards above this USD price"),
  },
  async ({ query, max_price_usd }) => {
    const url = `${SCRYFALL_BASE}/cards/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Scryfall search failed: ${res.status} ${res.statusText}` }],
      };
    }

    const data = await res.json();
    let cards = data.data ?? [];

    if (max_price_usd !== undefined) {
      cards = cards.filter((c) => {
        const price = parseFloat(c.prices?.usd ?? "Infinity");
        return price <= max_price_usd;
      });
    }

    const summary = cards.slice(0, 25).map((c) => ({
      name: c.name,
      mana_cost: c.mana_cost,
      type_line: c.type_line,
      oracle_text: c.oracle_text,
      usd: c.prices?.usd ?? "N/A",
      legal_commander: c.legalities?.commander,
      legal_standard: c.legalities?.standard,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// --- Tool 2: get_card_by_name ---
server.tool(
  "get_card_by_name",
  "Get exact details for a single Magic card by its name (fuzzy matched by Scryfall).",
  {
    name: z.string().describe("Card name, e.g. 'Lightning Bolt'"),
  },
  async ({ name }) => {
    const url = `${SCRYFALL_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Card not found: ${name} (${res.status})` }],
      };
    }

    const c = await res.json();
    const details = {
      name: c.name,
      mana_cost: c.mana_cost,
      type_line: c.type_line,
      oracle_text: c.oracle_text,
      usd: c.prices?.usd ?? "N/A",
      legalities: c.legalities,
      set: c.set_name,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    };
  }
);

// --- Tool 3: get_rulings ---
server.tool(
  "get_rulings",
  "Get official rulings/clarifications for a Magic card by exact name.",
  {
    name: z.string().describe("Exact card name, e.g. 'Oko, Thief of Crowns'"),
  },
  async ({ name }) => {
    const cardRes = await fetch(`${SCRYFALL_BASE}/cards/named?exact=${encodeURIComponent(name)}`, { headers: HEADERS });
    if (!cardRes.ok) {
      return { content: [{ type: "text", text: `Card not found: ${name}` }] };
    }
    const card = await cardRes.json();

    const rulingsRes = await fetch(card.rulings_uri, { headers: HEADERS });
    const rulingsData = await rulingsRes.json();
    const rulings = (rulingsData.data ?? []).map((r) => r.comment);

    return {
      content: [{ type: "text", text: JSON.stringify(rulings, null, 2) }],
    };
  }
);

// --- Tool 4: edhrec_get_commander_recommendations ---
server.tool(
  "edhrec_get_commander_recommendations",
  "Get EDHREC's card recommendations for a Commander, grouped by category (High Synergy, Top Cards, Creatures, etc.), each with how many sampled decks include it. Use this when building or improving a Commander deck. Unofficial/undocumented EDHREC data.",
  {
    commander_name: z.string().describe("Exact commander name, e.g. 'Atraxa, Grand Unifier'"),
  },
  async ({ commander_name }) => {
    const slug = slugify(commander_name);
    const res = await fetch(`${EDHREC_BASE}/commanders/${slug}.json`, { headers: HEADERS });

    if (res.status === 404) {
      return { content: [{ type: "text", text: `No EDHREC page found for commander '${commander_name}'. Check spelling.` }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `EDHREC request failed: ${res.status} ${res.statusText}` }] };
    }

    const data = await res.json();
    const cardlists = data?.container?.json_dict?.cardlists ?? [];

    if (cardlists.length === 0) {
      return { content: [{ type: "text", text: `No recommendation data found for '${commander_name}'.` }] };
    }

    const categories = cardlists.map((c) => ({
      header: c.header,
      cards: (c.cardviews ?? []).slice(0, 15).map((card) => ({
        name: card.name,
        inclusion: card.inclusion,
        potential_decks: card.potential_decks ?? card.num_decks,
      })),
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ commander: commander_name, categories }, null, 2) }],
    };
  }
);

// --- Tool 5: edhrec_get_card_synergies ---
server.tool(
  "edhrec_get_card_synergies",
  "Get cards that frequently appear alongside a given (usually non-commander) card across EDHREC's sampled decks, plus known combos involving it. Use this to find what pairs well with an enabler or payoff piece. Unofficial/undocumented EDHREC data.",
  {
    card_name: z.string().describe("Exact card name, e.g. 'Sol Ring'"),
  },
  async ({ card_name }) => {
    const slug = slugify(card_name);
    const res = await fetch(`${EDHREC_BASE}/cards/${slug}.json`, { headers: HEADERS });

    if (res.status === 404) {
      return { content: [{ type: "text", text: `No EDHREC page found for card '${card_name}'. Check spelling.` }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `EDHREC request failed: ${res.status} ${res.statusText}` }] };
    }

    const data = await res.json();
    const cardlists = data?.container?.json_dict?.cardlists ?? [];
    const combos = (data?.panels?.combocounts ?? []).filter((c) => c.value !== "See More...");

    if (cardlists.length === 0 && combos.length === 0) {
      return { content: [{ type: "text", text: `No synergy data found for '${card_name}'.` }] };
    }

    const categories = cardlists.map((c) => ({
      header: c.header,
      cards: (c.cardviews ?? []).slice(0, 15).map((card) => ({
        name: card.name,
        inclusion: card.inclusion,
      })),
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ card: card_name, categories, combos }, null, 2) }],
    };
  }
);

// --- Tool 6: edhrec_get_average_decklist ---
server.tool(
  "edhrec_get_average_decklist",
  "Get EDHREC's precomputed 'average' 100-card decklist for a commander — the statistically most-played card at each slot across sampled decks. Good as a quick baseline/starting point, not a curated or optimized list. Unofficial/undocumented EDHREC data.",
  {
    commander_name: z.string().describe("Exact commander name, e.g. 'Atraxa, Grand Unifier'"),
  },
  async ({ commander_name }) => {
    const slug = slugify(commander_name);
    const res = await fetch(`${EDHREC_BASE}/average-decks/${slug}.json`, { headers: HEADERS });

    if (res.status === 404) {
      return { content: [{ type: "text", text: `No EDHREC page found for commander '${commander_name}'. Check spelling.` }] };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `EDHREC request failed: ${res.status} ${res.statusText}` }] };
    }

    const data = await res.json();
    const deck = data?.deck;

    if (!deck) {
      return { content: [{ type: "text", text: `No average decklist found for '${commander_name}'.` }] };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ commander: commander_name, deck }, null, 2) }],
    };
  }
);

// --- Tool 7: get_card_script ---
server.tool(
  "get_card_script",
  "Get the Forge rules-engine script for a Magic card — a structured, machine-parsed breakdown of its costs, effects, and triggers (e.g. Cost$ T for a tap ability vs. a Trigger$ Attacks for an attack-triggered ability). Use this to disambiguate exactly how an ability works (tap cost vs. attack trigger vs. ETB, etc.) when oracle text prose is ambiguous. Source: Card-Forge/forge on GitHub (GPL-3.0, community-maintained, unofficial).",
  {
    name: z.string().describe("Card name, e.g. 'Krenko, Mob Boss'"),
  },
  async ({ name }) => {
    const filename = forgeFilename(name);
    const firstLetter = filename.charAt(0);
    const url = `${FORGE_RAW_BASE}/${firstLetter}/${filename}.txt`;

    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 404) {
      return {
        content: [{
          type: "text",
          text: `No Forge script found at expected path for '${name}' (tried ${filename}.txt). ` +
                `Forge's filename convention is lowercase with underscores for spaces; unusual ` +
                `punctuation or split/double-faced cards may not match this pattern. Fall back to ` +
                `Scryfall's oracle text via get_card_by_name for this card.`,
        }],
      };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `Forge script request failed: ${res.status} ${res.statusText}` }] };
    }

    const script = await res.text();

    return {
      content: [{
        type: "text",
        text: `Forge card script for '${name}' (source: Card-Forge/forge, unofficial/community-maintained):\n\n${script}`,
      }],
    };
  }
);

// --- Tool 8: get_cardkingdom_price ---
server.tool(
  "get_cardkingdom_price",
  "Get Card Kingdom's current retail price for a card — the standardized price source for this server. Returns the cheapest in-stock non-foil listing across all printings/editions Card Kingdom carries, plus the specific edition and foil status. Use this instead of Scryfall's bundled price field when the user cares about an exact, purchasable price (e.g. staying under a budget). Source: Card Kingdom's public pricelist feed — unofficial/undocumented, no developer API or SLA.",
  {
    name: z.string().describe("Card name, e.g. 'Sol Ring'"),
    include_foil: z.boolean().optional().describe("If true, also consider foil listings when finding the cheapest price. Default false (non-foil only)."),
  },
  async ({ name, include_foil }) => {
    const res = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });

    if (!res.ok) {
      return { content: [{ type: "text", text: `Card Kingdom pricelist request failed: ${res.status} ${res.statusText}` }] };
    }

    const body = await res.json();
    const products = body?.data ?? [];

    const nameLower = name.trim().toLowerCase();
    const matches = products.filter((p) => {
      if ((p.name ?? "").toLowerCase() !== nameLower) return false;
      const isFoil = p.is_foil === true || p.is_foil === "true";
      if (isFoil && !include_foil) return false;
      const qty = Number(p.qty_retail ?? 0);
      return qty > 0;
    });

    if (matches.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No in-stock Card Kingdom listing found for '${name}'` +
                `${include_foil ? "" : " (non-foil only — try include_foil: true)"}. ` +
                `Check spelling, or the card may be out of stock / not carried by CK.`,
        }],
      };
    }

    matches.sort((a, b) => parseFloat(a.price_retail) - parseFloat(b.price_retail));
    const cheapest = matches[0];

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          name: cheapest.name,
          edition: cheapest.edition,
          is_foil: cheapest.is_foil === true || cheapest.is_foil === "true",
          price_usd: parseFloat(cheapest.price_retail),
          qty_in_stock: Number(cheapest.qty_retail ?? 0),
          scryfall_id: cheapest.scryfall_id || null,
          source: "cardkingdom",
        }, null, 2),
      }],
    };
  }
);

// --- Tool 9: build_budget_deck ---
server.tool(
  "build_budget_deck",
  "Build an optimized Commander deck for a given commander under a strict USD budget, using EDHREC's synergy/inclusion data as a power signal and Card Kingdom pricing for real costs. Runs a greedy knapsack: pulls the commander's full EDHREC card pool across all categories, prices each candidate via Card Kingdom, sorts by synergy-per-dollar, and fills 99 nonland slots without exceeding budget. IMPORTANT CAVEATS: this optimizes for 'high synergy per dollar' as a power proxy, NOT a true bracket/power-level classifier — it does not verify combo lines, mana curve coherence, or color balance beyond what EDHREC's categories imply. Treat the output as a strong first draft to sanity-check, not a finished decklist.",
  {
    commander_name: z.string().describe("Exact commander name, e.g. 'Vadrik, Astral Archmage'"),
    budget_usd: z.number().describe("Total USD budget for the 99 nonland cards (commander and basic lands excluded from the count)"),
    min_synergy_pct: z.number().optional().describe("Optional: skip candidates below this synergy percentage (0-100). Default 0 (no filter)."),
  },
  async ({ commander_name, budget_usd, min_synergy_pct }) => {
    const slug = slugify(commander_name);

    // Step 1: pull the commander's full EDHREC page (all categories, not just top-N)
    const edhrecRes = await fetch(`${EDHREC_BASE}/commanders/${slug}.json`, { headers: HEADERS });
    if (edhrecRes.status === 404) {
      return { content: [{ type: "text", text: `No EDHREC page found for '${commander_name}'. Check spelling.` }] };
    }
    if (!edhrecRes.ok) {
      return { content: [{ type: "text", text: `EDHREC request failed: ${edhrecRes.status} ${edhrecRes.statusText}` }] };
    }
    const edhrecData = await edhrecRes.json();
    const cardlists = edhrecData?.container?.json_dict?.cardlists ?? [];

    if (cardlists.length === 0) {
      return { content: [{ type: "text", text: `No card pool data found for '${commander_name}' on EDHREC.` }] };
    }

    // Flatten every card across every category into one candidate pool, deduped by name,
    // keeping the highest synergy score seen for each (a card can appear in multiple categories).
    const candidates = new Map();
    for (const section of cardlists) {
      for (const card of section.cardviews ?? []) {
        const cardName = card.name;
        const synergy = typeof card.synergy === "number" ? card.synergy * 100 : (card.inclusion ?? 0);
        if (!cardName) continue;
        if (!candidates.has(cardName) || candidates.get(cardName).synergy < synergy) {
          candidates.set(cardName, { name: cardName, synergy, category: section.header });
        }
      }
    }

    let pool = Array.from(candidates.values());
    if (min_synergy_pct !== undefined) {
      pool = pool.filter((c) => c.synergy >= min_synergy_pct);
    }

    if (pool.length === 0) {
      return { content: [{ type: "text", text: `No candidates found after filtering. Try lowering min_synergy_pct.` }] };
    }

    // Step 2: pull Card Kingdom's full pricelist once, build a name -> cheapest price lookup
    const ckRes = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });
    if (!ckRes.ok) {
      return { content: [{ type: "text", text: `Card Kingdom pricelist request failed: ${ckRes.status} ${ckRes.statusText}` }] };
    }
    const ckBody = await ckRes.json();
    const ckProducts = ckBody?.data ?? [];

    const priceByName = new Map();
    for (const p of ckProducts) {
      const isFoil = p.is_foil === true || p.is_foil === "true";
      const qty = Number(p.qty_retail ?? 0);
      if (isFoil || qty <= 0) continue;
      const price = parseFloat(p.price_retail);
      if (isNaN(price)) continue;
      const existing = priceByName.get(p.name);
      if (!existing || price < existing) {
        priceByName.set(p.name, price);
      }
    }

    // Step 3: attach price to each candidate, drop anything not found in stock at CK
    const priced = pool
      .map((c) => ({ ...c, price: priceByName.get(c.name) }))
      .filter((c) => c.price !== undefined && c.price > 0);

    if (priced.length === 0) {
      return { content: [{ type: "text", text: `None of the EDHREC candidates for '${commander_name}' were found in Card Kingdom's in-stock pricelist.` }] };
    }

    // Step 4: greedy knapsack — sort by synergy-per-dollar descending, fill up to 99 cards without busting budget
    priced.sort((a, b) => (b.synergy / b.price) - (a.synergy / a.price));

    const deck = [];
    let runningTotal = 0;
    for (const card of priced) {
      if (deck.length >= 99) break;
      if (runningTotal + card.price > budget_usd) continue;
      deck.push(card);
      runningTotal += card.price;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          commander: commander_name,
          budget_usd,
          nonland_cards_selected: deck.length,
          total_spent_usd: Math.round(runningTotal * 100) / 100,
          budget_remaining_usd: Math.round((budget_usd - runningTotal) * 100) / 100,
          note: "Synergy-per-dollar greedy optimization from EDHREC data + Card Kingdom pricing. Does NOT verify combo lines, mana curve, color balance, or land count — sanity-check before playing. Basic lands and the commander itself are excluded from this count and budget.",
          deck: deck.map((c) => ({ name: c.name, category: c.category, synergy_pct: Math.round(c.synergy * 10) / 10, price_usd: c.price })),
        }, null, 2),
      }],
    };
  }
);

// --- Tool 10: find_combos ---
server.tool(
  "find_combos",
  "Find real, documented infinite combos or synergistic card interactions from Commander Spellbook's combo database, given one or more card names. Returns each matching combo's card list, prerequisites, steps, and results (e.g. 'infinite mana', 'win the game'). Use this to verify whether a card is actually part of a known combo, as a check against synergy-only signals from EDHREC. Source: Commander Spellbook's official REST API (MIT licensed, community-run, backend.commanderspellbook.com) — NOTE: the exact search query parameter is inferred from their public syntax guide, not independently confirmed against live docs, so an empty result set for a card known to have combos may indicate a param mismatch rather than truly no combos.",
  {
    card_names: z.array(z.string()).min(1).describe("One or more exact card names to find combos for, e.g. ['Dramatic Reversal', 'Isochron Scepter']"),
    limit: z.number().optional().describe("Max combos to return (default 10)"),
  },
  async ({ card_names, limit }) => {
    const query = card_names.map((name) => `card:"${name}"`).join(" ");
    const url = `${COMMANDER_SPELLBOOK_BASE}/variants/?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`;

    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      return {
        content: [{
          type: "text",
          text: `Commander Spellbook request failed: ${res.status} ${res.statusText}. ` +
                `If this persists, the "q" query param may not match their current API — ` +
                `verify against backend.commanderspellbook.com's live docs.`,
        }],
      };
    }

    const data = await res.json();
    const results = data?.results ?? [];

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No combos found for [${card_names.join(", ")}]. This may mean no combo exists, ` +
                `or the search query param didn't match as expected — spot-check a known combo ` +
                `(e.g. ['Dramatic Reversal', 'Isochron Scepter']) if this seems wrong.`,
        }],
      };
    }

    const combos = results.map((v) => ({
      id: v.id,
      cards: (v.uses ?? []).map((u) => u.card?.name).filter(Boolean),
      prerequisites: v.easyPrerequisites || v.prerequisites || null,
      steps: v.description || v.steps || null,
      results: (v.produces ?? []).map((p) => p.feature?.name).filter(Boolean),
      permalink: v.id ? `https://commanderspellbook.com/combo/${v.id}` : null,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ query: card_names, combos }, null, 2) }],
    };
  }
);

// --- Start the server over stdio ---
const transport = new StdioServerTransport();
await server.connect(transport);