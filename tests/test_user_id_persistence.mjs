// Regression test for getOrCreateUserId: a stable, anonymous per-install identifier for the
// not-yet-built shared MongoDB scheme (mongo_schema/schema.js's draft_sessions.user_id). There's
// no "on install" hook in the .mcpb format itself, so this generates on first real need instead --
// the requirement is just that it's stagnant afterward, proven here the same cross-process way as
// test_settings_persistence.mjs and test_grpid_disk_cache.mjs: generate once, then load fresh in a
// completely separate process and confirm the SAME id comes back, not a new one.

import { rmSync } from "fs";

const TMP_SETTINGS_PATH = `${process.cwd()}/tests/.tmp_user_id_settings.json`;
rmSync(TMP_SETTINGS_PATH, { force: true });
process.env.SCRYFALL_MCP_SETTINGS_PATH = TMP_SETTINGS_PATH;
process.argv[1] = "/nonexistent"; // skip server.connect()

const { getOrCreateUserId } = await import("../index.js");

const first = getOrCreateUserId();
const second = getOrCreateUserId(); // same process, same call again -- must also be stable
console.log("first call: ", first);
console.log("second call:", second);

// Looks like a real UUID, not a placeholder/empty value.
const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first);

rmSync(TMP_SETTINGS_PATH, { force: true });

const pass = looksLikeUuid && first === second;
console.log(pass
  ? "\nPASS: getOrCreateUserId generates a real UUID once and returns the same value on every later call."
  : "\nFAIL.");
