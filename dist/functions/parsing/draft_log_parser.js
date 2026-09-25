const EVENT_JOIN_MARKERS = ["==> Event_Join ", "==> EventJoin "];
const BOT_DRAFT_STATUS_MARKERS = ["==> BotDraft_DraftStatus ", "==> BotDraftDraftStatus "];
const COURSE_ID_PATTERN = /"CourseId":"([^"]+)","InternalEventName":"([^"]+)"/g;
const PREMIER_PACK_MARKER = "[UnityCrossThreadLogger]Draft.Notify ";
const PREMIER_P1P1_MARKER = "CardsInPack";
const HUMAN_PICK_EVENT = "EventPlayerDraftMakePick";
const QUICK_PICK_EVENT_FORMS = ["BotDraftDraftPick", "BotDraft_DraftPick"];
function lineHasQuickPickEvent(line) {
  return QUICK_PICK_EVENT_FORMS.some((form) => line.includes(form));
}
function safeJsonAfter(line, anchor) {
  const idx = line.indexOf(anchor);
  if (idx === -1) return null;
  try {
    return JSON.parse(line.slice(idx));
  } catch {
    return null;
  }
}
function detectDraftStart(lines) {
  for (const line of lines) {
    const isJoin = EVENT_JOIN_MARKERS.some((m) => line.includes(m));
    if (!isJoin && !BOT_DRAFT_STATUS_MARKERS.some((m) => line.includes(m))) continue;
    const eventData = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
    if (!eventData || typeof eventData.request !== "string") continue;
    try {
      const request = JSON.parse(eventData.request);
      const payload = typeof request.Payload === "string" ? JSON.parse(request.Payload) : request;
      if (typeof payload.EventName === "string" && /draft/i.test(payload.EventName)) {
        return { eventName: payload.EventName, isJoin };
      }
    } catch {
    }
  }
  return null;
}
function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function parsePremierP1P1(line) {
  const data = safeJsonAfter(line, '{"id":');
  if (!data) return null;
  try {
    const request = JSON.parse(data.request);
    const cardData = JSON.parse(request.Payload);
    return {
      packNumber: cardData.PackNumber,
      pickNumber: cardData.PickNumber,
      cards: (cardData.CardsInPack || []).map(String)
    };
  } catch {
    return null;
  }
}
function parsePremierPack(line) {
  const idx = line.indexOf('{"draftId"');
  if (idx === -1) return null;
  try {
    const data = JSON.parse(line.slice(idx));
    return {
      draftId: data.draftId,
      packNumber: data.SelfPack,
      pickNumber: data.SelfPick,
      cards: (data.PackCards || "").split(",").filter(Boolean)
    };
  } catch {
    return null;
  }
}
function parseHumanDraftPick(line) {
  if (!line.includes("==>")) return null;
  const data = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
  if (!data) return null;
  try {
    let requestPayload = null;
    if (typeof data.request === "string") {
      try {
        requestPayload = JSON.parse(data.request);
      } catch {
        requestPayload = null;
      }
    }
    const pickInfo = data.PickInfo ?? requestPayload ?? data;
    let cardId = pickInfo.CardId;
    if (cardId == null && Array.isArray(pickInfo.GrpIds)) cardId = pickInfo.GrpIds[0];
    if (cardId == null && Array.isArray(pickInfo.CardIds)) cardId = pickInfo.CardIds[0];
    if (cardId == null) return null;
    return {
      packNumber: pickInfo.PackNumber ?? pickInfo.Pack ?? 0,
      pickNumber: pickInfo.PickNumber ?? pickInfo.Pick ?? 0,
      cardId: String(cardId)
    };
  } catch {
    return null;
  }
}
function parseQuickPack(line) {
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
      pickedSoFar: (payload.PickedCards || []).map(String)
    };
  } catch {
    return null;
  }
}
function parseQuickPick(line) {
  if (!line.includes("==>")) return null;
  const data = safeJsonAfter(line, '{"id"') || safeJsonAfter(line, "{");
  if (!data || typeof data.request !== "string") return null;
  try {
    const request = JSON.parse(data.request);
    const pickInfo = request.PickInfo;
    if (!pickInfo || !Array.isArray(pickInfo.CardIds)) return null;
    const cardId = pickInfo.CardIds[0];
    if (cardId == null || String(cardId) === "0") return null;
    return {
      packNumber: (pickInfo.PackNumber ?? 0) + 1,
      pickNumber: (pickInfo.PickNumber ?? 0) + 1,
      cardId: String(cardId)
    };
  } catch {
    return null;
  }
}
class DraftScanner {
  draftFormat;
  eventName;
  seenP1P1;
  currentPack;
  currentPackNumber;
  currentPickNumber;
  pickedCards;
  /** Every pack ever shown this draft, in order -- unlike currentPack (overwritten on each new
   *  pack), this accumulates so push_draft_result can save the FULL options history, not just
   *  whatever's showing right now. */
  packsSeen;
  /** Premier's own Draft.Notify draftId, when seen -- preferred over the CourseId lookup. */
  premierDraftId;
  /** Every CourseId seen in the log so far, keyed by InternalEventName -- NOT cleared between
   *  drafts, since the course-list lines can appear long before the draft itself starts. */
  courseIdsByEvent;
  draftComplete;
  constructor() {
    this.courseIdsByEvent = /* @__PURE__ */ new Map();
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
  reset() {
    this.courseIdsByEvent = /* @__PURE__ */ new Map();
    this.startDraft(null);
  }
  /** Clears per-draft state for a new draft of `eventName` (or none). */
  startDraft(eventName) {
    this.draftFormat = eventName ? /quick/i.test(eventName) ? "quick" : "premier" : null;
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
  resolveDraftId() {
    if (this.premierDraftId) return this.premierDraftId;
    if (!this.eventName) return null;
    const courseId = this.courseIdsByEvent.get(this.eventName);
    if (courseId) return courseId;
    const firstPack = this.packsSeen[0];
    return firstPack ? `${this.eventName}:${fnv1a(firstPack.cards.join(","))}` : null;
  }
  processLines(lines) {
    const events = [];
    for (const line of lines) {
      if (line.includes('"CourseId"')) {
        for (const m of line.matchAll(COURSE_ID_PATTERN)) this.courseIdsByEvent.set(m[2], m[1]);
      }
      if (EVENT_JOIN_MARKERS.some((m) => line.includes(m)) || BOT_DRAFT_STATUS_MARKERS.some((m) => line.includes(m))) {
        const start = detectDraftStart([line]);
        if (start) {
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
  getState() {
    return {
      draftFormat: this.draftFormat,
      draftId: this.resolveDraftId(),
      eventName: this.eventName,
      currentPack: this.currentPack,
      currentPackNumber: this.currentPackNumber,
      currentPickNumber: this.currentPickNumber,
      pickedCards: this.pickedCards,
      packsSeen: this.packsSeen,
      draftComplete: this.draftComplete
    };
  }
}
export {
  DraftScanner,
  detectDraftStart,
  parseHumanDraftPick,
  parsePremierP1P1,
  parsePremierPack,
  parseQuickPack,
  parseQuickPick
};
