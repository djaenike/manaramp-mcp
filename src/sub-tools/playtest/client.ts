/**
 * sub-tools/playtest/client.ts
 * The playtest table is a SEPARATE server (SvelteKit + Cloudflare Durable Objects), not part of
 * this MCP process -- it lives in the sibling `manaramp` repo (previously extensions/playtest-table
 * inside this repo; moved out when the two projects split, see CLAUDE.md). Override
 * PLAYTEST_SERVER_URL to point at a local `npx wrangler dev --port 8787` (run from the `manaramp`
 * repo) instead of the deployed default below.
 */

const PLAYTEST_BASE = process.env.PLAYTEST_SERVER_URL || "https://scryfall-mcp.playtest-table.workers.dev";
const PLAYTEST_JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
// Measured ~3-5s for a real ~100-card deck under normal conditions, up to ~30s
// more if an actual Scryfall 429 triggers a wait-then-retry mid-resolution.
const PLAYTEST_TIMEOUT_MS = 20000;
const PLAYTEST_ZONES = ["command", "library", "hand", "battlefield", "graveyard", "exile"];

interface RoomResult {
  state: any;
  batchErrors: any[] | null;
}

function playtestWsUrl(roomId: string): string {
  return `${PLAYTEST_BASE.replace(/^http/, "ws")}/api/room/${encodeURIComponent(roomId)}`;
}

async function playtestFetch(path: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${PLAYTEST_BASE}${path}`, options);
  } catch (e: any) {
    throw new Error(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in the manaramp repo (npm run preview, or wrangler dev --port 8787). (${e.message || e})`
    );
  }
}

function connectRoom(roomId: string, timeoutMs: number = PLAYTEST_TIMEOUT_MS): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(playtestWsUrl(roomId));
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} within ${timeoutMs}ms — ` +
      `make sure \`npx wrangler dev\` is running in the manaramp repo (npm run preview, or wrangler dev --port 8787).`
    ), timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", (e: any) => fail(
      `Could not reach the playtest server at ${PLAYTEST_BASE} — make sure ` +
      `\`npx wrangler dev\` is running in the manaramp repo (npm run preview, or wrangler dev --port 8787). (${e.message || e})`
    ));
  });
}

// 'ended' is endTable's reply (wipes the room, no state to broadcast) -> resolves state:null.
// batchErrors arrive before the final state broadcast; collected and returned to the caller.
function sendAndAwait(ws: WebSocket, action: any, timeoutMs: number = PLAYTEST_TIMEOUT_MS): Promise<RoomResult> {
  return new Promise((resolve, reject) => {
    let batchErrors: any[] | null = null;
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`Timed out waiting for a response from the playtest server at ${PLAYTEST_BASE}.`));
    }, timeoutMs);
    function handler(event: any) {
      let msg: any;
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
async function withRoom(roomId: string, action: any): Promise<RoomResult> {
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
export type { RoomResult };
