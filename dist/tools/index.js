import { optimizeDeckTool } from "./optimize-deck.js";
import { publishDeckTool } from "./publish-deck.js";
import { readDeckTool } from "./read-deck.js";
import { queryCardsTool } from "./search-cards.js";
import { queryCombosTool } from "./query-combos.js";
import { querySynergiesTool } from "./query-synergies.js";
import { getAccountSettingsTool } from "./get-account-settings.js";
import { arenaDraftAssistanceTool } from "./arena-draft-assistance.js";
import { arenaDraftGameAdviceTool } from "./arena-game-advice.js";
import { pushDraftResultTool, pushGameLogTool } from "./internal-tools.js";
import { toRemoteProxy } from "./shared/remote-proxy.js";
const mongoBackedTools = [
  optimizeDeckTool,
  publishDeckTool,
  readDeckTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool
];
const tools = [
  ...mongoBackedTools,
  getAccountSettingsTool,
  pushDraftResultTool,
  pushGameLogTool
];
const localTools = [
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  getAccountSettingsTool,
  ...mongoBackedTools.map(toRemoteProxy)
];
export {
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  getAccountSettingsTool,
  localTools,
  optimizeDeckTool,
  publishDeckTool,
  pushDraftResultTool,
  pushGameLogTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool,
  readDeckTool,
  tools
};
