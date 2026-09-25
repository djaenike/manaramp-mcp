/**
 * tools/shared/arena-local-state.ts
 *
 * Local-machine state shared by BOTH Arena tools (arena_draft_assistance / arena_draft_game_advice)
 * -- grpId->card disk cache and remembered player_log_path/user_id settings. Factored into one
 * shared module (rather than duplicated per tool file) because a grpId resolved during a draft
 * needs to still be cache-hit during that same match's game-advice calls, and both tools need the
 * SAME remembered player_log_path.
 *
 * The card_ratings CSV drop-in folder that used to live here was removed 2026-09-17 -- superseded
 * by arena_draft_assistance's remote format_stats_manaramp lookup (real 17Lands data straight from
 * manaramp's own database, no manual export needed now that a MANARAMP_API_KEY is required to
 * activate this extension at all -- see manifest.json's user_config).
 *
 * This is deliberately kept under tools/, not local/, even though everything in this file is a real
 * disk/filesystem concern: arena_draft_assistance and arena_draft_game_advice are THE two tools that
 * are fundamentally local-machine-only forever (they read a local Player.log via fs.statSync/
 * readSync -- see functions/arena-log/log_reader.ts) and were already called out in the repo's
 * conversion plan as never being part of a future remote transport's tool set, unlike the other 6
 * tools in tools/. Keeping their local-only state next to them (rather than awkwardly injected from
 * local/index.ts through the flat, uniform tool-registration loop there) keeps that loop simple and
 * keeps this module's existence self-explanatory. A future remote transport simply won't import
 * arena-draft-assistance.ts / arena-draft-game-advice.ts (or this module) at all.
 *
 * Paths below are resolved relative to the PACKAGE ROOT (not this file's own directory) via a fixed
 * upward walk, so grpid_cache.json / arena_settings.json end up in the same place they always have
 * (next to package.json, at the repo root) regardless of whether this runs from src/ (tsx, dev) or
 * dist/ (built) -- both sit exactly 3 directories below the package root (src/tools/shared or
 * dist/tools/shared), so a fixed "../../.." is stable across both.
 *
 * CORRECTION 2026-09-18: every path/cache computation here MUST be lazy (computed on first actual
 * use, not at module top level) -- confirmed live via `wrangler dev`'s real Workers runtime
 * (workerd), which is what actually surfaced this: manaramp's remote /mcp Worker crashed on EVERY
 * request, `TypeError: The "path" argument must be of type string or an instance of URL. Received
 * undefined`, thrown from `fileURLToPath(import.meta.url)` -- Workers bundles everything into one
 * script with no real file:// URL for `import.meta.url`, so this threw the instant the module was
 * evaluated, regardless of whether an Arena tool was ever actually called. That's the trap: even
 * though the two Arena tools are local-only and never REGISTERED remotely (see this file's own
 * header above), manaramp-mcp's `tools` barrel unconditionally IMPORTS every tool file to build
 * its exported array, so this module's top-level code ran (and crashed) on the Worker regardless.
 * Plain `vite dev`/`tsx` never caught this because both run on real Node, where `import.meta.url`
 * is a genuine file path -- only the actual Workers runtime (`wrangler dev`/deployed prod) exposed
 * it. Every export below is now a memoized getter instead of an eagerly-computed top-level
 * constant, so nothing here runs until an Arena tool handler genuinely calls it.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSettings, saveSettings } from "../../functions/parsing/settings.js";
import type { ResolvedCard } from "../../functions/parsing/grpid_resolver.js";

let packageRoot: string | undefined;
function getPackageRoot(): string {
  return (packageRoot ??= join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
}

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
function getCardCacheDir(): string {
  return join(getPackageRoot(), "card_cache");
}

function getGrpIdCachePath(): string {
  return join(getCardCacheDir(), "grpid_cache.json");
}

function loadGrpIdCache(): Map<number, ResolvedCard> {
  const cache = new Map<number, ResolvedCard>();
  try {
    const raw = JSON.parse(readFileSync(getGrpIdCachePath(), "utf8"));
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
    mkdirSync(getCardCacheDir(), { recursive: true });
    writeFileSync(getGrpIdCachePath(), JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
    // Best-effort -- a failed disk write shouldn't break the response; the in-memory cache still
    // helps for the rest of this process's life either way.
  }
}

let grpIdCardCache: Map<number, ResolvedCard> | undefined;
function getGrpIdCardCache(): Map<number, ResolvedCard> {
  return (grpIdCardCache ??= loadGrpIdCache());
}

/** Runs a grpId-resolving call, then persists the cache to disk ONLY if it actually grew. */
async function withPersistentGrpIdCache<T>(resolveFn: (cache: Map<number, ResolvedCard>) => Promise<T>): Promise<T> {
  const cache = getGrpIdCardCache();
  const sizeBefore = cache.size;
  const result = await resolveFn(cache);
  if (cache.size > sizeBefore) saveGrpIdCache(cache);
  return result;
}

