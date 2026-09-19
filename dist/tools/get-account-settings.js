import { resolvePlayerLogPath } from "./shared/arena-local-state.js";
const inputSchema = {};
const getAccountSettingsTool = {
  name: "get_account_settings",
  description: "Check what's configured for this machine/account -- currently just player_log_path (the Arena Player.log path arena_draft_assistance/arena_draft_game_advice will use). Call this BEFORE those tools if you want to confirm/report what's set rather than only finding out implicitly when a draft/game tool call succeeds or asks for it. Resolution order: remembered on this machine from a previous call, else whatever the user saved on manaramp.com/mcp-setup (fetched once and cached locally after that). null means neither -- point the user at manaramp.com/mcp-setup, or ask them for the path directly.",
  inputSchema,
  handler: async () => {
    const player_log_path = await resolvePlayerLogPath();
    return { content: [{ type: "text", text: JSON.stringify({ player_log_path }, null, 2) }] };
  }
};
export {
  getAccountSettingsTool
};
