/**
 * tools/get-account-settings.ts -- get_account_settings
 *
 * New (2026-09-18), LOCAL-ONLY tool: lets Claude directly check what's configured on this machine/
 * account, rather than the player_log_path resolution being an invisible side effect buried inside
 * arena_draft_assistance's handler with no way to introspect it. Hits the SAME
 * manaramp.com/api/mcp-settings REST endpoint tools/shared/arena-local-state.ts's
 * resolvePlayerLogPath already calls internally -- this doesn't add a new server-side capability,
 * just makes the existing one directly callable.
 *
 * Deliberately LOCAL only, never remote-registered: player_log_path is inherently a local-machine
 * setting (which Player.log, on which computer) and mcp_keys lives under a trust tier the remote
 * /mcp route's McpContext never gets access to either way (see mcp-settings/+server.ts's own
 * header) -- there's no meaningful "remote" version of this.
 */

import { z } from "zod";
import { resolvePlayerLogPath } from "./shared/arena-local-state.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {};

const getAccountSettingsTool: ToolDefinition<typeof inputSchema> = {
  name: "get_account_settings",
  description:
    "Check what's configured for this machine/account -- currently just player_log_path (the " +
    "Arena Player.log path arena_draft_assistance/arena_draft_game_advice will use). Call this " +
    "BEFORE those tools if you want to confirm/report what's set rather than only finding out " +
    "implicitly when a draft/game tool call succeeds or asks for it. Resolution order: remembered " +
    "on this machine from a previous call, else whatever the user saved on " +
    "manaramp.com/mcp-setup (fetched once and cached locally after that). null means neither -- " +
    "point the user at manaramp.com/mcp-setup, or ask them for the path directly.",
  inputSchema,
  handler: async () => {
    const player_log_path = await resolvePlayerLogPath();
    return { content: [{ type: "text" as const, text: JSON.stringify({ player_log_path }, null, 2) }] };
  },
};

export { getAccountSettingsTool };
