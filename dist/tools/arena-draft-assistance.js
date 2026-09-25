import { z } from "zod";
import { LogReader } from "../functions/parsing/log_reader.js";
import { DraftScanner } from "../functions/parsing/draft_log_parser.js";
import { resolveGrpIds } from "../functions/parsing/grpid_resolver.js";
import { withPersistentGrpIdCache, resolveGrpIdsViaManaramp, resolvePlayerLogPath } from "./shared/arena-local-state.js";
import { parseEventName, packCardView, poolCardLine } from "./shared/arena-card-view.js";
const draftSessions = /* @__PURE__ */ new Map();
function getDraftSession(path) {
  if (!draftSessions.has(path)) {
    draftSessions.set(path, { reader: new LogReader(path), scanner: new DraftScanner() });
  }
  return draftSessions.get(path);
}
const inputSchema = {
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log, e.g. 'C:\\\\Users\\\\<name>\\\\AppData\\\\LocalLow\\\\Wizards Of The Coast\\\\MTGA\\\\Player.log'. Usually not needed at all -- if the user saved this on manaramp.com/mcp-setup, it's fetched from there automatically on first use and cached on disk after that. Only pass it explicitly to override that (a different machine, or nothing saved yet).")
};
const arenaDraftAssistanceTool = {
  name: "arena_draft_assistance",
  // Description trimmed 2026-09-25 alongside the response itself (see arena-card-view.ts) --
  // tool descriptions ride along on every single turn, not just calls to this tool.
  description: "Read the current MTG Arena draft pack from Player.log, with each card's real text and 17Lands stats, for pick advice. Requires 'Detailed Logs (Plugin Support)' enabled in Arena and a relaunch after enabling it. Call again after each pick for the next pack; each call only processes what's new in the log. Supports Premier and Quick Draft (not Traditional/Sealed yet). player_log_path is normally already known (saved on manaramp.com/mcp-setup or remembered from an earlier call) -- only pass it if the user gives a different path; if none is known the response says so, and the user should save it on manaramp.com/mcp-setup. current_pack cards carry the 17Lands row for THIS event's set+format: gih_wr = win rate when drawn (the headline quality number), alsa = average pick number it's last seen unpicked (low = usually gone early; a card in your colors seen later than its alsa signals that color is open), ata = average pick it's taken at, iih = win-rate change when in hand, gih_n = sample size (small samples overstate iih). stats_format appears only when stats come from a different format. Missing stats mean too small a sample, not a bad card -- fall back to card text. picks_made is every pick so far as one line each (Arena logs picks itself; the user doesn't need to say what they took) -- use it to judge colors, curve and archetype, not just the pack in isolation. This tool supplies data only; it doesn't recommend a pick. A current_pack entry with card: null failed to resolve -- see unresolved_cards for why. The draft is saved to the user's manaramp account automatically on every call (draft_result_pushed).",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath }) => {
    const player_log_path = await resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text", text: "No player_log_path given, none saved on manaramp.com/mcp-setup, and none remembered from a previous call. Point the user at manaramp.com/mcp-setup to save it once (recommended), or ask them for the absolute path to Arena's Player.log directly (e.g. 'C:\\Users\\<name>\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log') -- either way, it'll be remembered automatically after that." }] };
    }
    const session = getDraftSession(player_log_path);
    let lines, sessionReset;
    try {
      ({ lines, sessionReset } = session.reader.readNewLines());
    } catch (e) {
      return { content: [{ type: "text", text: `Couldn't read Player.log at '${player_log_path}': ${e.message}` }] };
    }
    if (sessionReset) {
      session.scanner.reset();
    }
    const events = session.scanner.processLines(lines);
    const state = session.scanner.getState();
    const currentPackIds = state.currentPack.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    const pickedCardIds = state.pickedCards.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
    const { cards: resolved, errors: resolveErrors } = await withPersistentGrpIdCache(
      (cache) => resolveGrpIds([...currentPackIds, ...pickedCardIds], resolveGrpIdsViaManaramp, { cache })
    );
    const { set, format } = parseEventName(state.eventName);
    const cardFor = (id) => resolved.get(parseInt(id, 10)) ?? null;
    const enrichedPack = state.currentPack.map((id) => packCardView(id, cardFor(id), set, format));
    const picksMade = state.pickedCards.map((id) => poolCardLine(id, cardFor(id), set, format));
    let draftResultPushed = false;
    let draftResultPushError = null;
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
              grp_ids: p.cards.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n))
            }))
          });
          draftResultPushed = true;
        } catch (e) {
          draftResultPushError = e.message;
        }
      } else {
        draftResultPushError = "No Manaramp API key configured -- set one in this extension's settings to save draft history to your account.";
      }
    }
    return {
      content: [{
        type: "text",
        // Compact JSON, and no per-call event dump (the first call of a session used to list every
        // pack in the whole log) -- counts only. See arena-card-view.ts for the size numbers.
        text: JSON.stringify({
          session_reset: sessionReset || void 0,
          draft_id: state.draftId,
          event_name: state.eventName,
          draft_format: state.draftFormat,
          draft_complete: state.draftComplete || void 0,
          pack_number: state.currentPackNumber,
          pick_number: state.currentPickNumber,
          current_pack: enrichedPack,
          picks_made: picksMade,
          new_this_call: {
            packs_seen: events.filter((e) => e.kind === "packSeen").length,
            picks: events.filter((e) => e.kind === "pickMade").length
          },
          // Only entries actually looked up THIS call appear here (a cached miss from an earlier
          // call won't re-report its reason -- see grpid_resolver.ts) -- distinguishes a real,
          // permanent gap (e.g. a card genuinely missing arena_grp_ids in manaramp's database)
          // from "not attempted this call," rather than both silently collapsing into `card: null`.
          unresolved_cards: resolveErrors.size ? Array.from(resolveErrors, ([grpId, error]) => ({ grpId, error })) : void 0,
          draft_result_pushed: draftResultPushed,
          draft_result_push_error: draftResultPushError ?? void 0
        })
      }]
    };
  }
};
export {
  arenaDraftAssistanceTool
};
