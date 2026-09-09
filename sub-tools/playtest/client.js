/**
 * sub-tools/playtest/client.js
 * extensions/playtest-table — a SEPARATE server (SvelteKit + Cloudflare Durable
 * Objects), not part of this MCP process. Override PLAYTEST_SERVER_URL to point
 * at a local `npx wrangler dev --port 8787` instead.
 */

const PLAYTEST_BASE = process.env.PLAYTEST_SERVER_URL || "https://scryfall-mcp.playtest-table.workers.dev";
const PLAYTEST_JSON_HEADERS = { "Content-Type": "application/json" };
// Measured ~3-5s for a real ~100-card deck under normal conditions, up to ~30s
// more if an actual Scryfall 429 triggers a wait-then-retry mid-resolution.
const PLAYTEST_TIMEOUT_MS = 20000;
const PLAYTEST_ZONES = ["command", "library", "hand", "battlefield", "graveyard", "exile"];

function playtestWsUrl(roomId) {
  return `${PLAYTEST_BASE.replace(/^http/, "ws")}/api/room/${encodeURIComponent(roomId)}`;
}

async function playtestFetch(path, options) {
  try {
    return await fetch(`${PLAYTEST_BASE}${path}`, options);
  } catch (e) {
    throw new Error(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in extensions/playtest-table. (${e.message || e})`
    );
  }
}

function connectRoom(roomId, timeoutMs = PLAYTEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(playtestWsUrl(roomId));
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} within ${timeoutMs}ms — ` +
      `make sure \`npx wrangler dev\` is running in extensions/playtest-table.`
    ), timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in extensions/playtest-table. (${e.message || e})`
    ));
  });
}

// 'ended' is endTable's reply (wipes the room, no state to broadcast) -> resolves state:null.
// batchErrors arrive before the final state broadcast; collected and returned to the caller.
function sendAndAwait(ws, action, timeoutMs = PLAYTEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let batchErrors = null;
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Timed out waiting for a response from the playtest server at ${PLAYTEST_BASE}.`));
    }, timeoutMs);
    function handler(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "state") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ state: msg.state, batchErrors });
      } else if (msg.type === "ended") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve({ state: null, batchErrors });
      } else if (msg.type === "error") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        reject(new Error(msg.error));
      } else if (msg.type === "batchErrors") {
        batchErrors = msg.errors;
      }
    }
    ws.addEventListener("message", handler);
    if (action) ws.send(JSON.stringify(action));
  });
}

// Connect -> consume the auto-pushed initial state -> optionally send one real action -> await
// its result -> always close. Every playtest tool goes through this one function.
async function withRoom(roomId, action) {
  const ws = await connectRoom(roomId);
  try {
    const initial = await sendAndAwait(ws, null);
    if (!action) return initial;
    return await sendAndAwait(ws, action);
  } finally {
    ws.close();
  }
}

export {
  PLAYTEST_BASE, PLAYTEST_JSON_HEADERS, PLAYTEST_TIMEOUT_MS, PLAYTEST_ZONES,
  playtestWsUrl, playtestFetch, connectRoom, sendAndAwait, withRoom,
};
