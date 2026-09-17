export { manageDeckTool } from './manage-deck.js';
export { arenaDraftAssistanceTool } from './arena-draft-assistance.js';
export { arenaDraftGameAdviceTool } from './arena-game-advice.js';
export { pushDraftResultTool, pushGameLogTool, queryCardsTool } from './internal-tools.js';
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
 * 3 PRIMARY tools (2026-09-17, sixth pass -- functions/ split into parsing/push/query/reference
 * subfolders, and query_cards/query_synergies/query_combos/query_decks/query_draft_results/
 * push_game_log/push_draft_result all stopped being separate CONVERSATIONAL tools): `manage_deck`,
 * `arena_draft_assistance`, `arena_game_advice`. Each one decides for itself which functions/ it
 * needs and which of their fields matter -- see each file's own header. There is no more
 * standalone card/synergy/combo lookup tool for a calling model to reach for; manage_deck is the
 * only conversational entry point to card/deck data, and its own returned facts are the feedback
 * loop for refining a decklist (see manage-deck.ts's header).
 *
 * `tools` (4) is what the remote endpoint registers -- running in-process with a real Db (see
 * McpContext in tools/types.ts): the 1 primary Mongo tool (`manage_deck`) PLUS the 3 internal-only
 * wrappers from tools/internal-tools.ts (`query_cards`, `push_draft_result`, `push_game_log`) --
 * those exist only so the local Arena tools' remote HTTP calls have something to call (see that
 * file's header), not for conversational use.
 *
 * `localTools` (3) is what local/index.ts's stdio bootstrap registers instead: the 2 genuinely
 * local Arena tools (read a local Player.log file, can never run remotely -- a Worker has no
 * filesystem) PLUS a remote-proxied version of `manage_deck` (via tools/shared/remote-proxy.ts) --
 * same name/description/schema, but the handler calls manaramp.com/mcp over HTTP instead of
 * touching a Db directly, using the same MANARAMP_API_KEY the Arena tools' own remote calls already
 * need (manifest.json's user_config). This makes the .mcpb a complete, self-sufficient MCP server
 * on its own: deck building AND Arena assistance from one Claude Desktop install, no separate
 * remote connector needed. The 3 internal tools are never proxied for local use -- they're side
 * effects the Arena tools call themselves via remote-client.ts directly, not something the calling
 * model invokes.
 */

declare const tools: ToolDefinition<any>[];
declare const localTools: ToolDefinition<any>[];

export { ToolDefinition, localTools, tools };
