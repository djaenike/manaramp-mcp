/**
 * sub-tools/playtest/lobby.ts
 */

import { playtestFetch, withRoom, PLAYTEST_BASE, PLAYTEST_JSON_HEADERS } from "./client.js";

async function listGames(only_needs_ai_move?: boolean) {
  const res = await playtestFetch("/api/lobby");
  const rooms = (await res.json()) as any;
  if (!res.ok || rooms.error) {
    throw new Error(`Lobby request failed: ${rooms.error || res.statusText}`);
  }

  const out: any[] = [];
  for (const room of rooms) {
    const hasAiSeat = room.seats.some((s: any) => s.controller === "ai");
    let active = null;
    let activeIsAi = false;
    if (hasAiSeat) {
      try {
        const { state } = await withRoom(room.roomId, null);
        const activeSeat = state.seats.find((s: any) => s.id === state.active);
        active = activeSeat ? { seat_id: activeSeat.id, label: activeSeat.label, controller: activeSeat.controller } : null;
        activeIsAi = activeSeat?.controller === "ai";
      } catch {
        active = null;
      }
    }
    if (only_needs_ai_move && !activeIsAi) continue;
    out.push({
      room_id: room.roomId,
      label: room.label,
      seats: room.seats,
      created_at: room.createdAt,
      active,
      needs_ai_move: activeIsAi,
    });
  }
  return out;
}

async function createTable(label: string, seats: any) {
  const res = await playtestFetch("/api/lobby", {
    method: "POST",
    headers: PLAYTEST_JSON_HEADERS,
    body: JSON.stringify({ label, seats }),
  });
  const data = (await res.json()) as any;
  if (!res.ok || data.error) {
    throw new Error(`Table creation failed: ${data.error || res.statusText}`);
  }
  return { room_id: data.roomId, room_url: `${PLAYTEST_BASE}/room/${data.roomId}` };
}

export { listGames, createTable };
