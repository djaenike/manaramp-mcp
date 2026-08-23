import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Commander Spellbook is a real, MIT-licensed combo database with an official REST
// API (github.com/SpaceCowMedia/commander-spellbook-backend). Its own docs site blocks
// automated fetching (robots.txt), so the exact query param below ("q", following
// Django REST Framework convention and matching their published syntax guide's
// examples like card:"Sol Ring") is a strong inference, not a 100%-confirmed spec —
// if searches come back empty, verify the param name against their live docs manually.
// Scryfall is the official, documented MTG card database API — no API key needed.
const SCRYFALL_BASE = "https://api.scryfall.com";

// Scryfall's documented hard rate limits: /cards/search, /cards/named, /cards/random, and
// /cards/collection are each 2/second (500ms apart); everything else is 10/second (100ms apart).
// A small safety margin is added on top of both (520ms/110ms) rather than the bare minimum.
const SCRYFALL_MIN_INTERVAL_MS = { search: 520, named: 520, random: 520, collection: 520, default: 110 };
const scryfallLastRequestAt = { search: 0, named: 0, random: 0, collection: 0, default: 0 };

// Proactively paces every Scryfall call by endpoint category — not just reactive retry-after-429.
// This module-level state persists for this MCP process's entire session lifetime, so it actually
// coordinates separate tool calls fired back-to-back (e.g. rate_deck_bracket then
// analyze_deck_consistency in the same final-delivery turn), not just chunks within one call.
// EVERY Scryfall fetch in this file must go through this — a raw fetch(SCRYFALL_BASE...) bypasses
// the pacing entirely and risks a real 429/ban, which is exactly what prompted this.
async function scryfallFetch(url, options, category = "default") {
  const minInterval = SCRYFALL_MIN_INTERVAL_MS[category] ?? SCRYFALL_MIN_INTERVAL_MS.default;
  const waitMs = scryfallLastRequestAt[category] + minInterval - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  scryfallLastRequestAt[category] = Date.now();

  const res = await fetch(url, options);
  if (res.status === 429) {
    // Scryfall's own documented behavior: a 429 means a fixed ~30s penalty window, not a transient
    // blip — one wait-then-retry (honoring Retry-After if present) matches that directly, rather
    // than a generic exponential-backoff loop meant for transient network errors.
    const retryMs = Math.min((Number(res.headers.get("Retry-After")) || 30) * 1000, 30000);
    await new Promise((r) => setTimeout(r, retryMs));
    scryfallLastRequestAt[category] = Date.now();
    return fetch(url, options);
  }
  return res;
}

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

// extensions/playtest-table — a SEPARATE server (SvelteKit + Cloudflare Durable Objects), not
// part of this MCP process. Deployed for real at PLAYTEST_BASE below (Cloudflare Workers Builds,
// auto-deploys on every push to main) — a single shared instance every install of this MCP talks
// to by default. Override PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787`
// instead (e.g. while developing playtest-table itself). See extensions/README.md.
const PLAYTEST_BASE = process.env.PLAYTEST_SERVER_URL || "https://scryfall-mcp.playtest-table.workers.dev";
const PLAYTEST_JSON_HEADERS = { "Content-Type": "application/json" };
// Bumped from 5000ms: the Scryfall rate-limit compliance fix (scryfallFetch/fetchWithRetry pacing)
// legitimately made deck resolution take longer (measured ~3-5s for a real ~100-card deck under
// normal conditions, and up to ~30s more if an actual 429 triggers a wait-then-retry) — a 5s
// ceiling on the round trip risked failing on exactly the slow-but-correct path this fix produces.
const PLAYTEST_TIMEOUT_MS = 20000;
const PLAYTEST_ZONES = ["command", "library", "hand", "battlefield", "graveyard", "exile"];

// Scryfall requires an accurate User-Agent and an Accept header on every request
const HEADERS = {
  "User-Agent": "scryfall-mcp/1.0 (personal project)",
  "Accept": "application/json",
};

// Moxfield has no official public API. api2.moxfield.com/v2/decks/all/<deckId> is the same
// undocumented endpoint their own frontend calls — confirmed live this session (200 OK, full
// mainboard/commanders/sideboard data, each keyed by card name with a nested Scryfall-sourced
// `card` object). Unlike Scryfall, it 403s without a genuinely browser-like User-Agent — the
// scryfall-mcp UA in HEADERS above does not work here, hence a separate header set.
const MOXFIELD_API_BASE = "https://api2.moxfield.com/v2/decks/all";
const MOXFIELD_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};

// --- Commander Bracket System reference data (rate_deck_bracket) -----------------------------
// The Commander Format Panel's bracket system is an official but deliberately loose beta ("meant
// to guide pregame conversations, not an ultimate arbiter" — WotC's own framing), reviewed and
// updated roughly every 3-4 months. This list is current as of the February 9, 2026 update
// (fetched directly from a third-party mirror of WotC's data, since the official interactive tool
// has no plain JSON endpoint) — 53 cards. Not allowed at all in Brackets 1-2, up to 3 in Bracket 3,
// unlimited in Brackets 4-5. Re-verify against WotC's own Game Changers page if a rating looks off
// or enough time has passed that a review cycle is likely.
const GAME_CHANGERS = [
  "Drannith Magistrate", "Enlightened Tutor", "Farewell", "Humility", "Serra's Sanctum",
  "Smothering Tithe", "Teferi's Protection", "Consecrated Sphinx", "Cyclonic Rift",
  "Fierce Guardianship", "Force of Will", "Gifts Ungiven", "Intuition", "Mystical Tutor",
  "Narset, Parter of Veils", "Rhystic Study", "Thassa's Oracle", "Ad Nauseam", "Bolas's Citadel",
  "Braids, Cabal Minion", "Demonic Tutor", "Imperial Seal", "Necropotence", "Opposition Agent",
  "Orcish Bowmasters", "Tergrid, God of Fright", "Vampiric Tutor", "Gamble", "Jeska's Will",
  "Underworld Breach", "Biorhythm", "Crop Rotation", "Gaea's Cradle", "Natural Order",
  "Seedborn Muse", "Survival of the Fittest", "Worldly Tutor", "Aura Shards", "Coalition Victory",
  "Grand Arbiter Augustin IV", "Notion Thief", "Ancient Tomb", "Chrome Mox", "Field of the Dead",
  "Glacial Chasm", "Grim Monolith", "Lion's Eye Diamond", "Mana Vault", "Mishra's Workshop",
  "Mox Diamond", "Panoptic Mirror", "The One Ring", "The Tabernacle at Pendrell Vale",
];

// Symmetrical land-destruction effects hitting every opponent at once — a small, stable card
// category (unlike Game Changers, not a curated/evolving list), banned in Brackets 1-3, allowed
// in 4-5.
const MASS_LAND_DENIAL_CARDS = [
  "Armageddon", "Ravages of War", "Catastrophe", "Jokulhaups", "Obliterate",
  "Decree of Annihilation", "Restore Balance", "Wildfire", "Fall of the Titans",
];

