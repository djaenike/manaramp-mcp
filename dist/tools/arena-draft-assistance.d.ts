import { z } from 'zod';
import { ToolDefinition } from './types.js';
import 'mongodb';

/**
 * tools/arena-draft-assistance.ts -- Tool 7: arena_draft_assistance
 * Sequence: read new Player.log lines (offset persisted per path across calls) -> parse draft
 * pack/pick events (Premier/Quick format detection, P1P1 special case) -> resolve every card id
 * in the current pack to real card data via manaramp's own `cards` collection (arena_grp_ids
 * field), over the authenticated remote query_cards call -> push the accumulated picks/pack
 * history to manaramp's draft_results collection. Internally exercises: arena-log/log_reader,
 * arena-log/draft_log_parser, arena-log/grpid_resolver -> tools/shared/remote-client.
 *
 * Fundamentally local-machine-only (reads a local Player.log file via fs.statSync/readSync in
 * functions/parsing/log_reader.ts) -- will never be part of a future remote MCP transport's tool
 * set (see tools/shared/arena-local-state.ts's header comment), unlike tools/shared/deck-analysis.ts (optimize_deck/publish_deck).
 *
 * NO LIVE SCRYFALL CALLS AT ALL anymore (2026-09-17, second pass) -- grpId resolution used to fall
 * back to a live `arena_id:` search since this tool has no direct Mongo connection; that's gone
 * now, since cards.arena_grp_ids is already ingested data manaramp's own query_cards tool can
 * query (see tools/shared/arena-local-state.ts's resolveGrpIdsViaManaramp). The manual card_ratings
 * CSV drop-in mechanism this tool used to also support was removed the same day, superseded by the
 * same remote lookup's format_stats field.
 */

declare const inputSchema: {
    player_log_path: z.ZodOptional<z.ZodString>;
};
declare const arenaDraftAssistanceTool: ToolDefinition<typeof inputSchema>;

export { arenaDraftAssistanceTool };
