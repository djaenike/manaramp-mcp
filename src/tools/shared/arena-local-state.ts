/**
 * tools/shared/arena-local-state.ts
 *
 * Local-machine state shared by BOTH Arena tools (arena_draft_assistance / arena_draft_game_advice)
 * -- grpId->card disk cache, remembered player_log_path/user_id settings, and the card_ratings CSV
 * drop-in folder. Factored into one shared module (rather than duplicated per tool file) because a
 * grpId resolved during a draft needs to still be cache-hit during that same match's game-advice
 * calls, and both tools need the SAME remembered player_log_path.
 *
 * This is deliberately kept under tools/, not local/, even though everything in this file is a real
 * disk/filesystem concern: arena_draft_assistance and arena_draft_game_advice are THE two tools that
 * are fundamentally local-machine-only forever (they read a local Player.log via fs.statSync/
 * readSync -- see sub-tools/arena-log/log_reader.ts) and were already called out in the repo's
 * conversion plan as never being part of a future remote transport's tool set, unlike the other 6
 * tools in tools/. Keeping their local-only state next to them (rather than awkwardly injected from
 * local/index.ts through the flat, uniform tool-registration loop there) keeps that loop simple and
 * keeps this module's existence self-explanatory. A future remote transport simply won't import
 * arena-draft-assistance.ts / arena-draft-game-advice.ts (or this module) at all.
 *
 * Paths below are resolved relative to the PACKAGE ROOT (not this file's own directory) via a fixed
 * upward walk, so grpid_cache.json / arena_settings.json / card_ratings/ end up in the same place
 * they always have (next to package.json, at the repo root) regardless of whether this runs from
 * src/ (tsx, dev) or dist/ (built) -- both sit exactly 3 directories below the package root
 * (src/tools/shared or dist/tools/shared), so a fixed "../../.." is stable across both.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSettings, saveSettings } from "../../sub-tools/arena-log/settings.js";
import type { CardRatingRow } from "../../sub-tools/arena-log/card_ratings.js";
import { searchCards } from "../../sub-tools/scryfall/cards.js";
import type { ResolvedCard } from "../../sub-tools/arena-log/grpid_resolver.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// --- grpId -> card cache, persisted to disk ------------------------------------------------
// A grpId always maps to the same real card (or, for a genuine miss, permanently maps to nothing)
// -- that's a fact about Scryfall's data, not about any one draft/game/session, so it's safe (and
// valuable) to cache forever, not just for one process's lifetime. Real-draft bug fix: without
// ANY cache, arena_draft_assistance re-resolved every previously-picked card on every single call
// (cost growing without bound as the draft went on), which is what actually caused both the "gets
// steadily slower" symptom and several transient lookup failures under the resulting request
// burst (see grpid_resolver.ts's header comment for the full story). An in-memory-only Map fixes
// that within one running server process, but a restart (computer reboot, Claude Desktop fully
// quitting, an MCP server crash) would silently wipe it and go back to fetching everything fresh
// -- so this is backed by a JSON file next to the package root (like card_ratings/) that only ever
// grows, shared by BOTH Arena tools and every draft/game/log path this server ever sees. Same
// "flat file until you set up SQL" stopgap as card_ratings/, deliberately.
const CARD_CACHE_DIR = join(PACKAGE_ROOT, "card_cache");
const GRPID_CACHE_PATH = join(CARD_CACHE_DIR, "grpid_cache.json");

function loadGrpIdCache(): Map<number, ResolvedCard> {
  const cache = new Map<number, ResolvedCard>();
  try {
    const raw = JSON.parse(readFileSync(GRPID_CACHE_PATH, "utf8"));
    for (const [grpId, card] of Object.entries(raw)) {
      cache.set(Number(grpId), card as ResolvedCard);
    }
  } catch {
    // No cache file yet (first run) or it's unreadable -- start empty. This is a derived,
    // fully-rebuildable cache; a missing/corrupt file is never a reason to fail startup.
  }
  return cache;
}

function saveGrpIdCache(cache: Map<number, ResolvedCard>): void {
  try {
    mkdirSync(CARD_CACHE_DIR, { recursive: true });
    writeFileSync(GRPID_CACHE_PATH, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
    // Best-effort -- a failed disk write shouldn't break the response; the in-memory cache still
    // helps for the rest of this process's life either way.
  }
}

const grpIdCardCache = loadGrpIdCache();

/** Runs a grpId-resolving call, then persists the cache to disk ONLY if it actually grew. */
async function withPersistentGrpIdCache<T>(resolveFn: (cache: Map<number, ResolvedCard>) => Promise<T>): Promise<T> {
  const sizeBefore = grpIdCardCache.size;
  const result = await resolveFn(grpIdCardCache);
  if (grpIdCardCache.size > sizeBefore) saveGrpIdCache(grpIdCardCache);
  return result;
}

