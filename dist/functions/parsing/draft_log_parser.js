const DRAFT_START_MARKERS = {
  eventJoin: "[UnityCrossThreadLogger]==> Event_Join ",
  botDraftStatus: "[UnityCrossThreadLogger]==> BotDraft_DraftStatus "
};
const PREMIER_PACK_MARKER = "[UnityCrossThreadLogger]Draft.Notify ";
const PREMIER_P1P1_MARKER = "CardsInPack";
const HUMAN_PICK_EVENT = "EventPlayerDraftMakePick";
const QUICK_PACK_MARKER = "DraftPack";
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
    let eventData = null;
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
    }
  }
  return null;
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
    if (payload.DraftStatus !== "PickNext") return null;
    return {
      packNumber: payload.PackNumber + 1,
      pickNumber: payload.PickNumber + 1,
      cards: (payload.DraftPack || []).map(String)
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
  draftId;
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
  constructor() {
    this.draftFormat = null;
    this.draftId = null;
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
    this.packsSeen = [];
  }
  reset() {
    this.draftFormat = null;
    this.draftId = null;
    this.eventName = null;
    this.seenP1P1 = false;
    this.currentPack = [];
    this.currentPackNumber = 0;
    this.currentPickNumber = 0;
    this.pickedCards = [];
    this.packsSeen = [];
  }
  processLines(lines) {
    const events = [];
    for (const line of lines) {
      if (line.includes(DRAFT_START_MARKERS.eventJoin) || line.includes(DRAFT_START_MARKERS.botDraftStatus)) {
        const start = detectDraftStart([line]);
        if (start) {
          this.reset();
          this.draftId = start.draftId;
          this.eventName = start.eventName;
          this.draftFormat = /quick/i.test(start.eventName) ? "quick" : "premier";
          events.push({ kind: "draftStart", draftId: start.draftId, eventName: start.eventName });
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
      if (line.includes(QUICK_PACK_MARKER)) {
        const pack = parseQuickPack(line);
        if (pack) {
          this.currentPack = pack.cards;
          this.currentPackNumber = pack.packNumber;
          this.currentPickNumber = pack.pickNumber;
          this.packsSeen.push({ packNumber: pack.packNumber, pickNumber: pack.pickNumber, cards: pack.cards });
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
  getState() {
    return {
      draftFormat: this.draftFormat,
      draftId: this.draftId,
      eventName: this.eventName,
      currentPack: this.currentPack,
      currentPackNumber: this.currentPackNumber,
      currentPickNumber: this.currentPickNumber,
      pickedCards: this.pickedCards,
      packsSeen: this.packsSeen
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
