// Regression test for the fix to a real, recurring annoyance: the user had to retype the
// absolute path to Arena's Player.log in every new conversation, even the day right after they'd
// already given it once, because Claude has no memory of a prior conversation's tool-call
// arguments. index.js's resolvePlayerLogPath is built on this module -- save once, read back in
// a completely separate "process" (a fresh settings load, nothing shared in memory), same
// cross-process proof pattern as test_grpid_disk_cache.mjs.

import { rmSync } from "fs";
import { loadSettings, saveSettings } from "../src/sub-tools/arena-log/settings.js";

const TMP_PATH = `${process.cwd()}/tests/.tmp_arena_settings.json`;
rmSync(TMP_PATH, { force: true });

// Nothing saved yet -- must come back empty, not throw.
const empty = loadSettings(TMP_PATH);
console.log("before any save:", JSON.stringify(empty));

// "Conversation 1": the user gives the path once.
saveSettings(TMP_PATH, { player_log_path: "C:\\Users\\test\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log" });

// "Conversation 2" (a fresh load from disk, simulating a brand-new process/conversation with
// nothing carried over in memory): the path must still be there.
const remembered = loadSettings(TMP_PATH);
console.log("loaded fresh in a separate load:", JSON.stringify(remembered));

// A later save only patches the given keys -- an existing unrelated setting must survive.
saveSettings(TMP_PATH, { some_other_setting: "keep me" });
const afterPatch = loadSettings(TMP_PATH);
console.log("after patching an unrelated key:", JSON.stringify(afterPatch));

rmSync(TMP_PATH, { force: true });

const pass = Object.keys(empty).length === 0
  && remembered.player_log_path === "C:\\Users\\test\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log"
  && afterPatch.player_log_path === remembered.player_log_path
  && afterPatch.some_other_setting === "keep me";

console.log(pass
  ? "\nPASS: a saved setting survives a fresh load (simulating a brand-new conversation), and patching doesn't clobber other keys."
  : "\nFAIL.");
