import { readFileSync, writeFileSync } from "node:fs";
function loadSettings(settingsPath) {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(settingsPath, patch) {
  try {
    writeFileSync(settingsPath, JSON.stringify({ ...loadSettings(settingsPath), ...patch }, null, 2));
  } catch {
  }
}
export {
  loadSettings,
  saveSettings
};
