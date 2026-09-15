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
 * NOT yet implemented: Traditional Draft and Sealed formats use their own
 * separate marker strings again (traditional shares some shape with premier
 * but is a distinct code path in the reference tools above). Left as a TODO
 * rather than guessed at.
 */

const DRAFT_START_MARKERS = {
  eventJoin: "[UnityCrossThreadLogger]==> Event_Join ",
  botDraftStatus: "[UnityCrossThreadLogger]==> BotDraft_DraftStatus ",
};

const PREMIER_PACK_MARKER = "[UnityCrossThreadLogger]Draft.Notify ";
const PREMIER_P1P1_MARKER = "CardsInPack";
const HUMAN_PICK_EVENT = "EventPlayerDraftMakePick";

const QUICK_PACK_MARKER = "DraftPack";
// Real logs have been observed using either form; match both rather than picking one.
const QUICK_PICK_EVENT_FORMS = ["BotDraftDraftPick", "BotDraft_DraftPick"];

interface DraftStartInfo {
  draftId: string;
  eventName: string;
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
  eventName: string | null;
  currentPack: string[];
  currentPackNumber: number;
  currentPickNumber: number;
  pickedCards: string[];
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
    let eventData: any = null;
    if (line.includes(DRAFT_START_MARKERS.eventJoin)) {
      eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
    } else if (line.includes(DRAFT_START_MARKERS.botDraftStatus)) {
      eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
    }
    if (!eventData) continue;

    try {
      const request = JSON.parse(eventData.request);
      const payload = JSON.parse(request.Payload);
      if (payload.EventName) {
        return { draftId: eventData.id, eventName: payload.EventName };
      }
    } catch {
      // Not every Event_Join line is a draft start; ignore misses.
    }
  }
  return null;
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
function parseQuickPack(line: string): PackInfo | null {
  const idx = line.indexOf('{"CurrentModule"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    const payload = JSON.parse(data.Payload);
    if (payload.DraftStatus !== "PickNext") return null;
    return {
      packNumber: payload.PackNumber + 1,
      pickNumber: payload.PickNumber + 1,
      cards: (payload.DraftPack || []).map(String),
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

  constructor() {
    this.draftFormat = null; // 'premier' | 'quick' | null (unknown/unset)
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
  }

  reset(): void {
    this.draftFormat = null;
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
  }

  processLines(lines: string[]): DraftEvent[] {
    const events: DraftEvent[] = [];

    for (const line of lines) {
      if (
        line.includes(DRAFT_START_MARKERS.eventJoin) ||
        line.includes(DRAFT_START_MARKERS.botDraftStatus)
      ) {
        const start = detectDraftStart([line]);
        if (start) {
          this.reset();
          this.eventName = start.eventName;
          // Heuristic only -- real classification needs a set/format lookup table.
          this.draftFormat = /quick/i.test(start.eventName) ? "quick" : "premier";
          events.push({ kind: "draftStart", eventName: start.eventName });
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
          events.push({ kind: "packSeen", ...p1p1 });
          continue;
        }
      }

      if (line.includes(PREMIER_PACK_MARKER)) {
        const pack = parsePremierPack(line);
        if (pack) {
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
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

      if (line.includes(QUICK_PACK_MARKER)) {
        const pack = parseQuickPack(line);
        if (pack) {
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          events.push({ kind: "packSeen", ...pack });
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
      eventName: this.eventName,
      currentPack: this.currentPack,
      currentPackNumber: this.currentPackNumber,
      currentPickNumber: this.currentPickNumber,
      pickedCards: this.pickedCards,
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
