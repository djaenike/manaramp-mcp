/**
 * draft_log_parser.js
 *
 * Parses DRAFT (pack/pick) events out of Player.log lines -- a distinct event
 * stream from match/GRE data (see gre_match_parser.js), using different marker
 * strings entirely.
 *
 * Marker strings and payload shapes below are validated against the real,
 * shipped implementation in bstaple1/MTGA_Draft_17Lands (MIT licensed,
 * src/log_scanner.py) -- not guessed or reconstructed from docs. Reused here
 * as plain factual identifiers (event names, JSON key names), reimplemented
 * from scratch in JS with our own parsing/state logic.
 *
 * Confirmed format-specific quirks baked in below:
 *   - Premier/Traditional draft's FIRST pick (P1P1) is never sent via the
 *     normal pack marker -- it only shows up via a separate "CardsInPack"
 *     marker. Miss this and pick 1 is silently absent from your data.
 *   - Premier draft's normal pack payload ("Draft.Notify") encodes the pack
 *     as a COMMA-SEPARATED STRING ("PackCards"), while P1P1's payload
 *     ("CardsInPack") and Quick Draft's payload both use a real JSON array.
 *     Don't assume one shape across formats.
 *   - Quick Draft pack/pick numbers are 0-indexed in the raw payload; add 1
 *     before treating them as human-facing pack/pick numbers.
 *   - Quick Draft's pack marker fires on every state poll, not just when a
 *     new pack is ready -- gate on `DraftStatus === "PickNext"` or you'll
 *     process stale/duplicate pack data.
 *
 * NOT yet implemented: Traditional Draft and Sealed formats use their own
 * separate marker strings again (traditional shares some shape with premier
 * but is a distinct code path in the reference tool). Left as a TODO rather
 * than guessed at.
 */

const DRAFT_START_MARKERS = {
  eventJoin: '[UnityCrossThreadLogger]==> Event_Join ',
  botDraftStatus: '[UnityCrossThreadLogger]==> BotDraft_DraftStatus ',
};

const PREMIER_PACK_MARKER = '[UnityCrossThreadLogger]Draft.Notify ';
const PREMIER_P1P1_MARKER = 'CardsInPack';
const PREMIER_PICK_MARKER = '[UnityCrossThreadLogger]==> Draft.MakeHumanDraftPick ';

const QUICK_PACK_MARKER = 'DraftPack';
const QUICK_PICK_MARKER = '[UnityCrossThreadLogger]==> BotDraft_DraftPick ';

function safeJsonAfter(line, anchor) {
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
function detectDraftStart(lines) {
  for (const line of lines) {
    let eventData = null;
    if (line.includes(DRAFT_START_MARKERS.eventJoin)) {
      eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, '{');
    } else if (line.includes(DRAFT_START_MARKERS.botDraftStatus)) {
      eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, '{');
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
function parsePremierP1P1(line) {
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
function parsePremierPack(line) {
  const idx = line.indexOf('{"draftId"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    return {
      draftId: data.draftId,
      packNumber: data.SelfPack,
      pickNumber: data.SelfPick,
      cards: (data.PackCards || '').split(',').filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Premier Draft's human pick confirmation.
 */
function parsePremierPick(line) {
  const data = safeJsonAfter(line, PREMIER_PICK_MARKER.slice(0, 0)) || null;
  const idx = line.indexOf(PREMIER_PICK_MARKER);
  if (idx === -1) return null;
  try {
    const data2 = JSON.parse(line.slice(idx + PREMIER_PICK_MARKER.length));
    const request = JSON.parse(data2.request);
    const params = request.params;
    return {
      packNumber: params.packNumber,
      pickNumber: params.pickNumber,
      cardId: String(params.cardId),
    };
  } catch {
    return null;
  }
}

/**
 * Parses Quick Draft's pack broadcast. Returns null if this poll isn't
 * actually presenting a new pack to pick from (DraftStatus !== "PickNext").
 */
function parseQuickPack(line) {
  const idx = line.indexOf('{"CurrentModule"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    const payload = JSON.parse(data.Payload);
    if (payload.DraftStatus !== 'PickNext') return null;
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
 * Parses Quick Draft's pick confirmation.
 */
function parseQuickPick(line) {
  const idx = line.indexOf(QUICK_PICK_MARKER);
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx + QUICK_PICK_MARKER.length));
    const request = JSON.parse(data.request);
    const payload = JSON.parse(request.Payload);
    const pickInfo = payload.PickInfo;
    return {
      packNumber: pickInfo.PackNumber + 1,
      pickNumber: pickInfo.PickNumber + 1,
      cardId: String(pickInfo.CardId),
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
  constructor() {
    this.draftFormat = null; // 'premier' | 'quick' | null (unknown/unset)
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
  }

  reset() {
    this.draftFormat = null;
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
  }

  /** @param {string[]} lines */
  processLines(lines) {
    const events = [];

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
          this.draftFormat = /quick/i.test(start.eventName) ? 'quick' : 'premier';
          events.push({ kind: 'draftStart', eventName: start.eventName });
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
          events.push({ kind: 'packSeen', ...p1p1 });
          continue;
        }
      }

      if (line.includes(PREMIER_PACK_MARKER)) {
        const pack = parsePremierPack(line);
        if (pack) {
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          events.push({ kind: 'packSeen', ...pack });
          continue;
        }
      }

      if (line.includes(PREMIER_PICK_MARKER)) {
        const pick = parsePremierPick(line);
        if (pick) {
          this.pickedCards.push(pick.cardId);
          events.push({ kind: 'pickMade', ...pick });
          continue;
        }
      }

      if (line.includes(QUICK_PACK_MARKER)) {
        const pack = parseQuickPack(line);
        if (pack) {
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          events.push({ kind: 'packSeen', ...pack });
          continue;
        }
      }

      if (line.includes(QUICK_PICK_MARKER)) {
        const pick = parseQuickPick(line);
        if (pick) {
          this.pickedCards.push(pick.cardId);
          events.push({ kind: 'pickMade', ...pick });
          continue;
        }
      }
    }

    return events;
  }

  getState() {
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
  parsePremierPick,
  parseQuickPack,
  parseQuickPick,
};