// Extra-turn spells: unrestricted in Brackets 4-5, "a couple, never chained" in Bracket 2, allowed
// but not chained in Bracket 3, banned outright in Bracket 1. This tool only counts presence —
// whether a deck actually chains them (e.g. via untap/cost-reduction engines) is a board-state
// question no static card list can answer, so that nuance is left to the confidence notes, not a
// hard rule.
const EXTRA_TURN_CARDS = [
  "Time Warp", "Temporal Manipulation", "Capture of Jingzhou", "Nexus of Fate",
  "Alrund's Epiphany", "Expropriate", "Temporal Trespass", "Time Stretch",
  "Beacon of Tomorrows", "Walk the Aeons", "Part the Waterveil", "Karn's Temporal Sundering",
];

// A combo's pieces summed mana value is a rough proxy for "can this come online early" (Bracket
// 3's actual bar is roughly turn-6-or-earlier) — not a real simulation. The turn-by-turn
// probability tool discussed separately would replace this with an actual simulated distribution;
// this ships a transparent, documented heuristic now rather than blocking on that larger tool.
const FAST_COMBO_MAX_CMC = 6;

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

// --- playtest-table helpers -------------------------------------------------------------
// Ported from extensions/playtest-table/scripts/play.js, the Claude-Code-only CLI that already
// drives this exact protocol. The one genuinely new concern here (vs. this file's other 10 tools,
// which all hit stable public APIs): a refused connection is the *expected* common case — wrangler
// dev simply not running yet — so every entry point needs a fast, clear failure instead of an
// opaque ECONNREFUSED or an indefinite hang.

function playtestWsUrl(roomId) {
  return `${PLAYTEST_BASE.replace(/^http/, "ws")}/api/room/${encodeURIComponent(roomId)}`;
}

async function playtestFetch(path, options) {
  try {
    return await fetch(`${PLAYTEST_BASE}${path}`, options);
  } catch (e) {
    throw new Error(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in extensions/playtest-table. (${e.message || e})`
    );
  }
}

function connectRoom(roomId, timeoutMs = PLAYTEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(playtestWsUrl(roomId));
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} within ${timeoutMs}ms — ` +
      `make sure \`npx wrangler dev\` is running in extensions/playtest-table.`
    ), timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in extensions/playtest-table. (${e.message || e})`
    ));
  });
}

// Direct port of play.js's sendAndAwait. 'ended' is endTable's reply (it wipes the room, so
// there's no state to broadcast) — resolves state:null, same as play.js already handles it.
// batchErrors arrive before the final state broadcast; play.js console.errors them and keeps
// waiting, but there's no terminal here, so they're collected and returned to the caller instead.
function sendAndAwait(ws, action, timeoutMs = PLAYTEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let batchErrors = null;
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Timed out waiting for a response from the playtest server at ${PLAYTEST_BASE}.`));
    }, timeoutMs);
    function handler(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "state") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ state: msg.state, batchErrors });
      } else if (msg.type === "ended") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ state: null, batchErrors });
      } else if (msg.type === "error") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        reject(new Error(msg.error));
      } else if (msg.type === "batchErrors") {
        batchErrors = msg.errors;
      }
    }
    ws.addEventListener("message", handler);
    if (action) ws.send(JSON.stringify(action));
  });
}

// Connect -> consume the auto-pushed initial state -> optionally send one real action -> await
// its result -> always close. The server pushes {type:'state'} the instant the socket opens, with
// no request needed — sending the real action immediately after open risks resolving on that
// unsolicited push instead of the broadcast the action actually caused, so the initial
// sendAndAwait(ws, null) is required, not optional. Every tool below goes through this one
// function instead of repeating the connect/send/close dance.
async function withRoom(roomId, action) {
  const ws = await connectRoom(roomId);
  try {
    const initial = await sendAndAwait(ws, null);
    if (!action) return initial;
    return await sendAndAwait(ws, action);
  } finally {
    ws.close();
  }
}

// Condenses a full GameState for text output — card names + mana cost in hand, tapped/counters on
// battlefield, zone counts, recent log. Same shape as play.js's summarize()/describeCard(), ported
// since this file can't import from the SvelteKit app.
function summarizeState(state) {
  const cardInfo = state.cardInfo || {};
  const describeHand = (c) => {
    const info = cardInfo[c.name.toLowerCase()];
    return info?.manaCost ? `${c.name} ${info.manaCost}` : c.name;
  };
  const describeBattlefield = (c) => {
    const bits = [c.name];
    if (c.tapped) bits.push("(tapped)");
    if (c.counters && Object.keys(c.counters).length) {
      bits.push(`[${Object.entries(c.counters).map(([t, n]) => `${n} ${t}`).join(", ")}]`);
    }
    return bits.join(" ");
  };
  const players = {};
  for (const [seatId, p] of Object.entries(state.players || {})) {
    players[seatId] = {
      label: p.label,
      life: p.life,
      command: p.command.map((c) => c.name),
      hand: p.hand.map(describeHand),
      battlefield: p.battlefield.map(describeBattlefield),
      library_count: p.library.length,
      graveyard_count: p.graveyard.length,
      exile_count: p.exile.length,
      mulligans: p.mulligans,
    };
  }
  return {
    turn: state.turn,
    active: state.active,
    revision: state.revision,
    seats: state.seats,
    players,
    recent_log: state.log.slice(-8),
  };
}

// Pure port of play.js's parseDecklist — no fs dependency needed since the MCP tool receives
// pasted text directly as a param instead of a file path.
function parsePlaytestDecklist(text) {
  const lines = text.split(/\r?\n/);
  let section = "deck";
  const commanderNames = [];
  const deckEntries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)x?\s+(.+)$/i);
    if (!m) {
      const lower = line.toLowerCase();
      if (lower.startsWith("commander")) section = "commander";
      else if (lower.startsWith("sideboard")) section = "sideboard";
      else if (lower.startsWith("deck") || lower.startsWith("mainboard")) section = "deck";
      continue;
    }
    const qty = parseInt(m[1], 10);
    const name = m[2].trim();
    if (section === "commander") commanderNames.push(name);
    else if (section === "deck") deckEntries.push({ qty, name });
  }
  return { commanderNames, deckEntries };
}

