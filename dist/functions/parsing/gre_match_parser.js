const MARKER = "GreToClientEvent";
const SUMMARIZED_STUB = "[Message summarized because";
function extractGreEvents(lines) {
  const events = [];
  let droppedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(MARKER) && line.includes("Match to")) {
      const next = lines[i + 1];
      if (!next) continue;
      const trimmed = next.trim();
      if (trimmed.startsWith(SUMMARIZED_STUB)) {
        droppedCount++;
        continue;
      }
      if (!trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        droppedCount++;
      }
    }
  }
  return { events, droppedCount };
}
function createMatchState() {
  return {
    instanceToGrpId: /* @__PURE__ */ new Map(),
    currentTurn: null,
    currentActivePlayer: null
  };
}
function buildMatchTimeline(events, state = createMatchState()) {
  const { instanceToGrpId } = state;
  const timeline = [];
  let currentTurn = state.currentTurn;
  let currentActivePlayer = state.currentActivePlayer;
  const label = (instanceId) => {
    const grpId = instanceToGrpId.get(instanceId);
    return grpId ? { instanceId, grpId } : { instanceId, grpId: null };
  };
  for (const ev of events) {
    const messages = ev?.greToClientEvent?.greToClientMessages || [];
    for (const m of messages) {
      const gsm = m.gameStateMessage;
      if (!gsm) continue;
      for (const go of gsm.gameObjects || []) {
        if (go.instanceId != null && go.grpId != null) {
          instanceToGrpId.set(go.instanceId, go.grpId);
        }
      }
      const turnInfo = gsm.turnInfo;
      if (turnInfo && turnInfo.turnNumber != null) {
        if (turnInfo.turnNumber !== currentTurn || turnInfo.activePlayer !== currentActivePlayer) {
          currentTurn = turnInfo.turnNumber;
          currentActivePlayer = turnInfo.activePlayer;
          timeline.push({
            kind: "turnChange",
            turnNumber: currentTurn,
            activePlayer: currentActivePlayer
          });
        }
      }
      const allAnnotations = [
        ...gsm.annotations || [],
        ...gsm.persistentAnnotations || []
      ];
      for (const ann of allAnnotations) {
        const types = ann.type || [];
        const details = {};
        for (const d of ann.details || []) {
          details[d.key] = d.valueString ?? d.valueInt32;
        }
        if (types.includes("AnnotationType_ObjectIdChanged")) {
          const oldId = details.orig_id ?? ann.affectedIds?.[0];
          const newId = details.new_id;
          if (oldId != null && newId != null && instanceToGrpId.has(oldId)) {
            instanceToGrpId.set(newId, instanceToGrpId.get(oldId));
          }
        }
        if (types.includes("AnnotationType_ZoneTransfer")) {
          const category = Array.isArray(details.category) ? details.category[0] : details.category;
          const target = (ann.affectedIds || [])[0];
          if (category === "PlayLand") {
            timeline.push({ kind: "landPlayed", turn: currentTurn, ...label(target) });
          } else if (category === "CastSpell") {
            timeline.push({ kind: "spellCast", turn: currentTurn, ...label(target) });
          } else if (category === "Resolve") {
            timeline.push({ kind: "resolved", turn: currentTurn, ...label(target) });
          }
        }
        if (types.includes("AnnotationType_ObjectsSelected")) {
          const selected = (ann.affectedIds || []).filter((x) => x !== 0);
          if (selected.length) {
            timeline.push({
              kind: "playerChoiceMade",
              turn: currentTurn,
              selected: selected.map(label),
              sourceAffectorId: ann.affectorId
            });
          }
        }
        if (types.includes("AnnotationType_DamageDealt")) {
          timeline.push({
            kind: "damage",
            turn: currentTurn,
            amount: details.damage,
            source: label(ann.affectorId),
            targets: (ann.affectedIds || []).map(label)
          });
        }
        if (types.includes("AnnotationType_ModifiedLife")) {
          timeline.push({
            kind: "lifeChange",
            turn: currentTurn,
            delta: details.life,
            targets: ann.affectedIds
          });
        }
      }
      if (m.type === "GREMessageType_DeclareAttackersReq") {
        const attackers = m.declareAttackersReq?.attackers || [];
        timeline.push({
          kind: "attackersDeclared",
          turn: currentTurn,
          attackers: attackers.map((a) => label(a.attackerInstanceId))
        });
      }
      const gameInfo = gsm.gameInfo;
      if (gameInfo && gameInfo.stage === "GameStage_GameOver") {
        timeline.push({
          kind: "matchResult",
          matchState: gameInfo.matchState,
          results: gameInfo.results
        });
      }
    }
  }
  state.currentTurn = currentTurn;
  state.currentActivePlayer = currentActivePlayer;
  return { timeline, instanceToGrpId, state };
}
export {
  buildMatchTimeline,
  createMatchState,
  extractGreEvents
};
