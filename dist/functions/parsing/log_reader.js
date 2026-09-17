import fs from "node:fs";
class LogReader {
  filePath;
  offset;
  lastKnownSize;
  /**
   * @param filePath - absolute path to Player.log
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.lastKnownSize = 0;
  }
  /**
   * Returns { lines, sessionReset } where:
   *   lines        - array of new complete lines appended since last call
   *   sessionReset - true if Arena restarted since the last call (file shrank)
   */
  readNewLines() {
    const stats = fs.statSync(this.filePath);
    const currentSize = stats.size;
    let sessionReset = false;
    if (currentSize < this.lastKnownSize) {
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
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      return { lines: [], sessionReset };
    }
    const completeText = text.slice(0, lastNewline);
    this.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf-8");
    const lines = completeText.split("\n").map((l) => l.replace(/\r$/, ""));
    return { lines, sessionReset };
  }
  reset() {
    this.offset = 0;
    this.lastKnownSize = 0;
  }
}
export {
  LogReader
};
