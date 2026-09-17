/**
 * gre_match_parser.ts
 *
 * Parses "GreToClientEvent" blocks out of Arena's Player.log lines and turns them
 * into a clean, ordered timeline of match events.
 *
 * Bugs this file exists specifically to avoid (all hit for real tonight):
 *
 *  1. Line splitting: content read from disk in JS already has '\n'-only line
 *     endings once normalized -- do NOT split on a literal '\r\n' after any
 *     normalization step, or you silently get zero matches.
 *
 *  2. Arena's own logger TRUNCATES large GameStateMessages into a human-readable,
 *     non-JSON stub: "[Message summarized because ... exceeded the 50 GameObject
 *     or 50 Annotation limit.]" -- JSON.parse on that line throws, and if you
 *     swallow the error silently you lose real game data with no signal that
 *     anything was dropped. We surface this explicitly instead.
 *
 *  3. "AnnotationType_ObjectsSelected" (which confirms what the player actually
 *     chose, e.g. which land got sacrificed) lives in `persistentAnnotations`,
 *     a SEPARATE array from `annotations`. Reading only `annotations` misses it
 *     entirely and produces a confidently wrong narrative.
 *
 *  4. ActionsAvailableReq lists LEGAL options, not executed actions. Never
 *     report a spell as "cast" or an attack as "declared" from an available-
 *     actions listing -- only from an actual ZoneTransfer / DeclareAttack /
 *     ObjectsSelected annotation that confirms it happened.
 *
 *  5. Objects change instanceId across zone transfers (AnnotationType_ObjectIdChanged).
 *     A naive instanceId->grpId map goes stale exactly when you need it (mid-cast).
 */

const MARKER = "GreToClientEvent";
const SUMMARIZED_STUB = "[Message summarized because";

interface ExtractGreEventsResult {
  events: any[];
  droppedCount: number;
}

function extractGreEvents(lines: string[]): ExtractGreEventsResult {
  const events: any[] = [];
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(MARKER) && line.includes("Match to")) {
      const next = lines[i + 1];
      if (!next) continue;

      const trimmed = next.trim();
      if (trimmed.startsWith(SUMMARIZED_STUB)) {
        // Arena dropped detail here. Don't pretend nothing happened -- flag it.
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

interface MatchState {
  instanceToGrpId: Map<number, number>;
  currentTurn: number | null;
  currentActivePlayer: number | null;
}

/**
 * Creates a fresh, empty match-parsing state. Persist this across repeated
 * calls to buildMatchTimeline (e.g. one per polling interval against a live
 * Player.log) so the instanceId->grpId map and current-turn tracking survive
 * between calls -- rebuilding it fresh each time silently forgets everything
 * learned in earlier polls, which breaks card resolution for any object last
 * seen several calls back.
 */
function createMatchState(): MatchState {
  return {
    instanceToGrpId: new Map(),
    currentTurn: null,
    currentActivePlayer: null,
  };
}

interface BuildMatchTimelineResult {
  timeline: any[];
  instanceToGrpId: Map<number, number>;
  state: MatchState;
}

/**
 * Walks parsed GRE events and builds an ordered, human-readable timeline,
 * extending `state` in place (from createMatchState(), or a prior call's
 * returned state for incremental/polling use). Pass no state for one-shot
 * full-log parsing (state is created and discarded internally).
 */
function buildMatchTimeline(events: any[], state: MatchState = createMatchState()): BuildMatchTimelineResult {
  const { instanceToGrpId } = state;
  const timeline: any[] = [];
  let currentTurn = state.currentTurn;
  let currentActivePlayer = state.currentActivePlayer;

  const label = (instanceId: number) => {
    const grpId = instanceToGrpId.get(instanceId);
    return grpId ? { instanceId, grpId } : { instanceId, grpId: null };
  };

  for (const ev of events) {
    const messages = ev?.greToClientEvent?.greToClientMessages || [];
    for (const m of messages) {
      const gsm = m.gameStateMessage;
      if (!gsm) continue;

      // Keep instance->grpId map current; also handle explicit reassignment.
      for (const go of gsm.gameObjects || []) {
        if (go.instanceId != null && go.grpId != null) {
          instanceToGrpId.set(go.instanceId, go.grpId);
        }
      }

      const turnInfo = gsm.turnInfo;
      if (turnInfo && turnInfo.turnNumber != null) {
        if (
          turnInfo.turnNumber !== currentTurn ||
          turnInfo.activePlayer !== currentActivePlayer
        ) {
          currentTurn = turnInfo.turnNumber;
          currentActivePlayer = turnInfo.activePlayer;
          timeline.push({
            kind: "turnChange",
            turnNumber: currentTurn,
            activePlayer: currentActivePlayer,
          });
        }
      }

      // IMPORTANT: read BOTH annotation arrays (bug #3 above).
      const allAnnotations = [
        ...(gsm.annotations || []),
        ...(gsm.persistentAnnotations || []),
      ];

      for (const ann of allAnnotations) {
        const types = ann.type || [];
        const details: Record<string, any> = {};
        for (const d of ann.details || []) {
          details[d.key] = d.valueString ?? d.valueInt32;
        }

        if (types.includes("AnnotationType_ObjectIdChanged")) {
          const oldId = details.orig_id ?? ann.affectedIds?.[0];
          const newId = details.new_id;
          if (oldId != null && newId != null && instanceToGrpId.has(oldId)) {
            instanceToGrpId.set(newId, instanceToGrpId.get(oldId)!);
          }
        }

        if (types.includes("AnnotationType_ZoneTransfer")) {
          const category = Array.isArray(details.category)
            ? details.category[0]
            : details.category;
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
          const selected = (ann.affectedIds || []).filter((x: number) => x !== 0);
          if (selected.length) {
            timeline.push({
              kind: "playerChoiceMade",
              turn: currentTurn,
              selected: selected.map(label),
              sourceAffectorId: ann.affectorId,
            });
          }
        }

        if (types.includes("AnnotationType_DamageDealt")) {
          timeline.push({
            kind: "damage",
            turn: currentTurn,
            amount: details.damage,
            source: label(ann.affectorId),
            targets: (ann.affectedIds || []).map(label),
          });
        }

        if (types.includes("AnnotationType_ModifiedLife")) {
          timeline.push({
            kind: "lifeChange",
            turn: currentTurn,
            delta: details.life,
            targets: ann.affectedIds,
          });
        }
      }

      if (m.type === "GREMessageType_DeclareAttackersReq") {
        const attackers = m.declareAttackersReq?.attackers || [];
        timeline.push({
          kind: "attackersDeclared",
          turn: currentTurn,
          attackers: attackers.map((a: any) => label(a.attackerInstanceId)),
        });
      }

      const gameInfo = gsm.gameInfo;
      if (gameInfo && gameInfo.stage === "GameStage_GameOver") {
        timeline.push({
          kind: "matchResult",
          matchState: gameInfo.matchState,
          results: gameInfo.results,
        });
      }
    }
  }

  // Persist the turn cursor back onto state for the next incremental call.
  state.currentTurn = currentTurn;
  state.currentActivePlayer = currentActivePlayer;

  return { timeline, instanceToGrpId, state };
}

export { extractGreEvents, buildMatchTimeline, createMatchState };
export type { MatchState, ExtractGreEventsResult, BuildMatchTimelineResult };
