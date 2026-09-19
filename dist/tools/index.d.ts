export { optimizeDeckTool } from './optimize-deck.js';
export { publishDeckTool } from './publish-deck.js';
export { readDeckTool } from './read-deck.js';
export { queryCardsTool } from './search-cards.js';
export { queryCombosTool } from './query-combos.js';
export { querySynergiesTool } from './query-synergies.js';
export { getAccountSettingsTool } from './get-account-settings.js';
export { arenaDraftAssistanceTool } from './arena-draft-assistance.js';
export { arenaDraftGameAdviceTool } from './arena-game-advice.js';
export { pushDraftResultTool, pushGameLogTool } from './internal-tools.js';
import { ToolDefinition } from './types.js';
export { McpContext, McpToolResponse } from './types.js';
import 'zod';
import 'mongodb';

/**
 * tools/index.ts
 * Barrel: exports every registered tool definition. This is the package's "." export (see
 * package.json's `exports` map) -- manaramp's remote `/mcp` route imports `tools` from here and
 * registers each one against a request-scoped McpContext (see tools/types.ts).
 *
 * REDESIGNED 2026-09-18, reversing the 2026-09-17 "one primary tool" consolidation, based on a real
 * testing session against a live deck (see manaramp's own project memory for the full writeup):
 * manage_deck's "there is no separate card/synergy/combo lookup tool to call first" framing
 * actively pushed a calling model toward guessing from general MTG knowledge instead of grounding
 * in manaramp's own database, and manage_deck itself persisted to the `decks` collection on EVERY
 * call, including mid-conversation iteration nobody had asked to save yet. Both reversed:
 *
 * - manage_deck split into THREE tools: optimize_deck (analyze/propose, never persists),
 *   publish_deck (the only thing that writes to `decks`), and read_deck (load an existing deck to
 *   edit, or list the account's decks) -- see tools/shared/deck-analysis.ts for the analysis logic
 *   shared by optimize_deck/publish_deck so they can't drift apart on what "the facts" are.
 * - query_cards promoted out of "internal only" into a real conversational tool (renamed export,
 *   same wire name -- see tools/search-cards.ts's header for why the name itself can't change).
 * - query_combos and query_synergies are brand new standalone tools -- neither `combos` nor
 *   `commander_synergies` had a dedicated lookup tool before this, despite both collections already
 *   existing (combo data only ever reached a model as a side effect buried in manage_deck's
 *   response; synergy had no tool at all).
 * - get_account_settings is brand new, LOCAL only -- lets a calling model check what's configured
 *   (currently just player_log_path) instead of that resolution being an invisible side effect.
 *
 * push_draft_result/push_game_log stay internal-only (tools/internal-tools.ts) -- there's no
 * legitimate conversational reason to call those directly, unlike query_cards.
 *
 * `tools` is what the remote endpoint registers -- running in-process with a real Db (see
 * McpContext in tools/types.ts): every tool above that's genuinely usable/needed remotely, PLUS the
 * 2 internal-only wrappers from tools/internal-tools.ts (`push_draft_result`, `push_game_log`) --
 * those exist only so the local Arena tools' remote HTTP calls have something to call.
 *
 * `localTools` is what local/index.ts's stdio bootstrap registers instead: the 2 genuinely local
 * Arena tools (read a local Player.log file, can never run remotely -- a Worker has no filesystem)
 * PLUS get_account_settings (also genuinely local-only) PLUS a remote-proxied version of every
 * Mongo-backed conversational tool (via tools/shared/remote-proxy.ts) -- same name/description/
 * schema, but the handler calls manaramp.com/mcp over HTTP instead of touching a Db directly, using
 * the same MANARAMP_API_KEY the Arena tools' own remote calls already need (manifest.json's
 * user_config). This makes the .mcpb a complete, self-sufficient MCP server on its own. The 2
 * internal push tools are never proxied for local use -- they're side effects the Arena tools call
 * themselves via remote-client.ts directly, not something the calling model invokes.
 */

declare const tools: ToolDefinition<any>[];
declare const localTools: ToolDefinition<any>[];

export { ToolDefinition, localTools, tools };
