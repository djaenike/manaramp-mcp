/**
 * functions/parsing/settings.ts
 * Tiny local key-value settings store (a JSON file), used to remember machine-specific values
 * across separate MCP server processes/conversations -- e.g. player_log_path, so the user isn't
 * asked to retype the same absolute path every new conversation. Claude has no memory of a PRIOR
 * conversation's tool-call arguments; the only place this can actually persist is server-side, on
 * disk. Takes an explicit path rather than hardcoding one so it's independently testable against
 * a scratch file.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface SettingsRecord {
  player_log_path?: string;
  user_id?: string;
  [key: string]: unknown;
}

function loadSettings(settingsPath: string): SettingsRecord {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {}; // no file yet, or unreadable -- start empty rather than fail
  }
}

function saveSettings(settingsPath: string, patch: Partial<SettingsRecord>): void {
  try {
    writeFileSync(settingsPath, JSON.stringify({ ...loadSettings(settingsPath), ...patch }, null, 2));
  } catch {
    // Best-effort -- remembering a value is a convenience, never required for a tool to function.
  }
}

export { loadSettings, saveSettings };
export type { SettingsRecord };
