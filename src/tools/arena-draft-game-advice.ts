/**
 * tools/arena-draft-game-advice.ts -- Tool 8: arena_draft_game_advice
 * Sequence: read new Player.log lines (separate offset stream from the draft tool, same file) ->
 * parse GRE match events into a turn-by-turn timeline -> resolve every grpId referenced in it to
 * real card data. Internally exercises: arena-log/log_reader, arena-log/gre_match_parser,
 * arena-log/grpid_resolver -> scryfall/cards.
 *
 * Fundamentally local-machine-only (reads a local Player.log file, same as arena-draft-assistance.ts)
 * -- will never be part of a future remote MCP transport's tool set (see
 * tools/shared/arena-local-state.ts's header comment), unlike the other 6 tools/ files.
 */

import { z } from "zod";
import { LogReader } from "../sub-tools/arena-log/log_reader.js";
import { extractGreEvents, buildMatchTimeline, createMatchState, type MatchState } from "../sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline } from "../sub-tools/arena-log/grpid_resolver.js";
import { withPersistentGrpIdCache, searchCardsForResolver, resolvePlayerLogPath } from "./shared/arena-local-state.js";
import type { ToolDefinition } from "./types.js";

// --- Per-log-path session state -------------------------------------------------------------
// Match parsing needs to persist its offset/state ACROSS separate tool calls (each poll is its
// own call), just like the draft tool's own session map -- one reader/state set per path, created
// on first use and reused after.
const matchSessions = new Map<string, { reader: LogReader; state: MatchState }>();

function getMatchSession(path: string) {
  if (!matchSessions.has(path)) {
    matchSessions.set(path, { reader: new LogReader(path), state: createMatchState() });
  }
  return matchSessions.get(path)!;
}

const inputSchema = {
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log. Optional after the first time it's ever given -- remembered on disk and reused automatically, including in later conversations."),
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
    "player_log_path is remembered on disk once given (shared with arena_draft_assistance), so it's " +
    "genuinely optional after the first time -- omit it and the last one given (in this or a past " +
    "conversation) is reused automatically.",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath }) => {
    const player_log_path = resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text" as const, text: "No player_log_path given, and none remembered from a previous call. Ask the user for the absolute path to Arena's Player.log -- once given, it'll be remembered automatically and won't need to be provided again." }] };
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
    }

    const { events, droppedCount } = extractGreEvents(lines);
    const { timeline, state: updatedState } = buildMatchTimeline(events, session.state);
    session.state = updatedState;

    // Shares the same disk-persisted grpIdCardCache as arena_draft_assistance -- a card drafted
    // earlier (or seen earlier this same match, even in a past session) needs zero extra Scryfall
    // calls to resolve here.
    const enrichedTimeline = await withPersistentGrpIdCache((cache) =>
      enrichTimeline(timeline, searchCardsForResolver, { cache })
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          session_reset: sessionReset,
          dropped_summarized_blocks: droppedCount,
          new_timeline_events: enrichedTimeline,
        }, null, 2),
      }],
    };
  },
};

export { arenaDraftGameAdviceTool };
