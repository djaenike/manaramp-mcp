/**
 * tools/arena-draft-assistance.ts -- Tool 7: arena_draft_assistance
 * Sequence: read new Player.log lines (offset persisted per path across calls) -> parse draft
 * pack/pick events (Premier/Quick format detection, P1P1 special case) -> resolve every card id
 * in the current pack to real card data via manaramp's own `cards` collection (arena_grp_ids
 * field), over the authenticated remote query_cards call -> push the accumulated picks/pack
 * history to manaramp's draft_results collection. Internally exercises: arena-log/log_reader,
 * arena-log/draft_log_parser, arena-log/grpid_resolver -> tools/shared/remote-client.
 *
 * Fundamentally local-machine-only (reads a local Player.log file via fs.statSync/readSync in
 * functions/parsing/log_reader.ts) -- will never be part of a future remote MCP transport's tool
 * set (see tools/shared/arena-local-state.ts's header comment), unlike tools/shared/deck-analysis.ts (optimize_deck/publish_deck).
 *
 * NO LIVE SCRYFALL CALLS AT ALL anymore (2026-09-17, second pass) -- grpId resolution used to fall
 * back to a live `arena_id:` search since this tool has no direct Mongo connection; that's gone
 * now, since cards.arena_grp_ids is already ingested data manaramp's own query_cards tool can
 * query (see tools/shared/arena-local-state.ts's resolveGrpIdsViaManaramp). The manual card_ratings
 * CSV drop-in mechanism this tool used to also support was removed the same day, superseded by the
 * same remote lookup's format_stats field.
 */

import { z } from "zod";
import { LogReader } from "../functions/parsing/log_reader.js";
import { DraftScanner } from "../functions/parsing/draft_log_parser.js";
import { resolveGrpIds } from "../functions/parsing/grpid_resolver.js";
import { withPersistentGrpIdCache, resolveGrpIdsViaManaramp, resolvePlayerLogPath } from "./shared/arena-local-state.js";
import { parseEventName, packCardView, sortPackForPicking, poolSummary, poolCardLine } from "./shared/arena-card-view.js";
import type { ToolDefinition } from "./types.js";

// --- Per-log-path session state -------------------------------------------------------------
// Player.log is rewritten from scratch every Arena launch, and draft parsing needs to persist its
// offset/state ACROSS separate tool calls (each pick is its own call) -- one reader/scanner set
// per path, created on first use and reused after.
const draftSessions = new Map<string, { reader: LogReader; scanner: DraftScanner }>();

function getDraftSession(path: string) {
  if (!draftSessions.has(path)) {
    draftSessions.set(path, { reader: new LogReader(path), scanner: new DraftScanner() });
  }
  return draftSessions.get(path)!;
}

const inputSchema = {
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log, e.g. 'C:\\\\Users\\\\<name>\\\\AppData\\\\LocalLow\\\\Wizards Of The Coast\\\\MTGA\\\\Player.log'. Usually not needed at all -- if the user saved this on manaramp.com/mcp-setup, it's fetched from there automatically on first use and cached on disk after that. Only pass it explicitly to override that (a different machine, or nothing saved yet)."),
};

