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
interface ExtractGreEventsResult {
    events: any[];
    droppedCount: number;
}
declare function extractGreEvents(lines: string[]): ExtractGreEventsResult;
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
declare function createMatchState(): MatchState;
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
declare function buildMatchTimeline(events: any[], state?: MatchState): BuildMatchTimelineResult;

export { type BuildMatchTimelineResult, type ExtractGreEventsResult, type MatchState, buildMatchTimeline, createMatchState, extractGreEvents };
