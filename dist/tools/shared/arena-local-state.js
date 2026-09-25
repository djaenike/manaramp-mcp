import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../../functions/parsing/settings.js";
let packageRoot;
function getPackageRoot() {
  return packageRoot ??= join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
function getCardCacheDir() {
  return join(getPackageRoot(), "card_cache");
}
function getGrpIdCachePath() {
  return join(getCardCacheDir(), "grpid_cache.json");
}
function loadGrpIdCache() {
  const cache = /* @__PURE__ */ new Map();
  try {
    const raw = JSON.parse(readFileSync(getGrpIdCachePath(), "utf8"));
    for (const [grpId, card] of Object.entries(raw)) {
      cache.set(Number(grpId), card);
    }
  } catch {
  }
  return cache;
}
function saveGrpIdCache(cache) {
  try {
    mkdirSync(getCardCacheDir(), { recursive: true });
    writeFileSync(getGrpIdCachePath(), JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
  }
}
let grpIdCardCache;
function getGrpIdCardCache() {
  return grpIdCardCache ??= loadGrpIdCache();
}
async function withPersistentGrpIdCache(resolveFn) {
  const cache = getGrpIdCardCache();
  const sizeBefore = cache.size;
  const result = await resolveFn(cache);
  if (cache.size > sizeBefore) saveGrpIdCache(cache);
  return result;
}
async function resolveGrpIdsViaManaramp(grpIds) {
  const { callRemoteTool } = await import("./remote-client.js");
  const cards = await callRemoteTool(
    "query_cards",
    // detail: "full" -- the compact default (2026-09-25) drops arena_grp_ids, which the mapping
    // below needs, and this cache wants the complete record anyway. Token cost is controlled where
    // cards are shown to the model instead (see arena-card-view.ts), not here.
    { arena_grp_ids: grpIds, detail: "full" }
  );
  const byGrpId = /* @__PURE__ */ new Map();
  const wanted = new Set(grpIds);
  for (const card of cards) {
    for (const id of card.arena_grp_ids ?? []) {
      if (wanted.has(id)) byGrpId.set(id, card);
    }
  }
  return byGrpId;
}
function getSettingsPath() {
  return process.env.SCRYFALL_MCP_SETTINGS_PATH || join(getPackageRoot(), "arena_settings.json");
}
const MANARAMP_SETTINGS_URL = process.env.MANARAMP_SETTINGS_URL || "https://manaramp.com/api/mcp-settings";
async function fetchPlayerLogPathFromManaramp() {
  const apiKey = process.env.MANARAMP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(MANARAMP_SETTINGS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const body = await res.json();
    return body.player_log_path ?? null;
  } catch {
    return null;
  }
}
function stripWrappingQuotes(path) {
  const trimmed = path.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
async function resolvePlayerLogPath(providedPath) {
  const settingsPath = getSettingsPath();
  if (providedPath) {
    const sanitized = stripWrappingQuotes(providedPath);
    if (sanitized !== loadSettings(settingsPath).player_log_path) {
      saveSettings(settingsPath, { player_log_path: sanitized });
    }
    return sanitized;
  }
  const remembered = loadSettings(settingsPath).player_log_path;
  if (remembered) return remembered;
  const fromServer = await fetchPlayerLogPathFromManaramp();
  if (fromServer) {
    const sanitized = stripWrappingQuotes(fromServer);
    saveSettings(settingsPath, { player_log_path: sanitized });
    return sanitized;
  }
  return null;
}
function getOrCreateUserId() {
  const settingsPath = getSettingsPath();
  const existing = loadSettings(settingsPath).user_id;
  if (existing) return existing;
  const userId = crypto.randomUUID();
  saveSettings(settingsPath, { user_id: userId });
  return userId;
}
export {
  getCardCacheDir,
  getGrpIdCachePath,
  getGrpIdCardCache,
  getOrCreateUserId,
  getSettingsPath,
  resolveGrpIdsViaManaramp,
  resolvePlayerLogPath,
  withPersistentGrpIdCache
};
