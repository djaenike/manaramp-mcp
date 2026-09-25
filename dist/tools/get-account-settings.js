import { resolvePlayerLogPath } from "./shared/arena-local-state.js";
const inputSchema = {};
const getAccountSettingsTool = {
  name: "get_account_settings",
  description: "Check what's configured for this account -- currently just player_log_path (the Arena Player.log path arena_draft_assistance/arena_draft_game_advice use when running locally). Call this BEFORE those tools if you want to confirm/report what's set rather than only finding out implicitly when a draft/game tool call succeeds or asks for it. null means nothing saved yet -- point the user at manaramp.com/mcp-setup, or ask them for the path directly.",
  inputSchema,
  handler: async (_args, ctx) => {
    const player_log_path = ctx?.getPlayerLogPath ? await ctx.getPlayerLogPath() : await resolvePlayerLogPath();
    return { content: [{ type: "text", text: JSON.stringify({ player_log_path }) }] };
  }
};
export {
  getAccountSettingsTool
};
