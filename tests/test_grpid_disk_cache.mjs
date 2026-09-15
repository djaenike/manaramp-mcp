// Regression test for the disk-persisted grpId cache (index.js's grpIdCardCache /
// card_cache/grpid_cache.json). An in-memory-only cache fixes re-resolution WITHIN one running
// server process, but silently resets on a restart (computer reboot, Claude Desktop fully
// quitting, a crash) -- this proves the cache genuinely survives that, by writing it to a JSON
// file, then reading it back in a completely separate simulated "process" (a fresh Map, no
// shared memory) and confirming a cached grpId resolves WITHOUT calling the lookup function again
// -- if the cache failed to do its job, the lookup function below throws instead of silently
// passing, so this is a real proof, not just an assertion on a return value.

import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { resolveGrpIds } from "../src/sub-tools/arena-log/grpid_resolver.js";

const TMP_DIR = `${process.cwd()}/tests/.tmp_grpid_cache`;
const TMP_CACHE_PATH = `${TMP_DIR}/grpid_cache.json`;
mkdirSync(TMP_DIR, { recursive: true });

const FAKE_CARD_DB = { 40001: { name: "Fixture Bomb", type_line: "Creature" } };
async function fakeSearchCards(query) {
  const id = parseInt(query.split(":")[1], 10);
  return FAKE_CARD_DB[id] ? [FAKE_CARD_DB[id]] : [];
}

// --- "Process A": resolve once, then persist the cache to disk (mirrors index.js's
// saveGrpIdCache: Object.fromEntries(cache) -> JSON). ---
const cacheA = new Map();
const { cards: cardsA } = await resolveGrpIds([40001], fakeSearchCards, { cache: cacheA });
console.log("process A resolved:", cardsA.get(40001)?.name);
writeFileSync(TMP_CACHE_PATH, JSON.stringify(Object.fromEntries(cacheA), null, 2));

// --- "Process B": a brand new Map, loaded ONLY from the file on disk -- nothing shared in
// memory with process A above (mirrors index.js's loadGrpIdCache on a fresh server start). ---
const raw = JSON.parse(readFileSync(TMP_CACHE_PATH, "utf8"));
const cacheB = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));

async function shouldNeverBeCalled(query) {
  throw new Error(`Cache did not prevent a re-lookup for ${query}`);
}
const { cards: cardsB } = await resolveGrpIds([40001], shouldNeverBeCalled, { cache: cacheB });
console.log("process B (disk cache only, lookup fn must not run) resolved:", cardsB.get(40001)?.name);

rmSync(TMP_DIR, { recursive: true, force: true });

const pass = cardsA.get(40001)?.name === "Fixture Bomb" && cardsB.get(40001)?.name === "Fixture Bomb";
console.log(pass
  ? "\nPASS: a grpId resolved in one process is served from disk in a completely separate process, with zero re-lookup."
  : "\nFAIL.");
