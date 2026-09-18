import { ResolvedCard } from '../../functions/parsing/grpid_resolver.js';

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

declare function getCardCacheDir(): string;
declare function getGrpIdCachePath(): string;
declare function getGrpIdCardCache(): Map<number, ResolvedCard>;
/** Runs a grpId-resolving call, then persists the cache to disk ONLY if it actually grew. */
declare function withPersistentGrpIdCache<T>(resolveFn: (cache: Map<number, ResolvedCard>) => Promise<T>): Promise<T>;
declare function resolveGrpIdsViaManaramp(grpIds: number[]): Promise<Map<number, ResolvedCard>>;
declare function getSettingsPath(): string;
/**
 * Resolves player_log_path for a call, in order: (1) whatever was explicitly passed wins, and gets
 * remembered locally for next time; (2) whatever was last remembered on THIS machine; (3) whatever
 * the user saved on manaramp.com/mcp-setup, fetched ONCE over the network and immediately cached
 * locally so every later call stays on the fast local-only path above -- closes the loop the
 * original design intended (configure it on the website, not in a Claude conversation). Returns
 * null only if none of the three produced anything (first-ever call, nothing saved anywhere).
 */
declare function resolvePlayerLogPath(providedPath?: string | null): Promise<string | null>;
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
declare function getOrCreateUserId(): string;

export { getCardCacheDir, getGrpIdCachePath, getGrpIdCardCache, getOrCreateUserId, getSettingsPath, resolveGrpIdsViaManaramp, resolvePlayerLogPath, withPersistentGrpIdCache };
