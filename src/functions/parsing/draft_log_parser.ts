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

// Both spellings: the underscored forms come from older reference parsers; real 2026-09 logs use
// the bare forms (see the DRAFT ID note above).
const EVENT_JOIN_MARKERS = ["==> Event_Join ", "==> EventJoin "];
const BOT_DRAFT_STATUS_MARKERS = ["==> BotDraft_DraftStatus ", "==> BotDraftDraftStatus "];
const COURSE_ID_PATTERN = /"CourseId":"([^"]+)","InternalEventName":"([^"]+)"/g;

const PREMIER_PACK_MARKER = "[UnityCrossThreadLogger]Draft.Notify ";
const PREMIER_P1P1_MARKER = "CardsInPack";
const HUMAN_PICK_EVENT = "EventPlayerDraftMakePick";

// Real logs have been observed using either form; match both rather than picking one.
const QUICK_PICK_EVENT_FORMS = ["BotDraftDraftPick", "BotDraft_DraftPick"];

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
  packsSeen: Array<{ packNumber: number; pickNumber: number; cards: string[] }>;
  draftComplete: boolean;
}

function lineHasQuickPickEvent(line: string): boolean {
  return QUICK_PICK_EVENT_FORMS.some((form) => line.includes(form));
}

function safeJsonAfter(line: string, anchor: string): any {
  const idx = line.indexOf(anchor);
  if (idx === -1) return null;
  try {
    return JSON.parse(line.slice(idx));
  } catch {
    return null;
  }
}

/**
 * Detect a draft-start line and classify (loosely -- full set/type
 * classification from the reference tool requires its bundled set-list data,
 * which we don't have here). Returns the raw EventName for the caller to
 * classify against their own set/format list, e.g. via existing
 * limited_sets metadata elsewhere in your MCP.
 */
function detectDraftStart(lines: string[]): DraftStartInfo | null {
  for (const line of lines) {
    const isJoin = EVENT_JOIN_MARKERS.some((m) => line.includes(m));
    if (!isJoin && !BOT_DRAFT_STATUS_MARKERS.some((m) => line.includes(m))) continue;
    const eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
    if (!eventData || typeof eventData.request !== "string") continue;

    try {
      const request = JSON.parse(eventData.request);
      // Real logs put EventName straight on the request; older reference parsers expected it one
      // level down, inside a Payload JSON string -- accept either.
      const payload = typeof request.Payload === "string" ? JSON.parse(request.Payload) : request;
      if (typeof payload.EventName === "string" && /draft/i.test(payload.EventName)) {
        return { eventName: payload.EventName, isJoin };
      }
    } catch {
      // Not every EventJoin line is a draft start; ignore misses.
    }
  }
  return null;
}

/** Short deterministic hash (FNV-1a) for the last-resort draft id fallback. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Parses Premier Draft's P1P1 pack (separate from every subsequent pack).
 */
function parsePremierP1P1(line: string): PackInfo | null {
  const data = safeJsonAfter(line, '{"id":');
  if (!data) return null;
  try {
    const request = JSON.parse(data.request);   // request string -> { Payload: "<json string>" }
    const cardData = JSON.parse(request.Payload); // Payload string -> final object
    return {
      packNumber: cardData.PackNumber,
      pickNumber: cardData.PickNumber,
      cards: (cardData.CardsInPack || []).map(String),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Premier Draft's normal (post-P1P1) pack broadcasts.
 */
function parsePremierPack(line: string): PackInfo | null {
  const idx = line.indexOf('{"draftId"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    return {
      draftId: data.draftId,
      packNumber: data.SelfPack,
      pickNumber: data.SelfPick,
      cards: (data.PackCards || "").split(",").filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Premier/Traditional Draft's human pick confirmation
 * (`EventPlayerDraftMakePick`). Only the `==>` request carries useful data --
 * the paired `<==` response only confirms success. The pick fields
 * themselves have been observed in three different shapes across real logs
 * (top-level, under `PickInfo`, or string-escaped inside `request`), so all
 * three are checked rather than assuming one.
 */
function parseHumanDraftPick(line: string): PickInfo | null {
  if (!line.includes("==>")) return null; // exclude the bare `<==` response
  const data = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
  if (!data) return null;
  try {
    let requestPayload: any = null;
    if (typeof data.request === "string") {
      try { requestPayload = JSON.parse(data.request); } catch { requestPayload = null; }
    }
    const pickInfo = data.PickInfo ?? requestPayload ?? data;

    let cardId = pickInfo.CardId;
    if (cardId == null && Array.isArray(pickInfo.GrpIds)) cardId = pickInfo.GrpIds[0];
    if (cardId == null && Array.isArray(pickInfo.CardIds)) cardId = pickInfo.CardIds[0];
    if (cardId == null) return null;

    return {
      packNumber: pickInfo.PackNumber ?? pickInfo.Pack ?? 0,
      pickNumber: pickInfo.PickNumber ?? pickInfo.Pick ?? 0,
      cardId: String(cardId),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Quick Draft's pack broadcast. Returns null if this poll isn't
 * actually presenting a new pack to pick from (DraftStatus !== "PickNext").
 */
type QuickPackResult =
  | (PackInfo & { eventName?: string; pickedSoFar: string[]; completed?: false })
  | { completed: true; eventName?: string };

function parseQuickPack(line: string): QuickPackResult | null {
  const idx = line.indexOf('{"CurrentModule"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    const payload = JSON.parse(data.Payload);
    if (payload.DraftStatus === "Completed") return { completed: true, eventName: payload.EventName };
    if (payload.DraftStatus !== "PickNext") return null;
    return {
      eventName: payload.EventName,
      packNumber: payload.PackNumber + 1,
      pickNumber: payload.PickNumber + 1,
      cards: (payload.DraftPack || []).map(String),
      // Arena's own running list of everything picked so far (not in pick order) -- only used to
      // seed pickedCards when this scanner joined mid-draft and never saw the earlier picks.
      pickedSoFar: (payload.PickedCards || []).map(String),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Quick Draft's pick confirmation (the `==>` request side only -- the
 * paired `<==` response confirms success plus the next pack, not the pick
 * itself). `request` parses directly to `{ EventName, PickInfo }`, with NO
 * `.Payload` wrapper (that only exists on the pack-status side).
 */
function parseQuickPick(line: string): PickInfo | null {
  if (!line.includes("==>")) return null;
  const data = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
  if (!data || typeof data.request !== "string") return null;
  try {
    const request = JSON.parse(data.request);
    const pickInfo = request.PickInfo;
    if (!pickInfo || !Array.isArray(pickInfo.CardIds)) return null;

    const cardId = pickInfo.CardIds[0];
    if (cardId == null || String(cardId) === "0") return null; // "0" = no card resolved yet

    return {
      packNumber: (pickInfo.PackNumber ?? 0) + 1,
      pickNumber: (pickInfo.PickNumber ?? 0) + 1,
      cardId: String(cardId),
    };
  } catch {
    return null;
  }
}

/**
 * Stateful scanner: feed it successive batches of new lines (e.g. straight
 * from LogReader.readNewLines().lines) and it maintains current pack/pick
 * state across calls, matching a single draft session.
 */
class DraftScanner {
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
  packsSeen: Array<{ packNumber: number; pickNumber: number; cards: string[] }>;
  /** Premier's own Draft.Notify draftId, when seen -- preferred over the CourseId lookup. */
  premierDraftId: string | null;
  /** Every CourseId seen in the log so far, keyed by InternalEventName -- NOT cleared between
   *  drafts, since the course-list lines can appear long before the draft itself starts. */
  courseIdsByEvent: Map<string, string>;
  draftComplete: boolean;

  constructor() {
    this.courseIdsByEvent = new Map();
    this.draftFormat = null;
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
    this.packsSeen = [];
    this.premierDraftId = null;
    this.draftComplete = false;
  }

  /** Full reset for a restarted Player.log -- also forgets course ids, unlike startDraft(). */
  reset(): void {
    this.courseIdsByEvent = new Map();
    this.startDraft(null);
  }

  /** Clears per-draft state for a new draft of `eventName` (or none). */
  startDraft(eventName: string | null): void {
    // Heuristic only -- real classification needs a set/format lookup table.
    this.draftFormat = eventName ? (/quick/i.test(eventName) ? "quick" : "premier") : null;
    this.eventName = eventName;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
    this.packsSeen = [];
    this.premierDraftId = null;
    this.draftComplete = false;
  }

  /** The stable id for the current draft -- see the DRAFT ID note in this file's header. */
  resolveDraftId(): string | null {
    if (this.premierDraftId) return this.premierDraftId;
    if (!this.eventName) return null;
    const courseId = this.courseIdsByEvent.get(this.eventName);
    if (courseId) return courseId;
    const firstPack = this.packsSeen[0];
    return firstPack ? `${this.eventName}:${fnv1a(firstPack.cards.join(","))}` : null;
  }

  processLines(lines: string[]): DraftEvent[] {
    const events: DraftEvent[] = [];

    for (const line of lines) {
      if (line.includes('"CourseId"')) {
        for (const m of line.matchAll(COURSE_ID_PATTERN)) this.courseIdsByEvent.set(m[2], m[1]);
      }

      if (EVENT_JOIN_MARKERS.some((m) => line.includes(m)) || BOT_DRAFT_STATUS_MARKERS.some((m) => line.includes(m))) {
        const start = detectDraftStart([line]);
        if (start) {
          // EventJoin is always a new draft. A DraftStatus poll only counts as one when it's for a
          // different event than the one in progress -- it also fires when resuming a draft
          // mid-way, and resetting then would throw away the picks already recorded.
          if (start.isJoin || start.eventName !== this.eventName) {
            this.startDraft(start.eventName);
            events.push({ kind: "draftStart", eventName: start.eventName });
          }
          continue;
        }
      }

      if (!this.seenP1P1 && line.includes(PREMIER_P1P1_MARKER)) {
        const p1p1 = parsePremierP1P1(line);
        if (p1p1) {
          this.seenP1P1 = true;
          this.currentPack = p1p1.cards;
          this.currentPackNumber = p1p1.packNumber;
          this.currentPickNumber = p1p1.pickNumber;
          this.packsSeen.push({ packNumber: p1p1.packNumber, pickNumber: p1p1.pickNumber, cards: p1p1.cards });
          events.push({ kind: "packSeen", ...p1p1 });
          continue;
        }
      }

      if (line.includes(PREMIER_PACK_MARKER)) {
        const pack = parsePremierPack(line);
        if (pack) {
          if (pack.draftId) this.premierDraftId = pack.draftId;
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          this.packsSeen.push({ packNumber: pack.packNumber, pickNumber: pack.pickNumber, cards: pack.cards });
          events.push({ kind: "packSeen", ...pack });
          continue;
        }
      }

      if (line.includes(HUMAN_PICK_EVENT)) {
        const pick = parseHumanDraftPick(line);
        if (pick) {
          this.pickedCards.push(pick.cardId);
          events.push({ kind: "pickMade", ...pick });
          continue;
        }
      }

      if (line.includes('{"CurrentModule"') && line.includes("DraftStatus")) {
        const pack = parseQuickPack(line);
        // The pack payload names its event too -- covers a scanner that never saw this draft's
        // start line (e.g. the server started mid-draft and the start was in an earlier session).
        if (pack?.eventName && pack.eventName !== this.eventName) {
          this.startDraft(pack.eventName);
          events.push({ kind: "draftStart", eventName: pack.eventName });
        }
        if (pack?.completed) {
          this.draftComplete = true;
          this.currentPack = [];
          continue;
        }
        if (pack) {
          if (this.pickedCards.length === 0 && pack.pickedSoFar.length > 0) this.pickedCards = [...pack.pickedSoFar];
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          this.packsSeen.push({ packNumber: pack.packNumber, pickNumber: pack.pickNumber, cards: pack.cards });
          events.push({ kind: "packSeen", packNumber: pack.packNumber, pickNumber: pack.pickNumber, cards: pack.cards });
          continue;
        }
      }

      if (lineHasQuickPickEvent(line)) {
        const pick = parseQuickPick(line);
        if (pick) {
          this.pickedCards.push(pick.cardId);
          events.push({ kind: "pickMade", ...pick });
          continue;
        }
      }
    }

    return events;
  }

  getState(): DraftState {
    return {
      draftFormat: this.draftFormat,
      draftId: this.resolveDraftId(),
      eventName: this.eventName,
      currentPack: this.currentPack,
      currentPackNumber: this.currentPackNumber,
      currentPickNumber: this.currentPickNumber,
      pickedCards: this.pickedCards,
      packsSeen: this.packsSeen,
      draftComplete: this.draftComplete,
    };
  }
}

export {
  DraftScanner,
  detectDraftStart,
  parsePremierP1P1,
  parsePremierPack,
  parseHumanDraftPick,
  parseQuickPack,
  parseQuickPick,
};
export type { DraftEvent, DraftState, PackInfo, PickInfo, DraftStartInfo };
