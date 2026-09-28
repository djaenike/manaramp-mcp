import { validateAndSubmitTool } from "./validate-and-submit.js";
import { deckPlanGuideTool } from "./deck-plan-guide.js";
import { fillDeckPlanTool } from "./fill-deck-plan.js";
import { editDeckTool } from "./edit-deck.js";
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
const mongoBackedTools = [
  deckPlanGuideTool,
  fillDeckPlanTool,
  editDeckTool,
  validateAndSubmitTool,
  readDeckTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool
];
const tools = [
  ...mongoBackedTools,
  formatGuidelinesTool,
  getAccountSettingsTool,
  pushDraftResultTool,
  pushGameLogTool
];
const localTools = [
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  getAccountSettingsTool,
  formatGuidelinesTool,
  ...mongoBackedTools.map(toRemoteProxy),
  toRemoteProxy(pushDraftResultTool),
  toRemoteProxy(pushGameLogTool)
];
export {
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
  deckPlanGuideTool,
  editDeckTool,
  fillDeckPlanTool,
  formatGuidelinesTool,
  getAccountSettingsTool,
  localTools,
  pushDraftResultTool,
  pushGameLogTool,
  queryCardsTool,
  queryCombosTool,
  querySynergiesTool,
  readDeckTool,
  tools,
  validateAndSubmitTool
};
