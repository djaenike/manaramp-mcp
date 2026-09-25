import { z } from "zod";
import { LogReader } from "../functions/parsing/log_reader.js";
import { extractGreEvents, buildMatchTimeline, createMatchState } from "../functions/parsing/gre_match_parser.js";
import { enrichTimeline } from "../functions/parsing/grpid_resolver.js";
import { withPersistentGrpIdCache, resolveGrpIdsViaManaramp, resolvePlayerLogPath } from "./shared/arena-local-state.js";
import { gameCardView } from "./shared/arena-card-view.js";
const matchSessions = /* @__PURE__ */ new Map();
function getMatchSession(path) {
  if (!matchSessions.has(path)) {
    matchSessions.set(path, { reader: new LogReader(path), state: createMatchState(), fullTimeline: [], shownGrpIds: /* @__PURE__ */ new Set() });
  }
  return matchSessions.get(path);
}
const inputSchema = {
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log. Usually not needed -- if the user saved this on manaramp.com/mcp-setup, it's fetched from there automatically on first use and cached on disk after that. Only pass it explicitly to override that.")
};
const arenaDraftGameAdviceTool = {
  name: "arena_draft_game_advice",
  description: "Read new match/game events from Player.log since the last call and return a turn-by-turn timeline (land plays, spells cast, resolves, attacks, damage, life changes, match result) with every card resolved to its real name; each card's text appears once in `cards`, the first time it shows up this session. Requires 'Detailed Logs (Plugin Support)' enabled in Arena and a full relaunch after enabling it. Call this again as the game progresses -- state for a given player_log_path (including the running instanceId->card map) persists across calls, so each call only returns what's new. Only ANNOTATED, CONFIRMED events are reported (an ActionsAvailableReq listing a legal option is never reported as something that happened -- only an actual ZoneTransfer/ObjectsSelected/damage annotation is). This tool only supplies data -- it does not give advice directly; reason over the returned timeline to actually advise on the game. player_log_path is usually already known (shared with arena_draft_assistance): fetched from manaramp.com/mcp-setup automatically on first use if the user saved it there, or whatever was last given in any conversation otherwise. If a MANARAMP_API_KEY is configured (this extension's settings in Claude Desktop), the FULL match timeline is automatically pushed to the user's manaramp account the moment a matchResult event appears (pushed_game_log_id confirms it; push_error explains why not, e.g. no key configured) -- nothing needs to be done to trigger this beyond calling the tool as normal through the end of a match.",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath }) => {
    const player_log_path = await resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text", text: "No player_log_path given, none saved on manaramp.com/mcp-setup, and none remembered from a previous call. Point the user at manaramp.com/mcp-setup to save it once (recommended), or ask them for the absolute path to Arena's Player.log directly -- either way, it'll be remembered automatically after that." }] };
    }
    const session = getMatchSession(player_log_path);
    let lines, sessionReset;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.state = createMatchState();
      session.fullTimeline = [];
      session.shownGrpIds = /* @__PURE__ */ new Set();
    }
    const { events, droppedCount } = extractGreEvents(lines);
    const { timeline, state: updatedState } = buildMatchTimeline(events, session.state);
    session.state = updatedState;
    const enrichedTimeline = await withPersistentGrpIdCache(
      (cache) => enrichTimeline(timeline, resolveGrpIdsViaManaramp, { cache })
    );
    session.fullTimeline.push(...enrichedTimeline);
    let pushedGameLogId = null;
    let pushError = null;
    const matchResultEvent = enrichedTimeline.find((e) => e?.kind === "matchResult");
    if (matchResultEvent) {
      if (process.env.MANARAMP_API_KEY) {
        try {
          const { callRemoteTool } = await import("./shared/remote-client.js");
          const result = await callRemoteTool("push_game_log", {
            events: session.fullTimeline,
            result: JSON.stringify(matchResultEvent.results ?? matchResultEvent.matchState ?? null)
          });
          pushedGameLogId = result.game_log_id;
        } catch (e) {
          pushError = e.message;
        }
      } else {
        pushError = "No Manaramp API key configured -- set one in this extension's settings to save match history to your account.";
      }
      session.fullTimeline = [];
    }
    const newCards = {};
    const collectCards = (node) => {
      if (Array.isArray(node)) {
        node.forEach(collectCards);
        return;
      }
      if (!node || typeof node !== "object") return;
      const obj = node;
      if (obj.grpId != null && obj.card && !session.shownGrpIds.has(obj.grpId)) {
        session.shownGrpIds.add(obj.grpId);
        newCards[obj.card.name ?? obj.grpId] = gameCardView(obj.card);
      }
      for (const [k, v] of Object.entries(obj)) if (k !== "card") collectCards(v);
    };
    collectCards(enrichedTimeline);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_reset: sessionReset || void 0,
          dropped_summarized_blocks: droppedCount || void 0,
          new_timeline_events: enrichedTimeline,
          cards: Object.keys(newCards).length ? newCards : void 0,
          pushed_game_log_id: pushedGameLogId ?? void 0,
          push_error: pushError ?? void 0
        }, (key, value) => key === "card" ? value?.name ?? null : value)
      }]
    };
  }
};
export {
  arenaDraftGameAdviceTool
};