// --- Combo detection for rate_deck_bracket --------------------------------------------------
// Finds combos that are FULLY assembled by a given decklist (every required piece present), not
// just combos that merely mention one of its cards. Commander Spellbook's exact query semantics
// aren't confirmed against live docs (same caveat as find_combos above) — empirically verified
// this session (live queries, not assumed): space-separated card:"X" card:"Y" is AND (matches
// find_combos' existing use, confirmed via the known Dramatic Reversal + Isochron Scepter combo).
// An "or" keyword is ACCEPTED but does NOT behave as boolean OR — two cards that individually
// return real results can combine via "or" into zero results, so it cannot be trusted to build a
// candidate set. The only semantics confirmed reliable is a single bare card:"X" term, so this
// queries one card at a time (one request per decklist card — slower than a batched OR would have
// been, but correct) and unions the results itself, then verifies correctness the same way
// regardless: a combo only survives if every one of its pieces (not just some) is present in the
// submitted decklist.
async function findCombosInDeck(allCardNames) {
  const nameSet = new Set(allCardNames.map((n) => n.toLowerCase()));
  const candidatesById = new Map();

  for (const name of allCardNames) {
    const query = `card:"${name}"`;
    const url = `${COMMANDER_SPELLBOOK_BASE}/variants/?q=${encodeURIComponent(query)}&limit=50`;
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) {
      const data = await res.json();
      for (const v of data?.results ?? []) {
        if (v.id) candidatesById.set(v.id, v);
      }
    }
    // best-effort — a single card's lookup failing shouldn't sink the whole rating
    await new Promise((r) => setTimeout(r, 60));
  }

  const fullyAssembled = [];
  for (const v of candidatesById.values()) {
    const pieces = (v.uses ?? []).map((u) => u.card?.name).filter(Boolean);
    if (pieces.length === 0) continue;
    const allPresent = pieces.every((p) => nameSet.has(p.toLowerCase()));
    if (allPresent) fullyAssembled.push({ id: v.id, pieces });
  }
  return fullyAssembled;
}

// Classifies each fully-assembled combo fast/slow by summing its pieces' mana values (one
// Scryfall collection batch call covering every combo piece across every combo at once).
async function classifyComboSpeed(combos) {
  if (combos.length === 0) return [];
  const allPieceNames = Array.from(new Set(combos.flatMap((c) => c.pieces)));
  const cmcByName = new Map();

  for (let i = 0; i < allPieceNames.length; i += 75) {
    const chunk = allPieceNames.slice(i, i + 75);
    const res = await scryfallFetch(`${SCRYFALL_BASE}/cards/collection`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
    }, "collection");
    if (!res.ok) continue;
    const data = await res.json();
    for (const card of data.data ?? []) {
      cmcByName.set(card.name.toLowerCase(), card.cmc ?? 0);
    }
  }

  return combos.map((c) => {
    const totalCmc = c.pieces.reduce((sum, name) => sum + (cmcByName.get(name.toLowerCase()) ?? 0), 0);
    return { pieces: c.pieces, total_cmc: totalCmc, speed: totalCmc <= FAST_COMBO_MAX_CMC ? "fast" : "slow" };
  });
}

// --- Hypergeometric helpers for analyze_deck_consistency's curve-out probability ------------
// nCr via an iterative running product/division rather than raw factorials — a 99-card library's
// factorial would still fit in a double, but the ratio-of-huge-numbers approach loses precision
// needlessly when this running-product form stays numerically small throughout.
function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

