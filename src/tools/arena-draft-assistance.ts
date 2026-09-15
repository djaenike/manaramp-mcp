/**
 * tools/arena-draft-assistance.ts -- Tool 7: arena_draft_assistance
 * Sequence: read new Player.log lines (offset persisted per path across calls) -> parse draft
 * pack/pick events (Premier/Quick format detection, P1P1 special case) -> resolve every card id
 * in the current pack to real card data via search_cards' arena_id: syntax. Internally exercises:
 * arena-log/log_reader, arena-log/draft_log_parser, arena-log/grpid_resolver -> scryfall/cards.
 *
 * Fundamentally local-machine-only (reads a local Player.log file via fs.statSync/readSync in
 * sub-tools/arena-log/log_reader.ts) -- will never be part of a future remote MCP transport's tool
 * set (see tools/shared/arena-local-state.ts's header comment), unlike the other 6 tools/ files.
 */

import { z } from "zod";
import { LogReader } from "../sub-tools/arena-log/log_reader.js";
import { DraftScanner } from "../sub-tools/arena-log/draft_log_parser.js";
import { resolveGrpIds } from "../sub-tools/arena-log/grpid_resolver.js";
import { loadCardRatings, findLatestCsvInDir } from "../sub-tools/arena-log/card_ratings.js";
import {
  withPersistentGrpIdCache, searchCardsForResolver, resolvePlayerLogPath,
  CARD_RATINGS_DIR, cardRatingsCache,
} from "./shared/arena-local-state.js";
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
  player_log_path: z.string().optional().describe("Absolute path to Arena's Player.log, e.g. 'C:\\\\Users\\\\<name>\\\\AppData\\\\LocalLow\\\\Wizards Of The Coast\\\\MTGA\\\\Player.log'. Optional after the first time it's ever given -- it's remembered on disk and reused automatically, including in later conversations."),
  card_ratings_csv_path: z.string().optional().describe("Absolute path to a card_ratings CSV the user manually exported from 17lands.com/card_ratings. Optional -- omit this to auto-use whatever CSV (if any) is dropped in this server's card_ratings/ folder; only pass this to point at a file somewhere else instead."),
};

