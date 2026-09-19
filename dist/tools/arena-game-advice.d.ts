import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/arena-draft-game-advice.ts -- Tool 8: arena_draft_game_advice
 * Sequence: read new Player.log lines (separate offset stream from the draft tool, same file) ->
 * parse GRE match events into a turn-by-turn timeline -> resolve every grpId referenced in it to
 * real card data via manaramp's own `cards` collection (arena_grp_ids field), over the
 * authenticated remote query_cards call -- NOT live Scryfall (removed 2026-09-17, second pass,
 * see tools/shared/arena-local-state.ts's resolveGrpIdsViaManaramp). Internally exercises:
 * arena-log/log_reader, arena-log/gre_match_parser, arena-log/grpid_resolver -> remote-client.
 *
 * Fundamentally local-machine-only (reads a local Player.log file, same as arena-draft-assistance.ts)
 * -- will never be part of a future remote MCP transport's tool set (see
 * tools/shared/arena-local-state.ts's header comment), unlike tools/shared/deck-analysis.ts (optimize_deck/publish_deck).
 *
 * Pushes the full match log to manaramp's game_logs collection (2026-09-17) the moment a
 * "matchResult" event appears -- via tools/internal-tools.ts's push_game_log wrapper (->
 * functions/push/game-log.ts), reached over tools/shared/remote-client.ts, using
 * MANARAMP_API_KEY (manifest.json's user_config). Accumulates every enriched event across calls in
 * `fullTimeline` specifically for this (each call only returns what's NEW since the last one, but
 * the push needs the WHOLE match) -- reset once pushed, so the next match starts a fresh log.
 * Silently skipped (this tool still returns its normal timeline either way) if no key is
 * configured -- see push_error/pushed_game_log_id in the response for what happened.
 */

declare const inputSchema: {
    player_log_path: z.ZodOptional<z.ZodString>;
};
declare const arenaDraftGameAdviceTool: ToolDefinition<typeof inputSchema>;

export { arenaDraftGameAdviceTool };
