/**
 * tools/arena-draft-game-advice.ts -- Tool 8: arena_draft_game_advice
 * Sequence: read new Player.log lines (separate offset stream from the draft tool, same file) ->
 * parse GRE match events into a turn-by-turn timeline -> resolve every grpId referenced in it to
 * real card data via manaramp's own `cards` collection (arena_grp_ids field), over the
 * authenticated remote query_cards call -- NOT live Scryfall (removed 2026-09-17, second pass,
 * see tools/shared/arena-local-state.ts's resolveGrpIdsViaManaramp). Internally exercises:
 * arena-log/log_reader, arena-log/gre_match_parser, arena-log/grpid_resolver -> remote-client.
 *
 * Fundamentally local-machine-only (reads a local Player.log file, same as arena-draft-assistance.ts)
 * -- will never be part of a future remote MCP transport's tool set (see
 * tools/shared/arena-local-state.ts's header comment), unlike tools/shared/deck-analysis.ts (optimize_deck/publish_deck).
 *
 * Pushes the full match log to manaramp's game_logs collection (2026-09-17) the moment a
 * "matchResult" event appears -- via tools/internal-tools.ts's push_game_log wrapper (->
 * functions/push/game-log.ts), reached over tools/shared/remote-client.ts, using
 * MANARAMP_API_KEY (manifest.json's user_config). Accumulates every enriched event across calls in
 * `fullTimeline` specifically for this (each call only returns what's NEW since the last one, but
 * the push needs the WHOLE match) -- reset once pushed, so the next match starts a fresh log.
 * Silently skipped (this tool still returns its normal timeline either way) if no key is
 * configured -- see push_error/pushed_game_log_id in the response for what happened.
 */

import { z } from "zod";
import { LogReader } from "../functions/parsing/log_reader.js";
import { extractGreEvents, buildMatchTimeline, createMatchState, type MatchState } from "../functions/parsing/gre_match_parser.js";
import { enrichTimeline } from "../functions/parsing/grpid_resolver.js";
import { withPersistentGrpIdCache, resolveGrpIdsViaManaramp, resolvePlayerLogPath } from "./shared/arena-local-state.js";
import type { ToolDefinition } from "./types.js";

// --- Per-log-path session state -------------------------------------------------------------
// Match parsing needs to persist its offset/state ACROSS separate tool calls (each poll is its
// own call), just like the draft tool's own session map -- one reader/state set per path, created
// on first use and reused after. fullTimeline accumulates every enriched event since the last
// match-result push (see file header).
const matchSessions = new Map<string, { reader: LogReader; state: MatchState; fullTimeline: unknown[] }>();

function getMatchSession(path: string) {
  if (!matchSessions.has(path)) {
    matchSessions.set(path, { reader: new LogReader(path), state: createMatchState(), fullTimeline: [] });
  }
  return matchSessions.get(path)!;
}

const inputSchema = {
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log. Usually not needed -- if the user saved this on manaramp.com/mcp-setup, it's fetched from there automatically on first use and cached on disk after that. Only pass it explicitly to override that."),
};

const arenaDraftGameAdviceTool: ToolDefinition<typeof inputSchema> = {
  name: "arena_draft_game_advice",
  description:
    "Read new match/game events from Player.log since the last call and return a turn-by-turn " +
    "timeline (land plays, spells cast, resolves, attacks, damage, life changes, match result) with " +
    "every card resolved to its real name and oracle text. Requires 'Detailed Logs (Plugin Support)' " +
    "enabled in Arena and a full relaunch after enabling it. Call this again as the game progresses -- " +
    "state for a given player_log_path (including the running instanceId->card map) persists across " +
    "calls, so each call only returns what's new. Only ANNOTATED, CONFIRMED events are reported (an " +
    "ActionsAvailableReq listing a legal option is never reported as something that happened -- only " +
    "an actual ZoneTransfer/ObjectsSelected/damage annotation is). This tool only supplies data -- it " +
    "does not give advice directly; reason over the returned timeline to actually advise on the game. " +
    "player_log_path is usually already known (shared with arena_draft_assistance): fetched from " +
    "manaramp.com/mcp-setup automatically on first use if the user saved it there, or whatever was " +
    "last given in any conversation otherwise. If a MANARAMP_API_KEY is configured (this extension's " +
    "settings in Claude Desktop), the FULL match timeline is automatically pushed to the user's " +
    "manaramp account the moment a matchResult event appears (pushed_game_log_id confirms it; " +
    "push_error explains why not, e.g. no key configured) -- nothing needs to be done to trigger " +
    "this beyond calling the tool as normal through the end of a match.",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath }) => {
    const player_log_path = await resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text" as const, text: "No player_log_path given, none saved on manaramp.com/mcp-setup, and none remembered from a previous call. Point the user at manaramp.com/mcp-setup to save it once (recommended), or ask them for the absolute path to Arena's Player.log directly -- either way, it'll be remembered automatically after that." }] };
    }

    const session = getMatchSession(player_log_path);
    let lines: string[], sessionReset: boolean;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.state = createMatchState();
      session.fullTimeline = [];
    }

    const { events, droppedCount } = extractGreEvents(lines);
    const { timeline, state: updatedState } = buildMatchTimeline(events, session.state);
    session.state = updatedState;

    // Shares the same disk-persisted grpIdCardCache as arena_draft_assistance -- a card drafted
    // earlier (or seen earlier this same match, even in a past session) needs zero extra Scryfall
    // calls to resolve here.
    const enrichedTimeline = await withPersistentGrpIdCache((cache) =>
      enrichTimeline(timeline, resolveGrpIdsViaManaramp, { cache })
    );
    session.fullTimeline.push(...enrichedTimeline);

    let pushedGameLogId: string | null = null;
    let pushError: string | null = null;
    const matchResultEvent = enrichedTimeline.find((e: any) => e?.kind === "matchResult") as any;
    if (matchResultEvent) {
      if (process.env.MANARAMP_API_KEY) {
        try {
          const { callRemoteTool } = await import("./shared/remote-client.js");
          const result = await callRemoteTool<{ game_log_id: string }>("push_game_log", {
            events: session.fullTimeline,
            result: JSON.stringify(matchResultEvent.results ?? matchResultEvent.matchState ?? null),
          });
          pushedGameLogId = result.game_log_id;
        } catch (e: any) {
          pushError = e.message;
        }
      } else {
        pushError = "No Manaramp API key configured -- set one in this extension's settings to save match history to your account.";
      }
      // Reset regardless of push success/failure -- a failed push shouldn't keep re-accumulating
      // and re-attempting on every future call for a match that's already over.
      session.fullTimeline = [];
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          session_reset: sessionReset,
          dropped_summarized_blocks: droppedCount,
          new_timeline_events: enrichedTimeline,
          pushed_game_log_id: pushedGameLogId,
          push_error: pushError,
        }, null, 2),
      }],
    };
  },
};

export { arenaDraftGameAdviceTool };
