/**
 * sub-tools/delivery/create_playtest_room.js
 *
 * A LEAF function -- does not call consistency/bracket/price itself. The
 * caller (index.js) runs those checks first, decides whether to proceed, and
 * passes the results in here purely to format final_delivery_text. This file
 * only talks to the playtest server.
 */

import { playtestFetch, withRoom, PLAYTEST_BASE, PLAYTEST_JSON_HEADERS } from "../playtest/client.js";

async function createPlaytestRoom({ deck_name, commanderNames, deckEntries, decklist_text, wincon_summary, general_strategy, consistency, bracket, price }) {
  const lobbyRes = await playtestFetch("/api/lobby", {
    method: "POST",
    headers: PLAYTEST_JSON_HEADERS,
    body: JSON.stringify({
      label: deck_name,
      seats: [
        { label: "You", controller: "human" },
        { label: "AI opponent", controller: "ai" },
      ],
    }),
  });
  const lobbyData = await lobbyRes.json();
  if (!lobbyRes.ok || lobbyData.error) {
    throw new Error(lobbyData.error || lobbyRes.statusText);
  }
  const roomId = lobbyData.roomId;
  const roomUrl = `${PLAYTEST_BASE}/room/${roomId}`;

  const resolveRes = await playtestFetch("/api/resolve-deck", {
    method: "POST",
    headers: PLAYTEST_JSON_HEADERS,
    body: JSON.stringify({ commanderNames, deckEntries }),
  });
  const resolveData = await resolveRes.json();
  if (!resolveRes.ok || resolveData.error) {
    throw new Error(resolveData.error || resolveRes.statusText);
  }

  // Confirmed via live testing: a room's seat ids can silently revert from the requested
  // seat0/seat1 to hardcoded "you"/"ai" defaults a few seconds after creation. Re-fetching
  // the CURRENT seat list right before loading the deck makes this resilient to that drift.
  const { state: liveState } = await withRoom(roomId, null);
  const humanSeat = liveState.seats?.find((s) => s.controller === "human");
  if (!humanSeat) {
    throw new Error(`No human seat found on room ${roomId} — seats: ${JSON.stringify(liveState.seats)}`);
  }

  await withRoom(roomId, {
    type: "batch",
    actions: [
      {
        type: "loadDeck", player: humanSeat.id, commanderNames, deckEntries,
        cardInfo: resolveData.cardInfo, sourceLabel: deck_name,
      },
      { type: "openingHand", player: humanSeat.id },
    ],
  });

  const commanderLabel = `${commanderNames.join(" / ")} (${consistency.commander_color_identity.length ? consistency.commander_color_identity.join("/") : "Colorless"})`;
  const comboLabel = bracket.combos_found.length
    ? bracket.combos_found.map((c) => `${c.pieces.join(" + ")} (${c.speed})`).join("; ")
    : "None";

  const finalDeliveryText =
    `${decklist_text.trim()}\n\n` +
    `| | |\n|---|---|\n` +
    `| **Price** | $${price.total_usd.toFixed(2)} (Card Kingdom) |\n` +
    `| **Commander** | ${commanderLabel} |\n` +
    `| **Bracket Power** | ${bracket.bracket_estimate} |\n` +
    `| **Combo list** | ${comboLabel} |\n` +
    `| **Wincon(s)** | ${wincon_summary} |\n` +
    `| **General strategy** | ${general_strategy} |\n\n` +
    `${roomUrl}`;

  return { room_id: roomId, room_url: roomUrl, final_delivery_text: finalDeliveryText };
}

export { createPlaytestRoom };
