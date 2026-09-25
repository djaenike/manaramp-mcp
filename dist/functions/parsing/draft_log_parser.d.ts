/**
 * draft_log_parser.ts
 *
 * Parses DRAFT (pack/pick) events out of Player.log lines -- a distinct event
 * stream from match/GRE data (see gre_match_parser.js), using different marker
 * strings entirely.
 *
 * PICK marker strings and payload shapes below were corrected by reading two
 * independently-maintained, currently-active real parsers directly (not
 * secondhand docs): 17Lands' own official log client
 * (rconroy293/mtga-log-client, src/python/seventeenlands/mtga_follower.py)
 * and manasight-parser (manasight/manasight-parser,
 * src/parsers/draft/{human,bot}.rs, MIT/Apache-2.0, with its own test
 * fixtures against real log text). An earlier revision of this file, based on
 * an older/archived community tool, had the Premier/Traditional pick event
 * name and field shape simply wrong (it would never match a real log line),
 * and the Quick Draft pick parser had an extra incorrect JSON-unwrap step
 * plus a singular-vs-array field name mismatch -- both would have left
 * `pickedCards` permanently empty against a real draft. PACK parsing (this
 * file's other half) was not touched -- no evidence surfaced that it's wrong.
 *
 * Confirmed format-specific quirks baked in below:
 *   - Premier/Traditional draft's FIRST pick (P1P1) is never sent via the
 *     normal pack marker -- it only shows up via a separate "CardsInPack"
 *     marker. Miss this and pick 1 is silently absent from your data.
 *   - Premier draft's normal pack payload ("Draft.Notify") encodes the pack
 *     as a COMMA-SEPARATED STRING ("PackCards"), while P1P1's payload
 *     ("CardsInPack") and Quick Draft's payload both use a real JSON array.
 *     Don't assume one shape across formats.
 *   - Premier/Traditional draft's human PICK event is `EventPlayerDraftMakePick`
 *     (NOT `Draft.MakeHumanDraftPick`, which does not appear in real logs).
 *     Its payload shape has been observed to vary: the pick fields
 *     (card id, pack/pick number) can sit at the top level, nested under a
 *     `PickInfo` key, or string-escaped inside a `request` field -- check all
 *     three rather than assuming one. The card id itself may be `CardId`
 *     (singular) or the first entry of a `GrpIds`/`CardIds` array.
 *   - Quick Draft's PICK event name appears in real logs as either
 *     `BotDraftDraftPick` or `BotDraft_DraftPick` (17Lands' own client
 *     explicitly checks both forms "to handle different Arena log formats" --
 *     don't anchor on just one). Its `request` field parses directly to
 *     `{ EventName, PickInfo }` -- there is NO extra `.Payload` layer on the
 *     pick-request side (unlike the pack-status side, which does have one).
 *     `PickInfo.CardIds` is an array; a first entry of `0` is a "no card
 *     resolved yet" sentinel, not a real pick -- skip it.
 *   - Quick Draft pack/pick numbers are 0-indexed in the raw payload; add 1
 *     before treating them as human-facing pack/pick numbers.
 *   - Quick Draft's pack marker fires on every state poll, not just when a
 *     new pack is ready -- gate on `DraftStatus === "PickNext"` or you'll
 *     process stale/duplicate pack data.
 *
 *   - DRAFT ID (fixed 2026-09-25, against a real Quick Draft log): the draft-start request lines
 *     appear as `==> EventJoin` / `==> BotDraftDraftStatus` (no underscores) -- the underscored
 *     forms this file originally matched never occurred, so draftId stayed null and nothing was
 *     ever pushed. Their `request` also carries EventName directly (no nested Payload string), and
 *     their `id` is a random PER-REQUEST id, not a draft id, so it was never a usable key anyway.
 *     The real stable id is the Course: Arena logs `"CourseId":"...","InternalEventName":"..."` in
 *     the EventJoin response and in every EventGetCoursesV2 refresh, so the scanner records every
 *     CourseId it sees by event name and uses the one for the current draft's event. Premier's own
 *     Draft.Notify `draftId` wins when present; a hash of the event name plus P1P1's pack is the
 *     last-resort fallback (still deterministic, so re-pushes upsert the same record).
 *
 * NOT yet implemented: Traditional Draft and Sealed formats use their own
 * separate marker strings again (traditional shares some shape with premier
 * but is a distinct code path in the reference tools above). Left as a TODO
 * rather than guessed at.
 */