const arenaDraftAssistanceTool: ToolDefinition<typeof inputSchema> = {
  name: "arena_draft_assistance",
  // Description trimmed 2026-09-25 alongside the response itself (see arena-card-view.ts) --
  // tool descriptions ride along on every single turn, not just calls to this tool.
  description:
    "Read the current MTG Arena draft pack from Player.log, with each card's real text and 17Lands " +
    "stats, for pick advice. Requires 'Detailed Logs (Plugin Support)' enabled in Arena and a relaunch " +
    "after enabling it. Call again after each pick for the next pack; each call only processes what's " +
    "new in the log. Supports Premier and Quick Draft (not Traditional/Sealed yet). " +
    "player_log_path is normally already known (saved on manaramp.com/mcp-setup or remembered from an " +
    "earlier call) -- only pass it if the user gives a different path; if none is known the response " +
    "says so, and the user should save it on manaramp.com/mcp-setup. " +
    "current_pack cards carry the 17Lands row for THIS event's set+format: gih_wr = games-in-hand win " +
    "rate, alsa = average pick number it's last seen unpicked (low = usually gone early), ata = average " +
    "pick it's taken at, iih = win-rate change when in hand, gih_n = sample size. stats_format appears " +
    "only when stats come from a different format. current_pack is already sorted best-first by " +
    "gih_wr, then (for cards 17Lands has no gih_wr for -- it withholds it below its sample threshold, " +
    "common early in a set; that's not a bad card) by alsa. " +
    "HOW TO RECOMMEND A PICK: (1) gih_wr is the primary ranking -- start from the top of current_pack. " +
    "Without gih_wr, use alsa and the card's own text. (2) Weigh it against pool_summary (the picks so " +
    "far: colors with card counts and avg gih_wr, leading_colors, curve, creatures/noncreatures, and " +
    "roles: removal/card_advantage/tokens). Early in pack 1, take the strongest card almost regardless " +
    "of color; once leading_colors is established (roughly mid pack 1 onward), prefer a slightly lower " +
    "gih_wr card in those colors over a higher one off-color, and favor what the pool is short on " +
    "(removal, 2-drops, enough creatures -- ~15 by the end). (3) Recommend a PIVOT, explicitly, when " +
    "the evidence supports it: strong cards in another color keep arriving with seen_late: true (still " +
    "here more than a pick past their alsa, a sign that color is open at this table), and that color's " +
    "quality beats your weaker leading color's avg_gih_wr, while there are still picks left to build it " +
    "-- say which color to move into and what to drop. Give the pick, a one-line reason, and the " +
    "runner-up. picks_made lists every pick so far (Arena logs picks itself; the user doesn't need to " +
    "say what they took). A current_pack entry with card: null failed to resolve -- see " +
    "unresolved_cards. The draft is saved to the user's manaramp account automatically on every call " +
    "(draft_result_pushed).",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath }) => {
    const player_log_path = await resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text" as const, text: "No player_log_path given, none saved on manaramp.com/mcp-setup, and none remembered from a previous call. Point the user at manaramp.com/mcp-setup to save it once (recommended), or ask them for the absolute path to Arena's Player.log directly (e.g. 'C:\\Users\\<name>\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log') -- either way, it'll be remembered automatically after that." }] };
    }

    const session = getDraftSession(player_log_path);
    let lines: string[], sessionReset: boolean;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.scanner.reset();
    }

    const events = session.scanner.processLines(lines);
    const state = session.scanner.getState();

    // Resolve the current pack AND everything picked so far in one batch (resolveGrpIds
    // dedupes internally) -- picks_made needs real card data too, not just a count, so Claude
    // can actually reason about the emerging pool (colors leaned into, archetype signals),
    // not just how many picks have happened.
    const currentPackIds = state.currentPack.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    const pickedCardIds = state.pickedCards.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    // grpIdCardCache is shared and disk-persisted (see arena-local-state.ts) -- every
    // previously-resolved pick costs nothing here now, only genuinely new grpIds hit manaramp,
    // and that stays true even across a server restart.
    const { cards: resolved, errors: resolveErrors } = await withPersistentGrpIdCache((cache) =>
      resolveGrpIds([...currentPackIds, ...pickedCardIds], resolveGrpIdsViaManaramp, { cache })
    );

    const { set, format } = parseEventName(state.eventName);
    const cardFor = (id: string) => (resolved.get(parseInt(id, 10)) as Record<string, any> | null | undefined) ?? null;
    // Pack pre-ranked by GIH WR (see sortPackForPicking) and the pool pre-summarized (colors, curve,
    // roles) -- 2026-09-26, so the pick-priority rules in this tool's description have the numbers
    // they reference sitting right there instead of being re-derived from raw lists every pick.
    const enrichedPack = sortPackForPicking(
      state.currentPack.map((id) => packCardView(id, cardFor(id), set, format, state.currentPickNumber))
    );
    const picksMade = state.pickedCards.map((id) => poolCardLine(id, cardFor(id), set, format));
    const pool = poolSummary(state.pickedCards.map(cardFor), set, format);

    // Save this draft's picks/pack-options to the user's manaramp account on every call -- see
    // tools/internal-tools.ts's push_draft_result wrapper (-> functions/push/draft-result.ts).
    // Best-effort: a failed push never blocks this tool's own response, since the pick data
    // itself is already fully returned above regardless.
    let draftResultPushed = false;
    let draftResultPushError: string | null = null;
    if (state.draftId) {
      if (process.env.MANARAMP_API_KEY) {
        try {
          const { callRemoteTool } = await import("./shared/remote-client.js");
          await callRemoteTool("push_draft_result", {
            draft_id: state.draftId,
            event_name: state.eventName,
            draft_format: state.draftFormat,
            picks: pickedCardIds,
            packs_seen: state.packsSeen.map((p) => ({
              pack_number: p.packNumber,
              pick_number: p.pickNumber,
              grp_ids: p.cards.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n)),
            })),
          });
          draftResultPushed = true;
        } catch (e: any) {
          draftResultPushError = e.message;
        }
      } else {
        draftResultPushError = "No Manaramp API key configured -- set one in this extension's settings to save draft history to your account.";
      }
    }

    return {
      content: [{
        type: "text" as const,
        // Compact JSON, and no per-call event dump (the first call of a session used to list every
        // pack in the whole log) -- counts only. See arena-card-view.ts for the size numbers.
        text: JSON.stringify({
          session_reset: sessionReset || undefined,
          draft_id: state.draftId,
          event_name: state.eventName,
          draft_format: state.draftFormat,
          draft_complete: state.draftComplete || undefined,
          pack_number: state.currentPackNumber,
          pick_number: state.currentPickNumber,
          current_pack: enrichedPack,
          pool_summary: pool,
          picks_made: picksMade,
          new_this_call: {
            packs_seen: events.filter((e) => e.kind === "packSeen").length,
            picks: events.filter((e) => e.kind === "pickMade").length,
          },
          // Only entries actually looked up THIS call appear here (a cached miss from an earlier
          // call won't re-report its reason -- see grpid_resolver.ts) -- distinguishes a real,
          // permanent gap (e.g. a card genuinely missing arena_grp_ids in manaramp's database)
          // from "not attempted this call," rather than both silently collapsing into `card: null`.
          unresolved_cards: resolveErrors.size ? Array.from(resolveErrors, ([grpId, error]) => ({ grpId, error })) : undefined,
          draft_result_pushed: draftResultPushed,
          draft_result_push_error: draftResultPushError ?? undefined,
        }),
      }],
    };
  },
};

export { arenaDraftAssistanceTool };