// Batched grpId -> real card resolution via this server's own search_cards, reused by both
// Arena tools. arena_id:<id> confirmed live against Scryfall's search syntax.
async function searchCardsForResolver(query: string) {
  return searchCards(query);
}

// --- Locally-remembered settings (machine-specific -- gitignored, unlike card_ratings/ or
// card_cache/) ---------------------------------------------------------------------------------
// player_log_path is a real absolute path on THIS machine specifically -- it has no business
// being committed to git (it wouldn't even be valid on a different computer). Remembering it
// here fixes a real recurring annoyance: Claude has no memory of a PRIOR conversation's tool-call
// arguments, so without server-side persistence the user has to retype this same path every
// single new conversation, even the day right after they already gave it once.
// SCRYFALL_MCP_SETTINGS_PATH override exists so tests never read/write the real settings file
// (same reasoning as SCRYFALL_MCP_REPORTS_DIR in tools/shared/run-checks-and-deliver.ts).
const SETTINGS_PATH = process.env.SCRYFALL_MCP_SETTINGS_PATH || join(PACKAGE_ROOT, "arena_settings.json");

/**
 * Resolves player_log_path for a call: whatever was explicitly passed wins (and gets remembered
 * for next time); otherwise falls back to whatever was last remembered. Returns null if neither
 * is available (first-ever call, nothing provided).
 */
function resolvePlayerLogPath(providedPath?: string | null): string | null {
  if (providedPath) {
    if (providedPath !== loadSettings(SETTINGS_PATH).player_log_path) {
      saveSettings(SETTINGS_PATH, { player_log_path: providedPath });
    }
    return providedPath;
  }
  return loadSettings(SETTINGS_PATH).player_log_path ?? null;
}

/**
 * Returns a stable, anonymous per-install identifier (for the not-yet-built shared MongoDB
 * contribution scheme -- see the `manaramp` repo's src/lib/server/schema/draft_sessions.ts,
 * the schema's one canonical copy) -- generated once and persisted in the same
 * arena_settings.json this whole module already uses for player_log_path, then reused forever
 * after. There's no "on install" hook in the .mcpb/desktop extension format itself (checked the
 * manifest spec directly -- it's purely declarative, no lifecycle scripts), so this is triggered
 * by first actual need rather than the literal install moment; the practical result is identical
 * either way, since nothing observable depends on WHEN it's generated, only that it stays the
 * same after. Deliberately anonymous (a random UUID, not tied to any real identity) -- see the
 * open trust-model question already flagged in that schema file's own comment before this is
 * wired into anything that writes to a shared database for real.
 */
function getOrCreateUserId(): string {
  const existing = loadSettings(SETTINGS_PATH).user_id;
  if (existing) return existing;
  // Global Web Crypto (no import needed -- stable global since Node 19) rather than
  // node:crypto's randomUUID import.
  const userId = crypto.randomUUID();
  saveSettings(SETTINGS_PATH, { user_id: userId });
  return userId;
}

// --- Card ratings drop-in folder --------------------------------------------------------------
// Unlike REPORTS_DIR (tools/shared/run-checks-and-deliver.ts), this one deliberately stays at the
// package root: the point is "drop a 17Lands CSV export in the same folder as the server" rather
// than remembering/typing a path each time, which arena_draft_assistance falls back to
// auto-discovering (most recently modified .csv wins) when card_ratings_csv_path isn't given
// explicitly. A temporary stand-in for a real store (SQLite, etc.) -- fine for "one file, swap it
// when you re-export," not meant to scale past that.
const CARD_RATINGS_DIR = join(PACKAGE_ROOT, "card_ratings");
try { mkdirSync(CARD_RATINGS_DIR, { recursive: true }); } catch { /* best-effort; handled again on use */ }

const cardRatingsCache = new Map<string, Map<string, CardRatingRow>>();

export {
  CARD_CACHE_DIR, GRPID_CACHE_PATH, grpIdCardCache, withPersistentGrpIdCache,
  searchCardsForResolver, SETTINGS_PATH, resolvePlayerLogPath, getOrCreateUserId,
  CARD_RATINGS_DIR, cardRatingsCache,
};