interface DraftStartInfo {
    eventName: string;
    /** true for EventJoin (a paid entry, always a brand-new draft); false for a DraftStatus poll,
     *  which also fires when resuming an in-progress draft. */
    isJoin: boolean;
}
interface PackInfo {
    draftId?: string;
    packNumber: number;
    pickNumber: number;
    cards: string[];
}
interface PickInfo {
    packNumber: number;
    pickNumber: number;
    cardId: string;
}
interface DraftEvent {
    kind: "draftStart" | "packSeen" | "pickMade";
    [key: string]: unknown;
}
interface DraftState {
    draftFormat: "premier" | "quick" | null;
    draftId: string | null;
    eventName: string | null;
    currentPack: string[];
    currentPackNumber: number;
    currentPickNumber: number;
    pickedCards: string[];
    packsSeen: Array<{
        packNumber: number;
        pickNumber: number;
        cards: string[];
    }>;
    draftComplete: boolean;
}
/**
 * Detect a draft-start line and classify (loosely -- full set/type
 * classification from the reference tool requires its bundled set-list data,
 * which we don't have here). Returns the raw EventName for the caller to
 * classify against their own set/format list, e.g. via existing
 * limited_sets metadata elsewhere in your MCP.
 */
declare function detectDraftStart(lines: string[]): DraftStartInfo | null;
/**
 * Parses Premier Draft's P1P1 pack (separate from every subsequent pack).
 */
declare function parsePremierP1P1(line: string): PackInfo | null;
/**
 * Parses Premier Draft's normal (post-P1P1) pack broadcasts.
 */
declare function parsePremierPack(line: string): PackInfo | null;
/**
 * Parses Premier/Traditional Draft's human pick confirmation
 * (`EventPlayerDraftMakePick`). Only the `==>` request carries useful data --
 * the paired `<==` response only confirms success. The pick fields
 * themselves have been observed in three different shapes across real logs
 * (top-level, under `PickInfo`, or string-escaped inside `request`), so all
 * three are checked rather than assuming one.
 */
declare function parseHumanDraftPick(line: string): PickInfo | null;
/**
 * Parses Quick Draft's pack broadcast. Returns null if this poll isn't
 * actually presenting a new pack to pick from (DraftStatus !== "PickNext").
 */
type QuickPackResult = (PackInfo & {
    eventName?: string;
    pickedSoFar: string[];
    completed?: false;
}) | {
    completed: true;
    eventName?: string;
};
declare function parseQuickPack(line: string): QuickPackResult | null;
/**
 * Parses Quick Draft's pick confirmation (the `==>` request side only -- the
 * paired `<==` response confirms success plus the next pack, not the pick
 * itself). `request` parses directly to `{ EventName, PickInfo }`, with NO
 * `.Payload` wrapper (that only exists on the pack-status side).
 */
declare function parseQuickPick(line: string): PickInfo | null;
/**
 * Stateful scanner: feed it successive batches of new lines (e.g. straight
 * from LogReader.readNewLines().lines) and it maintains current pack/pick
 * state across calls, matching a single draft session.
 */
declare class DraftScanner {
    draftFormat: "premier" | "quick" | null;
    eventName: string | null;
    seenP1P1: boolean;
    currentPack: string[];
    currentPackNumber: number;
    currentPickNumber: number;
    pickedCards: string[];
    /** Every pack ever shown this draft, in order -- unlike currentPack (overwritten on each new
     *  pack), this accumulates so push_draft_result can save the FULL options history, not just
     *  whatever's showing right now. */
    packsSeen: Array<{
        packNumber: number;
        pickNumber: number;
        cards: string[];
    }>;
    /** Premier's own Draft.Notify draftId, when seen -- preferred over the CourseId lookup. */
    premierDraftId: string | null;
    /** Every CourseId seen in the log so far, keyed by InternalEventName -- NOT cleared between
     *  drafts, since the course-list lines can appear long before the draft itself starts. */
    courseIdsByEvent: Map<string, string>;
    draftComplete: boolean;
    constructor();
    /** Full reset for a restarted Player.log -- also forgets course ids, unlike startDraft(). */
    reset(): void;
    /** Clears per-draft state for a new draft of `eventName` (or none). */
    startDraft(eventName: string | null): void;
    /** The stable id for the current draft -- see the DRAFT ID note in this file's header. */
    resolveDraftId(): string | null;
    processLines(lines: string[]): DraftEvent[];
    getState(): DraftState;
}

export { type DraftEvent, DraftScanner, type DraftStartInfo, type DraftState, type PackInfo, type PickInfo, detectDraftStart, parseHumanDraftPick, parsePremierP1P1, parsePremierPack, parseQuickPack, parseQuickPick };
