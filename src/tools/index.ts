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
 *
 *   UPDATED 2026-09-22: optimize_deck/publish_deck retired, replaced by ONE tool,
 *   validate_and_submit (same analyze-vs-persist split, now a `submit` boolean rather than two tool
 *   names -- see that tool's own header for why), plus a brand new format_guidelines (pure reference
 *   data -- real Commander Bracket criteria + general composition guidance, no deck/DB involved) --
 *   both added specifically to fix real "too combo-oriented" feedback on the old pair. read_deck is
 *   unchanged.
 * - query_cards promoted out of "internal only" into a real conversational tool (renamed export,
 *   same wire name -- see tools/search-cards.ts's header for why the name itself can't change).
 * - query_combos and query_synergies are brand new standalone tools -- neither `combos` nor
 *   `commander_synergies` had a dedicated lookup tool before this, despite both collections already
 *   existing (combo data only ever reached a model as a side effect buried in manage_deck's
 *   response; synergy had no tool at all).
 * - get_account_settings started LOCAL-only, lets a calling model check what's configured
 *   (currently just player_log_path) instead of that resolution being an invisible side effect.
 *   UPDATED 2026-09-19: also registered on the remote `tools` array now -- see that tool's own
 *   header for how it resolves player_log_path differently per transport (ctx.getPlayerLogPath()
 *   remotely vs. its original local resolution chain locally). It still doesn't let Claude actually
 *   READ Player.log remotely -- a Worker has no filesystem, so only the path string is available
 *   over remote, not its contents; reading the file itself still requires the 2 Arena tools below,
 *   which stay local-only.
 *
 * push_draft_result/push_game_log UN-internal'd 2026-09-19 (tools/internal-tools.ts) -- same
 * query_cards-shaped fix: "internal use only" framing was found live to make a calling model refuse
 * to call these even when a user explicitly wanted a past draft/match pushed and had everything
 * needed to do it. Real conversational tools now, registered the same way as every other
 * Mongo-backed tool below.
 *
 * `tools` is what the remote endpoint registers -- running in-process with a real Db (see
 * McpContext in tools/types.ts): every tool above that's genuinely usable/needed remotely, PLUS
 * get_account_settings, PLUS push_draft_result/push_game_log.
 *
 * `localTools` is what local/index.ts's stdio bootstrap registers instead: the 2 genuinely local
 * Arena tools (read a local Player.log file, can never run remotely -- a Worker has no filesystem)
 * PLUS get_account_settings (registered directly here too, same object as `tools`' copy -- its
 * handler branches on ctx.getPlayerLogPath's presence to pick the right resolution per transport)
 * PLUS a remote-proxied version of every Mongo-backed conversational tool, INCLUDING the two push
 * tools now (via tools/shared/remote-proxy.ts) -- same name/description/schema, but the handler
 * calls manaramp.com/mcp over HTTP instead of touching a Db directly, using the same
 * MANARAMP_API_KEY the Arena tools' own remote calls already need (manifest.json's user_config).
 * This makes the .mcpb a complete, self-sufficient MCP server on its own.
 */

import { validateAndSubmitTool } from "./validate-and-submit.js";
import { formatGuidelinesTool } from "./format-guidelines.js";
import { readDeckTool } from "./read-deck.js";
import { queryCardsTool } from "./search-cards.js";
import { queryCombosTool } from "./query-combos.js";
import { querySynergiesTool } from "./query-synergies.js";
import { getAccountSettingsTool } from "./get-account-settings.js";
import { arenaDraftAssistanceTool } from "./arena-draft-assistance.js";
import { arenaDraftGameAdviceTool } from "./arena-game-advice.js";
import { pushDraftResultTool, pushGameLogTool } from "./internal-tools.js";
import { toRemoteProxy } from "./shared/remote-proxy.js";
import type { ToolDefinition } from "./types.js";

const mongoBackedTools: ToolDefinition<any>[] = [
  validateAndSubmitTool,
  readDeckTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool,
];

const tools: ToolDefinition<any>[] = [
  ...mongoBackedTools,
  formatGuidelinesTool,
  getAccountSettingsTool,
  pushDraftResultTool,
  pushGameLogTool,
];

// formatGuidelinesTool is pure reference data -- no ctx/Db access at all -- so it's registered
// directly here too (same object as `tools`' copy, same idea as getAccountSettingsTool just above)
// rather than going through toRemoteProxy, which would otherwise send a local caller on an
// unnecessary HTTP round-trip for something answerable with zero network access either way.
const localTools: ToolDefinition<any>[] = [
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  getAccountSettingsTool,
  formatGuidelinesTool,
  ...mongoBackedTools.map(toRemoteProxy),
  toRemoteProxy(pushDraftResultTool),
  toRemoteProxy(pushGameLogTool),
];

export {
  tools,
  localTools,
  validateAndSubmitTool,
  formatGuidelinesTool,
  readDeckTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool,
  getAccountSettingsTool,
  pushDraftResultTool,
  pushGameLogTool,
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
};
export type { ToolDefinition, McpContext, McpToolResponse } from "./types.js";