// Batched grpId -> real card resolution via manaramp's own Mongo-backed query_cards tool, over
// the authenticated remote client (2026-09-17, second pass -- see CLAUDE.md's "Arena tools reach
// manaramp too now" section) -- NOT a live Scryfall call anymore, unlike the original design.
// Arena tools have no direct Mongo connection of their own (see tools/types.ts's McpContext
// header), so this is the one remote round trip that resolves a whole batch of still-unresolved
// grpIds at once (see grpid_resolver.ts's BatchResolveFn contract).
async function resolveGrpIdsViaManaramp(grpIds: number[]): Promise<Map<number, ResolvedCard>> {
  const { callRemoteTool } = await import("./remote-client.js");
  const cards = await callRemoteTool<Array<{ arena_grp_ids: number[] } & Record<string, unknown>>>(
    "query_cards",
    // detail: "full" -- the compact default (2026-09-25) drops arena_grp_ids, which the mapping
    // below needs, and this cache wants the complete record anyway. Token cost is controlled where
    // cards are shown to the model instead (see arena-card-view.ts), not here.
    { arena_grp_ids: grpIds, detail: "full" }
  );
  const byGrpId = new Map<number, ResolvedCard>();
  const wanted = new Set(grpIds);
  for (const card of cards) {
    for (const id of card.arena_grp_ids ?? []) {
      if (wanted.has(id)) byGrpId.set(id, card);
    }
  }
  return byGrpId;
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
function getSettingsPath(): string {
  return process.env.SCRYFALL_MCP_SETTINGS_PATH || join(getPackageRoot(), "arena_settings.json");
}

// manaramp's MCP Setup page (manaramp.com/mcp-setup) lets a user save their Player.log path ONCE,
// server-side, instead of pasting it into a Claude conversation (2026-09-17). This is a plain
// Bearer-authenticated REST GET, NOT an MCP tool call (see that route's own header for why:
// mcp_keys lives under the full-access MONGODB_URI, a trust tier manaramp-mcp's own McpContext
// never gets access to) -- so this hits it directly with fetch, not callRemoteTool.
const MANARAMP_SETTINGS_URL = process.env.MANARAMP_SETTINGS_URL || "https://manaramp.com/api/mcp-settings";

/** Best-effort: returns null on ANY failure (no API key configured, network error, account has
 *  none saved) -- the caller's existing "ask the user in-chat" fallback already handles null fine,
 *  so this never needs to surface an error of its own. */
async function fetchPlayerLogPathFromManaramp(): Promise<string | null> {
  const apiKey = process.env.MANARAMP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(MANARAMP_SETTINGS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { player_log_path?: string | null };
    return body.player_log_path ?? null;
  } catch {
    return null;
  }
}

// Windows' own "Copy as path" wraps the result in double quotes -- harmless to look at, but
// fs.statSync/fs.openSync (log_reader.ts) treat the quote characters as part of the literal path
// and fail outright, since quoting is a shell/clipboard convention, not a filesystem one. A user is
// just as likely to paste that straight into a Claude conversation (providedPath below) as to type
// it into the website form (manaramp/src/lib/server/mcp-keys/index.ts's setPlayerLogPath does the
// same stripping server-side) -- sanitize both entry points independently rather than assuming one
// or the other is authoritative.
function stripWrappingQuotes(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Resolves player_log_path for a call, in order: (1) whatever was explicitly passed wins, and gets
 * remembered locally for next time; (2) whatever was last remembered on THIS machine; (3) whatever
 * the user saved on manaramp.com/mcp-setup, fetched ONCE over the network and immediately cached
 * locally so every later call stays on the fast local-only path above -- closes the loop the
 * original design intended (configure it on the website, not in a Claude conversation). Returns
 * null only if none of the three produced anything (first-ever call, nothing saved anywhere).
 */
async function resolvePlayerLogPath(providedPath?: string | null): Promise<string | null> {
  const settingsPath = getSettingsPath();
  if (providedPath) {
    const sanitized = stripWrappingQuotes(providedPath);
    if (sanitized !== loadSettings(settingsPath).player_log_path) {
      saveSettings(settingsPath, { player_log_path: sanitized });
    }
    return sanitized;
  }

  const remembered = loadSettings(settingsPath).player_log_path;
  if (remembered) return remembered;

  // Re-stripped here too (2026-09-19), not just trusting the server already did it -- same
  // independent-entry-point reasoning as the providedPath branch above (see stripWrappingQuotes's
  // own header): belt-and-suspenders against a value that reached mcp_keys before manaramp's own
  // read/write-side stripping existed, so this machine's local cache never gets seeded with quotes
  // even if the server response somehow still has them.
  const fromServer = await fetchPlayerLogPathFromManaramp();
  if (fromServer) {
    const sanitized = stripWrappingQuotes(fromServer);
    saveSettings(settingsPath, { player_log_path: sanitized });
    return sanitized;
  }
  return null;
}

/**
 * Returns a stable, anonymous per-install identifier -- generated once and persisted in the same
 * arena_settings.json this whole module already uses for player_log_path, then reused forever
 * after. NOT what identifies a push_draft_result/push_game_log call to manaramp -- those are
 * identified by the real, authenticated ownerUserId resolved server-side from MANARAMP_API_KEY
 * (see tools/push-draft-result.ts / push-game-log.ts), superseding the anonymous-UUID design this
 * was originally built for (the old draft_sessions.ts schema in the `manaramp` repo, since
 * replaced). Currently unused by any real tool handler -- kept as a tested utility, re-exported
 * from local/index.ts for tests only.
 */
function getOrCreateUserId(): string {
  const settingsPath = getSettingsPath();
  const existing = loadSettings(settingsPath).user_id;
  if (existing) return existing;
  // Global Web Crypto (no import needed -- stable global since Node 19) rather than
  // node:crypto's randomUUID import.
  const userId = crypto.randomUUID();
  saveSettings(settingsPath, { user_id: userId });
  return userId;
}

export {
  getCardCacheDir, getGrpIdCachePath, getGrpIdCardCache, withPersistentGrpIdCache,
  resolveGrpIdsViaManaramp, getSettingsPath, resolvePlayerLogPath, getOrCreateUserId,
};
