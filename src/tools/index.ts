/**
 * tools/index.ts
 * Barrel: exports every registered tool definition (8 total, same count as originally wired into
 * index.js) both individually by name and as one `tools` array. This is the package's "." export
 * (see package.json's `exports` map) -- a future remote MCP endpoint (a separate, later phase, in
 * the sibling `manaramp` Cloudflare Workers repo) can `import { tools } from 'manaramp-mcp'` and
 * get just these definitions, without pulling in local/index.ts's stdio bootstrap or any
 * local-machine-only code (disk caches, settings file, report-to-Downloads writing).
 *
 * NOTE: arena_draft_assistance / arena_draft_game_advice are included here for completeness (same
 * 8-tool count as today) but are fundamentally local-machine-only (they read a real Player.log
 * file) -- see tools/shared/arena-local-state.ts's header comment. A future remote transport would
 * only ever import/register the other 6.
 */

import { newDeckCreationTool, existingDeckCleanupTool } from "./deck-building.js";
import { searchCardsTool } from "./search-cards.js";
import { getCardSynergiesTool } from "./get-card-synergies.js";
import { findCombosTool } from "./find-combos.js";
import { getCardScriptTool } from "./get-card-script.js";
import { arenaDraftAssistanceTool } from "./arena-draft-assistance.js";
import { arenaDraftGameAdviceTool } from "./arena-draft-game-advice.js";
import type { ToolDefinition } from "./types.js";

const tools: ToolDefinition<any>[] = [
  newDeckCreationTool,
  existingDeckCleanupTool,
  searchCardsTool,
  getCardSynergiesTool,
  findCombosTool,
  getCardScriptTool,
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
];

export {
  tools,
  newDeckCreationTool,
  existingDeckCleanupTool,
  searchCardsTool,
  getCardSynergiesTool,
  findCombosTool,
  getCardScriptTool,
  arenaDraftAssistanceTool,
  arenaDraftGameAdviceTool,
};
export type { ToolDefinition } from "./types.js";
