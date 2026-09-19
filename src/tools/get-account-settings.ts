/**
 * tools/get-account-settings.ts -- get_account_settings
 *
 * New (2026-09-18): lets Claude directly check what's configured for this account, rather than the
 * player_log_path resolution being an invisible side effect buried inside arena_draft_assistance's
 * handler with no way to introspect it.
 *
 * Registered on BOTH transports as of 2026-09-19 (originally local-only), each resolving
 * player_log_path a different way:
 *  - Remote (tools/index.ts's `tools`): uses ctx.getPlayerLogPath(), which manaramp's /mcp route
 *    resolves directly from the mcp_keys collection for the authenticated ownerUserId -- see
 *    types.ts's McpContext header for why that's a route-supplied getter instead of a direct query
 *    this handler makes itself.
 *  - Local (tools/index.ts's `localTools`, registered directly, not proxied): still calls
 *    resolvePlayerLogPath(), unchanged -- a local machine can't authenticate to the DB-backed getter
 *    (no ctx.getPlayerLogPath there, see local/index.ts's header), so it keeps its original
 *    fallback chain (remembered on this machine, else fetched once from manaramp.com/api/
 *    mcp-settings and cached locally).
 * Both paths return the exact same shape, so the calling model doesn't need to know which transport
 * it's on.
 */

import { z } from "zod";
import { resolvePlayerLogPath } from "./shared/arena-local-state.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {};

const getAccountSettingsTool: ToolDefinition<typeof inputSchema> = {
  name: "get_account_settings",
  description:
    "Check what's configured for this account -- currently just player_log_path (the Arena " +
    "Player.log path arena_draft_assistance/arena_draft_game_advice use when running locally). " +
    "Call this BEFORE those tools if you want to confirm/report what's set rather than only " +
    "finding out implicitly when a draft/game tool call succeeds or asks for it. null means " +
    "nothing saved yet -- point the user at manaramp.com/mcp-setup, or ask them for the path " +
    "directly.",
  inputSchema,
  handler: async (_args, ctx) => {
    const player_log_path = ctx?.getPlayerLogPath ? await ctx.getPlayerLogPath() : await resolvePlayerLogPath();
    return { content: [{ type: "text" as const, text: JSON.stringify({ player_log_path }, null, 2) }] };
  },
};

export { getAccountSettingsTool };
