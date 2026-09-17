import { z } from "zod";
import { LogReader } from "../functions/parsing/log_reader.js";
import { DraftScanner } from "../functions/parsing/draft_log_parser.js";
import { resolveGrpIds } from "../functions/parsing/grpid_resolver.js";
import { withPersistentGrpIdCache, resolveGrpIdsViaManaramp, resolvePlayerLogPath } from "./shared/arena-local-state.js";
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
  description: "Read the current MTG Arena draft pack from Player.log and resolve every card in it to real card data (name, mana cost, oracle text) for pick advice. Requires 'Detailed Logs (Plugin Support)' enabled in Arena's settings and a full relaunch after enabling it. Call this again after each pick to see the next pack -- offset/state for a given player_log_path persists across calls within this session, so each call only processes what's new since the last one. player_log_path is usually already known: if the user saved it on manaramp.com/mcp-setup, it's fetched from there automatically the first time this runs and cached on disk after that; otherwise whatever was last given in ANY conversation is remembered the same way. Only pass it explicitly if the user gives a different path. If nothing is known at all (never saved on the website, never given before), the response will say so plainly -- point the user at manaramp.com/mcp-setup rather than asking them to paste it into chat every time. Supports Premier and Quick Draft; Traditional Draft and Sealed are not yet implemented (see draft_log_parser.js). picks_made is the full resolved list of every card picked so far this draft (Arena's own log records the actual pick the moment it's made in-client -- you don't need the user to tell you what they picked, it's already here on the next call) -- use it to reason about the emerging pool (colors/archetype signals so far, curve, what's already covered) rather than judging current_pack in isolation. This tool only supplies data, both for the current pack and for pick history -- it does not recommend a pick itself. Every card in current_pack and picks_made gets a format_stats field -- real 17Lands draft/limited data (gih_wr = win rate when actually drawn into hand, 17Lands' own headline 'how good is this card' number; alsa = average pick NUMBER this card was last seen still unpicked in a pack -- NOT the position it was taken at, that's ata -- so low alsa means it's usually gone immediately/highly prized, and a card in your colors sitting in a real pack later than its alsa predicts is a live signal that color is more open at your table than average; iih = Improvement In Hand, how much win rate actually changes when this card shows up vs. when it doesn't, an unweighted difference so a large iih on a small sample can overstate a rare card's value -- check it against gih for sample size; null fields mean too small a sample, not a bad card), pulled directly from manaramp's own database via this account's configured MANARAMP_API_KEY -- as a RAW array of every set+format this card has data for; match set_code/format against event_name/draft_format above yourself, since this tool only supplies data. This draft's picks and pack-options history are also automatically saved to the user's manaramp account on every call (see draft_result_pushed in the response) -- nothing needs to be done to trigger that beyond calling this tool as normal. Use format_stats numbers alongside oracle text when they're present; without a match, fall back to reasoning over real card text/mana costs alone. A card in current_pack/picks_made with card: null failed to resolve -- check unresolved_cards for that grpId's actual failure reason (a real gap in manaramp's card data vs. a transient network error) rather than treating every null the same way.",
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
    const resolveOne = (id) => {
      const card = resolved.get(parseInt(id, 10));
      return card ? { ...card } : { grpId: id, card: null };
    };
    const enrichedPack = state.currentPack.map(resolveOne);
    const picksMade = state.pickedCards.map(resolveOne);
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
        text: JSON.stringify({
          session_reset: sessionReset,
          new_events_this_call: events,
          draft_format: state.draftFormat,
          event_name: state.eventName,
          pack_number: state.currentPackNumber,
          pick_number: state.currentPickNumber,
          current_pack: enrichedPack,
          picks_made: picksMade,
          picks_made_so_far: picksMade.length,
          // Only entries actually looked up THIS call appear here (a cached miss from an earlier
          // call won't re-report its reason -- see grpid_resolver.ts) -- distinguishes a real,
          // permanent gap (e.g. a card genuinely missing arena_grp_ids in manaramp's database)
          // from "not attempted this call," rather than both silently collapsing into `card: null`.
          unresolved_cards: Array.from(resolveErrors, ([grpId, error]) => ({ grpId, error })),
          draft_result_pushed: draftResultPushed,
          draft_result_push_error: draftResultPushError
        }, null, 2)
      }]
    };
  }
};
export {
  arenaDraftAssistanceTool
};