// P(at least `need` successes drawn in `draws` cards from a `librarySize`-card population
// containing `successes` total). Standard hypergeometric survival function.
function hypergeometricAtLeast(librarySize, successes, draws, need) {
  const upper = Math.min(draws, successes);
  if (need > upper) return 0;
  const total = combinations(librarySize, draws);
  if (total === 0) return 0;
  let sum = 0;
  for (let i = need; i <= upper; i++) {
    sum += (combinations(successes, i) * combinations(librarySize - successes, draws - i)) / total;
  }
  return sum;
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
    const res = await scryfallFetch(url, { headers: HEADERS }, "search");

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
    const res = await scryfallFetch(url, { headers: HEADERS }, "named");

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
    const cardRes = await scryfallFetch(`${SCRYFALL_BASE}/cards/named?exact=${encodeURIComponent(name)}`, { headers: HEADERS }, "named");
    if (!cardRes.ok) {
      return { content: [{ type: "text", text: `Card not found: ${name}` }] };
    }
    const card = await cardRes.json();

    const rulingsRes = await scryfallFetch(card.rulings_uri, { headers: HEADERS }, "default");
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

// --- Tool 11: playtest_list_games ---
server.tool(
  "playtest_list_games",
  "List every playtest table currently known to the playtest server's lobby, including each seat's controller (human/ai) and claim state. For rooms with an AI-controlled seat, also reports whose turn it is right now so you can tell which ones actually need an AI move vs. are just sitting idle. Talks to the deployed playtest server by default (no setup needed); set PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` instead — see extensions/README.md.",
  {
    only_needs_ai_move: z.boolean().optional().describe("If true, only include rooms where an AI-controlled seat is currently active. Default false (list every table)."),
  },
  async ({ only_needs_ai_move }) => {
    try {
      const res = await playtestFetch("/api/lobby");
      const rooms = await res.json();
      if (!res.ok || rooms.error) {
        return { content: [{ type: "text", text: `Lobby request failed: ${rooms.error || res.statusText}` }] };
      }

      const out = [];
      for (const room of rooms) {
        const hasAiSeat = room.seats.some((s) => s.controller === "ai");
        let active = null;
        let activeIsAi = false;
        if (hasAiSeat) {
          try {
            const { state } = await withRoom(room.roomId, null);
            const activeSeat = state.seats.find((s) => s.id === state.active);
            active = activeSeat ? { seat_id: activeSeat.id, label: activeSeat.label, controller: activeSeat.controller } : null;
            activeIsAi = activeSeat?.controller === "ai";
          } catch {
            active = null; // couldn't read this room's live state; still list it from the lobby summary
          }
        }
        if (only_needs_ai_move && !activeIsAi) continue;
        out.push({
          room_id: room.roomId,
          label: room.label,
          seats: room.seats,
          created_at: room.createdAt,
          active,
          needs_ai_move: activeIsAi,
        });
      }

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// --- Tool 12: playtest_create_table ---
server.tool(
  "playtest_create_table",
  "Create a new playtest table with 2 or more seats, each human- or AI-controlled. If the table includes at least one AI seat, EVERY seat (human included) is automatically given a random EDHREC average-build deck and a 7-card opening hand server-side immediately — no extra step needed before anyone can play. Tables with only human seats are left empty (no auto-deck). For the deck-delivery flow — a human vs. an AI opponent — call this with one human seat and one AI seat, then use playtest_load_deck to overwrite the human seat's auto-dealt deck with the actual deck just built; the AI seat's random deck stays as-is as the opponent. Returns a room id (for the other playtest_* tools) and a browser URL for anyone who wants to watch or play from the board UI. Talks to the deployed playtest server by default (no setup needed); set PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` instead.",
  {
    label: z.string().optional().describe("Display label for the table, e.g. 'Friday night EDH'. Default 'Untitled table'."),
    seats: z.array(z.object({
      label: z.string().describe("Seat display label, e.g. 'Alice' or 'AI opponent'"),
      controller: z.enum(["human", "ai"]).describe("If ANY seat in this table is 'ai', every seat (human included) is auto-decked (random EDHREC deck + opening hand) immediately — see the tool description."),
    })).min(2).describe("2 or more seats, in turn order — the first entry becomes seat0, the second seat1, etc."),
  },
  async ({ label, seats }) => {
    try {
      const res = await playtestFetch("/api/lobby", {
        method: "POST",
        headers: PLAYTEST_JSON_HEADERS,
        body: JSON.stringify({ label, seats }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        return { content: [{ type: "text", text: `Table creation failed: ${data.error || res.statusText}` }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ room_id: data.roomId, room_url: `${PLAYTEST_BASE}/room/${data.roomId}` }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// --- Tool 13: playtest_get_state ---
server.tool(
  "playtest_get_state",
  "Read the full current board state of a playtest table — every seat's life, hand (with mana cost inline), battlefield, library/graveyard/exile counts, and the recent game log. Use this to see what's happening before deciding a move with playtest_do_action. IMPORTANT: the returned `seats` array is how you know which seat_id to act on — each seat has `controller` ('human' or 'ai') and `label`. Before calling playtest_do_action, always confirm which seat you're actually meant to be playing (normally the one with controller:'ai') rather than assuming — acting on the wrong seat means playing someone else's cards for them. Talks to the deployed playtest server by default (no setup needed); set PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` instead.",
  {
    room_id: z.string().describe("Room id, from playtest_list_games or playtest_create_table"),
  },
  async ({ room_id }) => {
    try {
      const { state } = await withRoom(room_id, null);
      return { content: [{ type: "text", text: JSON.stringify(summarizeState(state), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// --- Tool 14: playtest_load_deck ---
server.tool(
  "playtest_load_deck",
  "Load a full Commander deck into one seat of an existing playtest table — either pasted decklist text (Moxfield-style export, e.g. lines like '1 Sol Ring' under an optional 'Commander' section header) or a random EDHREC average build (name a commander, or leave both decklist_text and commander_name blank for a random pick from a curated pool). Card names are resolved against Scryfall first, so every card in the resulting hand shows its real mana cost. Draws a fresh opening hand for that seat afterward by default. Talks to the deployed playtest server by default (no setup needed); set PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` instead.",
  {
    room_id: z.string().describe("Room id to load the deck into"),
    seat_id: z.string().describe("Seat id, e.g. 'seat0' — check playtest_get_state's `seats` array (controller + label per seat) first to confirm you're loading this deck onto the RIGHT seat, not just the first one listed."),
    decklist_text: z.string().optional().describe("Pasted decklist text. Provide this OR commander_name, not both — leave both blank for a fully random deck."),
    commander_name: z.string().optional().describe("Pull EDHREC's average decklist for this exact commander name. Leave blank (with decklist_text also blank) for a random commander from a curated pool."),
    auto_opening_hand: z.boolean().optional().describe("If true (default), draw a fresh 7-card opening hand for this seat right after loading."),
  },
  async ({ room_id, seat_id, decklist_text, commander_name, auto_opening_hand }) => {
    if (decklist_text && commander_name) {
      return { content: [{ type: "text", text: "Provide either decklist_text or commander_name, not both." }] };
    }
    try {
      let commanderNames, deckEntries, cardInfo, notFound, sourceLabel;

      if (decklist_text) {
        ({ commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text));
        if (!commanderNames.length && !deckEntries.length) {
          return { content: [{ type: "text", text: "No cards found in decklist_text — check the '<qty> <name>' formatting." }] };
        }
        const res = await playtestFetch("/api/resolve-deck", {
          method: "POST", headers: PLAYTEST_JSON_HEADERS,
          body: JSON.stringify({ commanderNames, deckEntries }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          return { content: [{ type: "text", text: `Deck resolution failed: ${data.error || res.statusText}` }] };
        }
        ({ cardInfo, notFound } = data);
        sourceLabel = "Imported deck";
      } else {
        const res = await playtestFetch("/api/random-deck", {
          method: "POST", headers: PLAYTEST_JSON_HEADERS,
          body: JSON.stringify(commander_name ? { commander: commander_name } : {}),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          return { content: [{ type: "text", text: `Random deck request failed: ${data.error || res.statusText}` }] };
        }
        ({ commander: commanderNames, deckEntries, cardInfo, notFound } = data);
        sourceLabel = `Random deck: EDHREC average build for "${data.sourceCommander}"`;
      }

      const wsActions = [{ type: "loadDeck", player: seat_id, commanderNames, deckEntries, cardInfo, sourceLabel }];
      if (auto_opening_hand !== false) wsActions.push({ type: "openingHand", player: seat_id });
      const finalAction = wsActions.length > 1 ? { type: "batch", actions: wsActions } : wsActions[0];
      const { state, batchErrors } = await withRoom(room_id, finalAction);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            loaded_for: seat_id,
            source: sourceLabel,
            not_found: notFound?.length ? notFound : undefined,
            batch_errors: batchErrors?.length ? batchErrors : undefined,
            state: summarizeState(state),
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// --- Tool 15: playtest_do_action ---
server.tool(
  "playtest_do_action",
  "Perform one game action on an existing playtest table's live board — move or tap a card, draw, shuffle, take a mulligan or opening hand, adjust life or a counter, add a card/token, remove a card, pass the turn, reset the board, permanently end the table, or run several of these as one batch. General-purpose escape hatch for everything except loading a full deck — use playtest_load_deck for that instead, since it handles the required Scryfall card-resolution step this tool does not. BEFORE YOUR FIRST ACTION IN A ROOM: call playtest_get_state and check its `seats` array to find which seat_id you're actually meant to be playing (its `controller` field is 'human' or 'ai', and `claimedBy` shows if a human has claimed it) — this tool has no way to know that for you, and it will happily let you move a human player's cards if you pass the wrong seat_id as `player`. Don't guess or default to the first seat listed. endTable is IRREVERSIBLE: it wipes the room's storage and removes it from the lobby list. For type 'batch', the 'actions' array uses the RAW wire field names (camelCase: cardName, fromZone, toZone, counterType — not this tool's own snake_case params), e.g. actions: [{\"type\":\"moveCard\",\"player\":\"seat0\",\"cardName\":\"Island\",\"fromZone\":\"hand\",\"toZone\":\"battlefield\"},{\"type\":\"toggleTap\",\"player\":\"seat0\",\"cardName\":\"Island\"},{\"type\":\"passTurn\"}]. Talks to the deployed playtest server by default (no setup needed); set PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` instead.",
  {
    room_id: z.string().describe("Room id this action applies to"),
    type: z.enum([
      "moveCard", "toggleTap", "draw", "shuffleLibrary", "openingHand", "mulligan",
      "adjustLife", "passTurn", "addCard", "removeCard", "adjustCounter",
      "resetTable", "endTable", "batch",
    ]).describe(
      "moveCard: player, card_name, from_zone, to_zone. toggleTap/removeCard: player, card_name " +
      "(removeCard also needs zone). draw/shuffleLibrary/openingHand/mulligan: player only. " +
      "adjustLife: player, delta (any integer). adjustCounter: player, card_name, counter_type, " +
      "delta (non-zero integer; zone optional, defaults battlefield). addCard: player, zone, name " +
      "(this is how tokens are created — any name works). passTurn/resetTable/endTable: no extra " +
      "fields. batch: actions (array of raw wire-format action objects, applied in order)."
    ),
    player: z.string().optional().describe("Seat id, e.g. 'seat0'. Required for every type except passTurn/resetTable/endTable/batch."),
    card_name: z.string().optional().describe("Card name, resolved server-side within from_zone (moveCard) or zone/battlefield (others)."),
    from_zone: z.enum(PLAYTEST_ZONES).optional().describe("moveCard only: zone the card is currently in"),
    to_zone: z.enum(PLAYTEST_ZONES).optional().describe("moveCard only: destination zone"),
    zone: z.enum(PLAYTEST_ZONES).optional().describe("addCard/removeCard/adjustCounter only (adjustCounter defaults to battlefield if omitted)"),
    name: z.string().optional().describe("addCard only: name of the card/token to create"),
    counter_type: z.string().optional().describe("adjustCounter only, e.g. '+1/+1', 'loyalty', 'poison'"),
    delta: z.number().int().optional().describe("adjustLife (can be negative) or adjustCounter (must be non-zero)"),
    actions: z.array(z.record(z.any())).optional().describe("batch only: array of action objects using RAW wire field names (type, player, cardName, fromZone, toZone, ...), applied in order against state as it exists after the previous one"),
  },
  async ({ room_id, type, player, card_name, from_zone, to_zone, zone, name, counter_type, delta, actions }) => {
    const action = { type };
    if (type === "batch") {
      action.actions = actions ?? [];
    } else {
      if (player !== undefined) action.player = player;
      if (card_name !== undefined) action.cardName = card_name;
      if (from_zone !== undefined) action.fromZone = from_zone;
      if (to_zone !== undefined) action.toZone = to_zone;
      if (zone !== undefined) action.zone = zone;
      if (name !== undefined) action.name = name;
      if (counter_type !== undefined) action.counterType = counter_type;
      if (delta !== undefined) action.delta = delta;
    }
    try {
      const { state, batchErrors } = await withRoom(room_id, action);
      if (state === null) {
        return { content: [{ type: "text", text: "Table ended." }] };
      }
      const errNote = batchErrors?.length
        ? `\n\nNote: ${batchErrors.length} sub-action(s) in this batch failed:\n` +
          batchErrors.map(({ action: a, error }) => `  ${JSON.stringify(a)} -> ${error}`).join("\n")
        : "";
      return { content: [{ type: "text", text: JSON.stringify(summarizeState(state), null, 2) + errNote }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// Shared by rate_deck_bracket and deliver_finished_deck so the bracket logic lives in one place.
async function computeBracketRating(commanderNames, cardNames) {
  const allNames = Array.from(new Set([...commanderNames, ...cardNames]));
  const allNamesLower = new Set(allNames.map((n) => n.toLowerCase()));

  const gameChangersFound = GAME_CHANGERS.filter((gc) => allNamesLower.has(gc.toLowerCase()));
  const mldFound = MASS_LAND_DENIAL_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));
  const extraTurnsFound = EXTRA_TURN_CARDS.filter((c) => allNamesLower.has(c.toLowerCase()));

  const rawCombos = await findCombosInDeck(allNames);
  const combosFound = await classifyComboSpeed(rawCombos);
  const hasFastCombo = combosFound.some((c) => c.speed === "fast");

  let bracketEstimate;
  let explanation;
  const confidenceNotes = [];

  if (gameChangersFound.length > 3 || hasFastCombo || mldFound.length > 0) {
    const reasons = [];
    if (gameChangersFound.length > 3) reasons.push(`${gameChangersFound.length} Game Changers (more than bracket 3's limit of 3)`);
    if (hasFastCombo) reasons.push("a fast (turn-6-or-earlier) infinite combo");
    if (mldFound.length > 0) reasons.push(`mass land denial (${mldFound.join(", ")})`);
    bracketEstimate = "Optimized (4) at minimum";
    explanation = `At least Bracket 4 (Optimized) due to: ${reasons.join("; ")}. Brackets 4-5 place no restrictions on these beyond the banned list.`;
    confidenceNotes.push(
      "Distinguishing Optimized (4) from cEDH (5) additionally requires tournament-proven meta " +
      "consistency and tuning, which no static card list can assess — treat 5 as a possibility " +
      "only if this deck is genuinely built/tuned against the current competitive meta."
    );
  } else if (gameChangersFound.length >= 1 || combosFound.length > 0) {
    const reasons = [];
    if (gameChangersFound.length >= 1) reasons.push(`${gameChangersFound.length} Game Changer(s) (within bracket 3's limit of 3)`);
    if (combosFound.length > 0) reasons.push(`${combosFound.length} combo(s) present, all classified 'slow' (turn 7+)`);
    bracketEstimate = "Upgraded (3)";
    explanation = `Bracket 3 (Upgraded): ${reasons.join("; ")}, and no mass land denial.`;
  } else {
    bracketEstimate = "Core (2) or below";
    explanation = "No Game Changers, no fully-assembled combos, and no mass land denial found — clears the bar for Bracket 2 (Core) or lower.";
    confidenceNotes.push(
      "Distinguishing Core (2) from Exhibition (1) is explicitly about intent in the official system " +
      "(house-ruling / self-expression / joke decks vs. baseline precon-level power), not card " +
      "composition — this tool can't determine that from a card list alone."
    );
  }

  if (extraTurnsFound.length > 0) {
    confidenceNotes.push(
      `${extraTurnsFound.length} extra-turn card(s) present (${extraTurnsFound.join(", ")}) — bracket rules ` +
      "care whether these are chained via untap/cost-reduction engines, which is a board-state question " +
      "this tool can't evaluate from a card list alone."
    );
  }

  return {
    bracket_estimate: bracketEstimate,
    explanation,
    confidence_notes: confidenceNotes,
    game_changers_found: gameChangersFound,
    mass_land_denial_found: mldFound,
    extra_turns_found: extraTurnsFound,
    combos_found: combosFound,
    data_current_as_of: "2026-02-09 Game Changers update",
  };
}

// --- Tool 16: rate_deck_bracket ---
server.tool(
  "rate_deck_bracket",
  "Rate a Commander decklist against the Commander Format Panel's official Bracket System (1-5: Exhibition, Core, Upgraded, Optimized, cEDH) — a deterministic, rule-based classifier, not a subjective guess. Checks the decklist against the official Game Changers list (0 allowed in brackets 1-2, up to 3 in bracket 3, unlimited in 4-5), detects fully-assembled infinite combos via Commander Spellbook and classifies each fast/slow by total mana value (bracket 3 bans 'cheap and early' combos), and checks for mass land denial (banned below bracket 4). IMPORTANT: the 1-vs-2 and 4-vs-5 boundaries are explicitly about play INTENT in the official system (self-expression/house-ruling vs. tournament-proven meta adherence), not card composition — this tool reports those as ranges rather than asserting false precision. Data current as of the Feb 9, 2026 Game Changers update; the list is reviewed roughly every 3-4 months, so re-verify if a rating seems off.",
  {
    commander_names: z.array(z.string()).min(1).describe("Exact commander name(s), e.g. ['Atraxa, Grand Unifier']"),
    card_names: z.array(z.string()).min(1).describe("Every other card in the decklist (99 cards for a standard Commander deck), exact names. Basic lands can be included or omitted — they never affect the rating."),
  },
  async ({ commander_names, card_names }) => {
    try {
      const result = await computeBracketRating(commander_names, card_names);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Bracket rating failed: ${e.message}` }] };
    }
  }
);

// --- Tool 17: get_moxfield_decklist ---
server.tool(
  "get_moxfield_decklist",
  "Fetch and parse a Commander decklist from a pasted Moxfield deck URL (or bare deck id). Returns the commander(s), the full mainboard, a ready-to-paste Moxfield-style decklist_text (drop it straight into playtest_load_deck's decklist_text param), and a flat card_names list (feed straight into rate_deck_bracket to check its power level, or get_deck_price_total to check its real cost). Source: Moxfield's own undocumented frontend API — no official public API exists, so this may break if Moxfield changes it without notice. KNOWN ISSUE: Moxfield's anti-bot protection sometimes blocks this request outright (403) even with realistic browser headers — if that happens, ask the user to paste the decklist text directly instead of retrying the URL, since rate_deck_bracket/playtest_load_deck both accept pasted text with no Moxfield fetch involved.",
  {
    url: z.string().describe("A Moxfield deck URL, e.g. 'https://www.moxfield.com/decks/J1bHQXIJ80W3_oWaufGk5Q', or just the bare deck id"),
  },
  async ({ url }) => {
    const match = url.match(/decks\/([^/?#]+)/);
    const deckId = match ? match[1] : url.trim();
    if (!deckId) {
      return { content: [{ type: "text", text: "Couldn't find a deck id in that URL." }] };
    }

    let res;
    try {
      res = await fetch(`${MOXFIELD_API_BASE}/${encodeURIComponent(deckId)}`, { headers: MOXFIELD_HEADERS });
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't reach Moxfield: ${e.message}. Paste the decklist text directly instead (rate_deck_bracket and playtest_load_deck both accept it).` }] };
    }
    if (res.status === 404) {
      return { content: [{ type: "text", text: `No Moxfield deck found at that URL (deck id: ${deckId}) — it may be private, deleted, or the URL/id may be wrong.` }] };
    }
    if (res.status === 403) {
      return {
        content: [{
          type: "text",
          text: "Moxfield blocked this request (its anti-bot protection sometimes rejects non-browser " +
            "requests, even with realistic headers — this isn't about this specific deck or URL). " +
            "Ask the user to paste the decklist text directly instead — both rate_deck_bracket " +
            "(card_names) and playtest_load_deck (decklist_text) accept a pasted list with no " +
            "Moxfield fetch required.",
        }],
      };
    }
    if (!res.ok) {
      return { content: [{ type: "text", text: `Moxfield request failed: ${res.status} ${res.statusText}` }] };
    }

    const data = await res.json();
    const commanderEntries = Object.values(data.commanders ?? {});
    const mainboardEntries = Object.values(data.mainboard ?? {});

    const commander_names = commanderEntries.map((e) => e.card?.name).filter(Boolean);
    const deckEntries = mainboardEntries
      .map((e) => ({ qty: e.quantity ?? 1, name: e.card?.name }))
      .filter((e) => e.name);
    const card_names = [...commander_names, ...deckEntries.map((e) => e.name)];

    const textLines = ["Commander", ...commander_names.map((n) => `1 ${n}`), "", "Deck", ...deckEntries.map((e) => `${e.qty} ${e.name}`)];

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          deck_name: data.name,
          format: data.format,
          commander_names,
          card_names,
          deck_entries: deckEntries,
          decklist_text: textLines.join("\n"),
          note: "decklist_text is ready to paste into playtest_load_deck's decklist_text param as-is. card_names is ready for rate_deck_bracket or get_deck_price_total.",
        }, null, 2),
      }],
    };
  }
);

// Shared by get_deck_price_total and deliver_finished_deck.
async function computeDeckPriceTotal(cardNames, includeFoil) {
  const res = await fetch(CARDKINGDOM_PRICELIST_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Card Kingdom pricelist request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const products = body?.data ?? [];

  // Cheapest non-foil (or foil, if allowed) in-stock price per card name, built once.
  const priceByName = new Map();
  for (const p of products) {
    const isFoil = p.is_foil === true || p.is_foil === "true";
    if (isFoil && !includeFoil) continue;
    const qty = Number(p.qty_retail ?? 0);
    if (qty <= 0) continue;
    const price = parseFloat(p.price_retail);
    if (isNaN(price)) continue;
    const nameLower = (p.name ?? "").toLowerCase();
    const existing = priceByName.get(nameLower);
    if (!existing || price < existing) priceByName.set(nameLower, price);
  }

  const priced = [];
  const notFound = [];
  for (const name of cardNames) {
    const price = priceByName.get(name.trim().toLowerCase());
    if (price === undefined) {
      notFound.push(name);
    } else {
      priced.push({ name, price_usd: price });
    }
  }

  const total = Math.round(priced.reduce((sum, c) => sum + c.price_usd, 0) * 100) / 100;

  return {
    total_usd: total,
    cards_priced: priced.length,
    cards_not_found: notFound.length ? notFound : undefined,
    note: notFound.length
      ? `${notFound.length} card(s) not found in Card Kingdom's in-stock pricelist — total_usd is a FLOOR, the real total is at least this much.`
      : "Every card was found and priced — total_usd should be the full, accurate deck cost.",
    breakdown: priced.sort((a, b) => b.price_usd - a.price_usd),
  };
}

// --- Tool 18: get_deck_price_total ---
server.tool(
  "get_deck_price_total",
  "Sum Card Kingdom's real retail price across an entire decklist in one call — the standardized price check for this server (see search_cards/get_cardkingdom_price for why Scryfall's bundled 'usd' field isn't used for this). Use this as a final check after ANY manual swap during deck-building, not just at the start — a card total can drift over budget silently if a swap's price isn't re-verified. Reports which cards (if any) weren't found in Card Kingdom's in-stock pricelist, since the total is necessarily a floor (not exact) when cards are missing.",
  {
    card_names: z.array(z.string()).min(1).describe("Every card in the decklist (commander + all nonland/land cards). Duplicate basic land names are fine — include a name once per copy if you want it priced per-copy, or once total if you only care about unique cards."),
    include_foil: z.boolean().optional().describe("If true, allow foil listings when finding each card's cheapest price. Default false (non-foil only)."),
  },
  async ({ card_names, include_foil }) => {
    try {
      const result = await computeDeckPriceTotal(card_names, include_foil);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }] };
    }
  }
);

// --- Tool 19: analyze_deck_consistency ---
server.tool(
  "analyze_deck_consistency",
  "Validate a Commander decklist's structural legality — exactly 100 cards total (commander(s) " +
  "included), singleton except basic lands, every card within the commander's color identity, " +
  "every card actually legal in Commander — and compute its mana curve plus a turn-by-turn " +
  "'curve-out' probability. A deterministic check against real Scryfall data, not an eyeballed " +
  "guess. Reuses the same Scryfall /cards/collection batch call this server already uses " +
  "elsewhere (classifyComboSpeed/resolveCardInfo), so validation and curve data come from one " +
  "fetch. Deliberately does NOT detect combos — that's rate_deck_bracket's job; call both " +
  "together for a complete final-delivery check (see CLAUDE.md's 'Deck-building final " +
  "deliverable' section). curve_out_probability is a SIMPLIFIED hypergeometric model (7-card " +
  "opening hand + 1 draw/turn) that does not account for mulligans, scry/surveil, card draw " +
  "spells, or ramp — treat it as a rough consistency signal, not a precise simulation.",
  {
    commander_names: z.array(z.string()).min(1).describe("Exact commander name(s), e.g. ['Atraxa, Grand Unifier']"),
    deck_entries: z.array(z.object({
      name: z.string(),
      qty: z.number().int().min(1),
    })).min(1).describe(
      "Every non-commander card with its quantity, e.g. {name:'Forest', qty:8}. Use qty:1 for " +
      "singleton nonbasics. Matches get_moxfield_decklist's deck_entries shape exactly — pipe " +
      "its output straight through with no reshaping."
    ),
  },
  async ({ commander_names, deck_entries }) => {
    try {
      const result = await computeDeckConsistency(commander_names, deck_entries);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            issues: result.issues.length ? result.issues : "No issues found — legal, correctly sized, and singleton-clean.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Deck consistency check failed: ${e.message}` }] };
    }
  }
);

// Shared by analyze_deck_consistency and deliver_finished_deck.
async function computeDeckConsistency(commander_names, deck_entries) {
      const uniqueDeckNames = Array.from(new Set(deck_entries.map((e) => e.name)));
      const allIdentifierNames = Array.from(new Set([...commander_names, ...uniqueDeckNames]));

      const cardByName = new Map();
      const notFound = [];
      for (let i = 0; i < allIdentifierNames.length; i += 75) {
        const chunk = allIdentifierNames.slice(i, i + 75);
        const res = await scryfallFetch(`${SCRYFALL_BASE}/cards/collection`, {
          method: "POST",
          headers: { ...HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
        }, "collection");
        if (!res.ok) {
          throw new Error(`Scryfall collection request failed: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        for (const card of data.data ?? []) {
          cardByName.set(card.name.toLowerCase(), card);
        }
        for (const nf of data.not_found ?? []) {
          if (nf?.name) notFound.push(nf.name);
        }
      }

      const isLand = (card) => (card?.type_line ?? "").includes("Land");
      const isBasicLand = (card) => (card?.type_line ?? "").includes("Basic Land");

      // Union across all commanders, not just the first — partner/background pairs combine identities.
      const commanderColorSet = new Set();
      for (const name of commander_names) {
        const card = cardByName.get(name.toLowerCase());
        for (const c of card?.color_identity ?? []) commanderColorSet.add(c);
      }

      const totalCards = commander_names.length + deck_entries.reduce((sum, e) => sum + e.qty, 0);
      const sizeWarning = totalCards !== 100
        ? `Deck has ${totalCards} total cards (commander(s) + library) — a standard Commander deck is exactly 100.`
        : null;

      const duplicateViolations = [];
      const colorIdentityViolations = [];
      const notCommanderLegal = [];
      let landCount = 0;
      let nonlandCount = 0;
      let nonlandCmcTotal = 0;
      const manaCurve = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7+": 0 };

      for (const entry of deck_entries) {
        const card = cardByName.get(entry.name.toLowerCase());
        if (!card) continue; // already reported via notFound

        if (entry.qty > 1 && !isBasicLand(card)) {
          duplicateViolations.push({ name: entry.name, qty: entry.qty });
        }

        const cardColors = card.color_identity ?? [];
        const offendingColors = cardColors.filter((c) => !commanderColorSet.has(c));
        if (offendingColors.length) {
          colorIdentityViolations.push({ name: entry.name, card_color_identity: cardColors, offending_colors: offendingColors });
        }

        if (card.legalities?.commander !== "legal") {
          notCommanderLegal.push({ name: entry.name, status: card.legalities?.commander ?? "unknown" });
        }

        if (isLand(card)) {
          landCount += entry.qty;
        } else {
          nonlandCount += entry.qty;
          nonlandCmcTotal += (card.cmc ?? 0) * entry.qty;
          const bucket = card.cmc >= 7 ? "7+" : String(Math.max(0, Math.round(card.cmc ?? 0)));
          manaCurve[bucket] = (manaCurve[bucket] ?? 0) + entry.qty;
        }
      }

      // Commander(s) themselves are also subject to the Commander-legal check (rare, but banned
      // commander-specific cards do exist) — they aren't in deck_entries so checked separately.
      for (const name of commander_names) {
        const card = cardByName.get(name.toLowerCase());
        if (card && card.legalities?.commander !== "legal") {
          notCommanderLegal.push({ name, status: card.legalities?.commander ?? "unknown" });
        }
      }

      const librarySize = totalCards - commander_names.length;
      const curveOutProbability = {};
      for (let turn = 1; turn <= 6; turn++) {
        const draws = Math.min(7 + turn, librarySize);
        curveOutProbability[`turn_${turn}`] = Math.round(hypergeometricAtLeast(librarySize, landCount, draws, turn) * 1000) / 1000;
      }

      const issues = [];
      if (sizeWarning) issues.push(sizeWarning);
      if (duplicateViolations.length) {
        issues.push(`Singleton violations: ${duplicateViolations.map((d) => `${d.name} x${d.qty}`).join(", ")}`);
      }
      if (colorIdentityViolations.length) {
        issues.push(`Outside commander's color identity: ${colorIdentityViolations.map((v) => v.name).join(", ")}`);
      }
      if (notCommanderLegal.length) {
        issues.push(`Not legal in Commander: ${notCommanderLegal.map((v) => `${v.name} (${v.status})`).join(", ")}`);
      }
      if (notFound.length) {
        issues.push(`Not found on Scryfall (check spelling): ${notFound.join(", ")}`);
      }

      return {
        issues,
        total_cards: totalCards,
        land_count: landCount,
        nonland_count: nonlandCount,
        avg_nonland_cmc: nonlandCount ? Math.round((nonlandCmcTotal / nonlandCount) * 100) / 100 : 0,
        mana_curve: manaCurve,
        curve_out_probability: {
          note: "Simplified model: 7-card opening hand + 1 draw/turn, no mulligans/scry/ramp/card-draw " +
            "spells modeled. turn_N is the probability of having drawn at least N lands by turn N.",
          ...curveOutProbability,
        },
        duplicate_violations: duplicateViolations,
        color_identity_violations: colorIdentityViolations,
        not_commander_legal: notCommanderLegal,
        not_found: notFound,
        commander_color_identity: Array.from(commanderColorSet),
      };
}

// --- Tool 20: deliver_finished_deck ---
server.tool(
  "deliver_finished_deck",
  "The single required final step for ANY finished Commander decklist — built via build_budget_deck, " +
  "assembled manually, or fetched via get_moxfield_decklist. Runs the deck through all three " +
  "deterministic pre-delivery checks (analyze_deck_consistency, rate_deck_bracket, get_deck_price_total) " +
  "in one call, then — only if the deck comes back structurally clean — creates a playtest table (one " +
  "human seat, one AI seat, labeled with deck_name), loads this exact decklist into the human seat, and " +
  "returns a single ready-to-paste final_delivery_text: the decklist block, a fixed-format summary table " +
  "(Price / Commander + color identity / Bracket Power / Combo list / Wincon(s) / General strategy), and " +
  "the playtest room_url, in that exact order. This is the one place that final format is defined — paste " +
  "final_delivery_text to the user as-is rather than re-assembling it by hand. If analyze_deck_consistency " +
  "finds ANY issue (wrong card count, a singleton violation, an off-color card, something not " +
  "Commander-legal), this returns those issues instead of a delivery — it deliberately does NOT create a " +
  "playtest table for a broken deck. Fix the decklist and call this again; only a clean deck produces a " +
  "final_delivery_text. wincon_summary and general_strategy require actual judgment about the deck (this " +
  "tool only asserts what a card list mechanically implies, it can't write these for you) — but this " +
  "response's bracket.combos_found is computed fresh inside this same call and may surface combos you " +
  "didn't know about when drafting wincon_summary; if the two disagree, rewrite wincon_summary and call " +
  "this again before showing anything to the user.",
  {
    deck_name: z.string().describe("The actual deck's name/theme, e.g. 'Edgar Markov Vampire Tribal' — used as the playtest table's label. Never 'Untitled table'."),
    decklist_text: z.string().describe("Full decklist as a 'Commander' section then a blank line then a 'Deck' section, one '<qty> <name>' per line — the same format get_moxfield_decklist's decklist_text produces and playtest_load_deck's decklist_text param accepts."),
    wincon_summary: z.string().describe("How this deck actually wins. If rate_deck_bracket (run inside this call) finds combos, name the piece(s) and a turn-speed estimate; otherwise describe the deck's primary non-combo game plan."),
    general_strategy: z.string().describe("A short paragraph on how to actually pilot the deck turn to turn."),
  },
  async ({ deck_name, decklist_text, wincon_summary, general_strategy }) => {
    const { commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text);
    if (!commanderNames.length || !deckEntries.length) {
      return {
        content: [{
          type: "text",
          text: "Couldn't parse a commander and deck from decklist_text — check the 'Commander' / 'Deck' section headers and '<qty> <name>' line formatting.",
        }],
      };
    }

    const uniqueDeckNames = Array.from(new Set(deckEntries.map((e) => e.name)));
    const allCopiesNames = [...commanderNames, ...deckEntries.flatMap((e) => Array(e.qty).fill(e.name))];

    let consistency, bracket, price;
    try {
      [consistency, bracket, price] = await Promise.all([
        computeDeckConsistency(commanderNames, deckEntries),
        computeBracketRating(commanderNames, uniqueDeckNames),
        computeDeckPriceTotal(allCopiesNames, false),
      ]);
    } catch (e) {
      return { content: [{ type: "text", text: `Pre-delivery checks failed: ${e.message}` }] };
    }

    if (consistency.issues.length) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            blocked: true,
            reason: "analyze_deck_consistency found issues — fix the decklist and call deliver_finished_deck again. No playtest table was created.",
            consistency,
            bracket,
            price,
          }, null, 2),
        }],
      };
    }

    let roomId, roomUrl;
    try {
      const lobbyRes = await playtestFetch("/api/lobby", {
        method: "POST",
        headers: PLAYTEST_JSON_HEADERS,
        body: JSON.stringify({
          label: deck_name,
          seats: [
            { label: "You", controller: "human" },
            { label: "AI opponent", controller: "ai" },
          ],
        }),
      });
      const lobbyData = await lobbyRes.json();
      if (!lobbyRes.ok || lobbyData.error) {
        throw new Error(lobbyData.error || lobbyRes.statusText);
      }
      roomId = lobbyData.roomId;
      roomUrl = `${PLAYTEST_BASE}/room/${roomId}`;

      const resolveRes = await playtestFetch("/api/resolve-deck", {
        method: "POST",
        headers: PLAYTEST_JSON_HEADERS,
        body: JSON.stringify({ commanderNames, deckEntries }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || resolveData.error) {
        throw new Error(resolveData.error || resolveRes.statusText);
      }

      await withRoom(roomId, {
        type: "batch",
        actions: [
          {
            type: "loadDeck", player: "seat0", commanderNames, deckEntries,
            cardInfo: resolveData.cardInfo, sourceLabel: deck_name,
          },
          { type: "openingHand", player: "seat0" },
        ],
      });
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: `Deck passed all checks, but the playtest table couldn't be created: ${e.message}\n\n` +
            `Checks:\n${JSON.stringify({ consistency, bracket, price }, null, 2)}`,
        }],
      };
    }

    const commanderLabel = `${commanderNames.join(" / ")} (${consistency.commander_color_identity.length ? consistency.commander_color_identity.join("/") : "Colorless"})`;
    const comboLabel = bracket.combos_found.length
      ? bracket.combos_found.map((c) => `${c.pieces.join(" + ")} (${c.speed})`).join("; ")
      : "None";

    const finalDeliveryText =
      `${decklist_text.trim()}\n\n` +
      `| | |\n|---|---|\n` +
      `| **Price** | $${price.total_usd.toFixed(2)} (Card Kingdom) |\n` +
      `| **Commander** | ${commanderLabel} |\n` +
      `| **Bracket Power** | ${bracket.bracket_estimate} |\n` +
      `| **Combo list** | ${comboLabel} |\n` +
      `| **Wincon(s)** | ${wincon_summary} |\n` +
      `| **General strategy** | ${general_strategy} |\n\n` +
      `${roomUrl}`;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          final_delivery_text: finalDeliveryText,
          room_id: roomId,
          room_url: roomUrl,
          consistency,
          bracket,
          price,
        }, null, 2),
      }],
    };
  }
);

// --- Start the server over stdio ---
const transport = new StdioServerTransport();
await server.connect(transport);