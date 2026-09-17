import { manageDeckTool } from "./manage-deck.js";
import { arenaDraftAssistanceTool } from "./arena-draft-assistance.js";
import { arenaDraftGameAdviceTool } from "./arena-game-advice.js";
import { queryCardsTool, pushDraftResultTool, pushGameLogTool } from "./internal-tools.js";
import { toRemoteProxy } from "./shared/remote-proxy.js";
const tools = [
  manageDeckTool,
  queryCardsTool,
  pushDraftResultTool,
  pushGameLogTool
];
const localTools = [
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  toRemoteProxy(manageDeckTool)
];
export {
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  localTools,
  manageDeckTool,
  pushDraftResultTool,
  pushGameLogTool,
  queryCardsTool,
  tools
};
