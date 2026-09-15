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

import fs from "node:fs";

interface ReadNewLinesResult {
  lines: string[];
  sessionReset: boolean;
}

class LogReader {
  filePath: string;
  offset: number;
  lastKnownSize: number;

  /**
   * @param filePath - absolute path to Player.log
   */
  constructor(filePath: string) {
    this.filePath = filePath;
    this.offset = 0;
    this.lastKnownSize = 0;
  }

  /**
   * Returns { lines, sessionReset } where:
   *   lines        - array of new complete lines appended since last call
   *   sessionReset - true if Arena restarted since the last call (file shrank)
   */
  readNewLines(): ReadNewLinesResult {
    const stats = fs.statSync(this.filePath);
    const currentSize = stats.size;

    let sessionReset = false;
    if (currentSize < this.lastKnownSize) {
      // File got smaller -> Arena relaunched and rewrote Player.log from scratch.
      sessionReset = true;
      this.offset = 0;
    }
    this.lastKnownSize = currentSize;

    if (currentSize === this.offset) {
      return { lines: [], sessionReset };
    }

    const fd = fs.openSync(this.filePath, "r");
    const length = currentSize - this.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, this.offset);
    fs.closeSync(fd);

    const text = buffer.toString("utf-8");

    // Only commit fully-terminated lines to the offset. A partial final line
    // (Arena still writing it) is held back and re-read next call.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet; don't advance offset.
      return { lines: [], sessionReset };
    }

    const completeText = text.slice(0, lastNewline);
    this.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf-8");

    const lines = completeText.split("\n").map((l) => l.replace(/\r$/, ""));
    return { lines, sessionReset };
  }

  reset(): void {
    this.offset = 0;
    this.lastKnownSize = 0;
  }
}

export { LogReader };
