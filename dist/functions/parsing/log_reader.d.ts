/**
 * log_reader.ts
 *
 * Incremental reader for MTG Arena's Player.log.
 *
 * Design notes (validated against real Player.log data + bstaple1/MTGA_Draft_17Lands):
 *  - Player.log is REWRITTEN FROM SCRATCH every time Arena launches. There is no
 *    cross-session history in the file itself.
 *  - We must never re-read the whole file on every poll -- track a byte offset and
 *    seek() forward, same pattern the reference tool uses.
 *  - If the file's current size is SMALLER than our last known size, Arena restarted.
 *    That means our offset is stale/invalid and all session state must be cleared.
 */
interface ReadNewLinesResult {
    lines: string[];
    sessionReset: boolean;
}
declare class LogReader {
    filePath: string;
    offset: number;
    lastKnownSize: number;
    /**
     * @param filePath - absolute path to Player.log
     */
    constructor(filePath: string);
    /**
     * Returns { lines, sessionReset } where:
     *   lines        - array of new complete lines appended since last call
     *   sessionReset - true if Arena restarted since the last call (file shrank)
     */
    readNewLines(): ReadNewLinesResult;
    reset(): void;
}

export { LogReader };
