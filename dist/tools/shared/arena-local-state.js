import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../../functions/parsing/settings.js";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CARD_CACHE_DIR = join(PACKAGE_ROOT, "card_cache");
const GRPID_CACHE_PATH = join(CARD_CACHE_DIR, "grpid_cache.json");
function loadGrpIdCache() {
  const cache = /* @__PURE__ */ new Map();
  try {
    const raw = JSON.parse(readFileSync(GRPID_CACHE_PATH, "utf8"));
    for (const [grpId, card] of Object.entries(raw)) {
      cache.set(Number(grpId), card);
    }
  } catch {
  }
  return cache;
}
function saveGrpIdCache(cache) {
  try {
    mkdirSync(CARD_CACHE_DIR, { recursive: true });
    writeFileSync(GRPID_CACHE_PATH, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
  }
}
const grpIdCardCache = loadGrpIdCache();
async function withPersistentGrpIdCache(resolveFn) {
  const sizeBefore = grpIdCardCache.size;
  const result = await resolveFn(grpIdCardCache);
  if (grpIdCardCache.size > sizeBefore) saveGrpIdCache(grpIdCardCache);
  return result;
}
async function resolveGrpIdsViaManaramp(grpIds) {
  const { callRemoteTool } = await import("./remote-client.js");
  const cards = await callRemoteTool(
    "query_cards",
    { arena_grp_ids: grpIds }
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
const SETTINGS_PATH = process.env.SCRYFALL_MCP_SETTINGS_PATH || join(PACKAGE_ROOT, "arena_settings.json");
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
async function resolvePlayerLogPath(providedPath) {
  if (providedPath) {
    if (providedPath !== loadSettings(SETTINGS_PATH).player_log_path) {
      saveSettings(SETTINGS_PATH, { player_log_path: providedPath });
    }
    return providedPath;
  }
  const remembered = loadSettings(SETTINGS_PATH).player_log_path;
  if (remembered) return remembered;
  const fromServer = await fetchPlayerLogPathFromManaramp();
  if (fromServer) {
    saveSettings(SETTINGS_PATH, { player_log_path: fromServer });
    return fromServer;
  }
  return null;
}
function getOrCreateUserId() {
  const existing = loadSettings(SETTINGS_PATH).user_id;
  if (existing) return existing;
  const userId = crypto.randomUUID();
  saveSettings(SETTINGS_PATH, { user_id: userId });
  return userId;
}
export {
  CARD_CACHE_DIR,
  GRPID_CACHE_PATH,
  SETTINGS_PATH,
  getOrCreateUserId,
  grpIdCardCache,
  resolveGrpIdsViaManaramp,
  resolvePlayerLogPath,
  withPersistentGrpIdCache
};
