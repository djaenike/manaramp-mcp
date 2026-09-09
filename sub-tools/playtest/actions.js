/**
 * sub-tools/playtest/actions.js
 */

import { playtestFetch, withRoom, PLAYTEST_JSON_HEADERS } from "./client.js";
import { summarizeState, parsePlaytestDecklist } from "./state.js";

async function getState(room_id) {
  const { state } = await withRoom(room_id, null);
  return summarizeState(state);
}

async function loadDeck({ room_id, seat_id, decklist_text, commander_name, auto_opening_hand }) {
  if (decklist_text && commander_name) {
    throw new Error("Provide either decklist_text or commander_name, not both.");
  }

  let commanderNames, deckEntries, cardInfo, notFound, sourceLabel;

  if (decklist_text) {
    ({ commanderNames, deckEntries } = parsePlaytestDecklist(decklist_text));
    if (!commanderNames.length && !deckEntries.length) {
      throw new Error("No cards found in decklist_text — check the '<qty> <name>' formatting.");
    }
    const res = await playtestFetch("/api/resolve-deck", {
      method: "POST", headers: PLAYTEST_JSON_HEADERS,
      body: JSON.stringify({ commanderNames, deckEntries }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`Deck resolution failed: ${data.error || res.statusText}`);
    }
    ({ cardInfo, notFound } = data);
    sourceLabel = "Imported deck";
  } else {
    const res = await playtestFetch("/api/random-deck", {
      method: "POST", headers: PLAYTEST_JSON_HEADERS,
      body: JSON.stringify(commander_name ? { commander: commander_name } : {}),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`Random deck request failed: ${data.error || res.statusText}`);
    }
    ({ commander: commanderNames, deckEntries, cardInfo, notFound } = data);
    sourceLabel = `Random deck: EDHREC average build for "${data.sourceCommander}"`;
  }

  const wsActions = [{ type: "loadDeck", player: seat_id, commanderNames, deckEntries, cardInfo, sourceLabel }];
  if (auto_opening_hand !== false) wsActions.push({ type: "openingHand", player: seat_id });
  const finalAction = wsActions.length > 1 ? { type: "batch", actions: wsActions } : wsActions[0];
  const { state, batchErrors } = await withRoom(room_id, finalAction);

  return {
    loaded_for: seat_id,
    source: sourceLabel,
    not_found: notFound?.length ? notFound : undefined,
    batch_errors: batchErrors?.length ? batchErrors : undefined,
    state: summarizeState(state),
  };
}

async function doAction({ room_id, type, player, card_name, from_zone, to_zone, zone, name, counter_type, delta, actions }) {
  const action = { type };
  if (type === "batch") {
    action.actions = actions ?? [];
  } else {
    if (player !== undefined) action.player = player;
    if (card_name !== undefined) action.cardName = card_name;
    if (from_zone !== undefined) action.fromZone = from_zone;
    if (to_zone !== undefined) action.toZone = to_zone;
    if (zone !== undefined) action.zone = zone;
    if (name !== undefined) action.name = name;
    if (counter_type !== undefined) action.counterType = counter_type;
    if (delta !== undefined) action.delta = delta;
  }
  const { state, batchErrors } = await withRoom(room_id, action);
  if (state === null) {
    return { ended: true };
  }
  return { state: summarizeState(state), batch_errors: batchErrors?.length ? batchErrors : undefined };
}

export { getState, loadDeck, doAction };
