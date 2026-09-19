import { ToolDefinition } from './types.js';
import 'zod';
import 'mongodb';

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

declare const inputSchema: {};
declare const getAccountSettingsTool: ToolDefinition<typeof inputSchema>;

export { getAccountSettingsTool };
