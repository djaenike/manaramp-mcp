import { ToolDefinition } from './types.js';
import 'zod';
import 'mongodb';

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

declare const inputSchema: {};
declare const getAccountSettingsTool: ToolDefinition<typeof inputSchema>;

export { getAccountSettingsTool };