const arenaDraftAssistanceTool: ToolDefinition<typeof inputSchema> = {
  name: "arena_draft_assistance",
  description:
    "Read the current MTG Arena draft pack from Player.log and resolve every card in it to real " +
    "card data (name, mana cost, oracle text) for pick advice. Requires 'Detailed Logs (Plugin " +
    "Support)' enabled in Arena's settings and a full relaunch after enabling it. Call this again " +
    "after each pick to see the next pack -- offset/state for a given player_log_path persists " +
    "across calls within this session, so each call only processes what's new since the last one. " +
    "player_log_path is remembered on disk once given, so it's genuinely optional after the first " +
    "call in this server's lifetime, including in a brand-new conversation later -- omit it and the " +
    "last one the user gave (in this or a past conversation) is reused automatically; only pass it " +
    "again if the user gives a different path or this is truly the first time. If it's never been " +
    "given at all, the response will say so plainly -- ask the user for it once, rather than " +
    "guessing a path. " +
    "Supports Premier and Quick Draft; Traditional Draft and Sealed are not yet implemented (see " +
    "draft_log_parser.js). picks_made is the full resolved list of every card picked so far this " +
    "draft (Arena's own log records the actual pick the moment it's made in-client -- you don't need " +
    "the user to tell you what they picked, it's already here on the next call) -- use it to reason " +
    "about the emerging pool (colors/archetype signals so far, curve, what's already covered) rather " +
    "than judging current_pack in isolation. This tool only supplies data, both for the current pack " +
    "and for pick history -- it does not recommend a pick itself. There is no LIVE external win-rate " +
    "data source wired in (this server never calls 17lands.com itself -- their own guidelines " +
    "discourage third-party tools from hitting that site directly). Real win-rate data still gets " +
    "used when available: drop a card_ratings CSV the USER manually exported from " +
    "17lands.com/card_ratings (a normal button on that page, not an API) for the current set/format " +
    "into this server's card_ratings/ folder, and it's picked up automatically (most recently " +
    "modified .csv wins if there's more than one) -- no path needs to be passed for that common " +
    "case. card_ratings_csv_path is only for pointing at a file somewhere else instead. Either way, " +
    "when ratings are loaded, every card in current_pack and picks_made gets a card_ratings_17lands field " +
    "(gih_wr = win rate when actually drawn into hand, 17Lands' own headline 'how good is this " +
    "card' number; alsa = average pick NUMBER this card was last seen still unpicked in a pack " +
    "-- NOT the position it was taken at, that's ata -- so low alsa means it's usually gone " +
    "immediately/highly prized, and a card in your colors sitting in a real pack later than its " +
    "alsa predicts is a live signal that color is more open at your table than average; iih = " +
    "Improvement In Hand, how much win rate actually changes when this card shows up vs. when it " +
    "doesn't, an unweighted difference so a large iih on a small sample can overstate a rare card's " +
    "value -- check it against gih for sample size; null fields mean too small a sample, not a bad " +
    "card). Use those numbers alongside oracle text when they're present; without " +
    "card_ratings_csv_path, fall back to reasoning over real card text/mana costs alone. A card in " +
    "current_pack/picks_made with card: null failed to resolve -- check unresolved_cards for that " +
    "grpId's actual failure reason (e.g. a genuine Scryfall 404 for an oddball print/land variant, " +
    "vs. a transient error) rather than treating every null the same way.",
  inputSchema,
  handler: async ({ player_log_path: providedLogPath, card_ratings_csv_path }) => {
    const player_log_path = resolvePlayerLogPath(providedLogPath);
    if (!player_log_path) {
      return { content: [{ type: "text" as const, text: "No player_log_path given, and none remembered from a previous call. Ask the user for the absolute path to Arena's Player.log (e.g. 'C:\\Users\\<name>\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log') -- once given, it'll be remembered automatically and won't need to be provided again." }] };
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
    // previously-resolved pick costs nothing here now, only genuinely new grpIds hit Scryfall,
    // and that stays true even across a server restart.
    const { cards: resolved, errors: resolveErrors } = await withPersistentGrpIdCache((cache) =>
      resolveGrpIds([...currentPackIds, ...pickedCardIds], searchCardsForResolver, { cache })
    );

    const resolvedRatingsPath = card_ratings_csv_path || findLatestCsvInDir(CARD_RATINGS_DIR);
    let cardRatings: Map<string, any> | null = null;
    let cardRatingsError: string | null = null;
    if (resolvedRatingsPath) {
      if (!cardRatingsCache.has(resolvedRatingsPath)) {
        try {
          cardRatingsCache.set(resolvedRatingsPath, loadCardRatings(resolvedRatingsPath));
        } catch (e: any) {
          cardRatingsError = e.message;
        }
      }
      cardRatings = cardRatingsCache.get(resolvedRatingsPath) ?? null;
    }

    const resolveOne = (id: string) => {
      const card = resolved.get(parseInt(id, 10));
      const enriched: any = card ? { ...((card as any)[0] ?? card) } : { grpId: id, card: null };
      if (cardRatings && enriched.name) {
        enriched.card_ratings_17lands = cardRatings.get(enriched.name.toLowerCase()) ?? null;
      }
      return enriched;
    };
    const enrichedPack = state.currentPack.map(resolveOne);
    const picksMade = state.pickedCards.map(resolveOne);

    return {
      content: [{
        type: "text" as const,
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
          // permanent gap (e.g. a Scryfall arena_id 404 for an oddball print/land variant) from
          // "not attempted this call," rather than both silently collapsing into `card: null`.
          unresolved_cards: Array.from(resolveErrors, ([grpId, error]) => ({ grpId, error })),
          card_ratings_source: !resolvedRatingsPath
            ? `No card ratings loaded -- drop a 17Lands card_ratings CSV export into ${CARD_RATINGS_DIR} (or pass card_ratings_csv_path) for real win-rate/signal data.`
            : cardRatingsError
              ? `Failed to load '${resolvedRatingsPath}': ${cardRatingsError}`
              : `Loaded ${cardRatings!.size} cards from '${resolvedRatingsPath}'${card_ratings_csv_path ? "" : " (auto-discovered)"}.`,
        }, null, 2),
      }],
    };
  },
};

export { arenaDraftAssistanceTool };
