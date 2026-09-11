/**
 * sub-tools/arena-log/card_ratings.js
 * Loads a card_ratings CSV the user manually exported from 17lands.com's own website (a normal
 * export feature on that page) -- NOT fetched by this server. This MCP process never talks to
 * 17lands.com at all; 17Lands' own usage guidelines discourage third-party tools from hitting
 * their live site/API directly (rate-limited, embargoed for new sets), which is exactly the
 * pattern several archived/community MTGA draft tools use and this repo deliberately does not
 * replicate. A manually-exported snapshot file sidesteps that entirely.
 *
 * Column meanings (confirmed against 17Lands' own published metric definitions, 17lands.com's
 * "Card Performance Metrics Definitions" page -- not guessed):
 *   ALSA = Average Last Seen At: the average pick NUMBER at which the card was last seen still
 *          sitting unpicked in a pack (a card taken on its first pass is "seen" once, at that
 *          pick; a card that wheels back around is "seen" again on the second pass, pulling its
 *          average higher). Low ALSA = usually gone immediately = highly prized. This is NOT the
 *          pick position it was actually taken at -- that's ATA. Use ALSA for signal-reading: if
 *          a card in your colors is still available later in a real pack than its ALSA would
 *          predict, that's a live signal that color is more open at your table than average.
 *   ATA  = Average Taken At: the average pick position at which 17Lands drafters actually took
 *          this card (distinct from ALSA above).
 *   GIH WR = Games-in-Hand Win Rate: win rate in games where the card was drawn into hand at any
 *          point (opening hand or later) -- 17Lands' own headline "how good is this card" number.
 *   GP/OH/GD WR = win rate when in-deck / drawn in opening hand / drawn later (not opening hand),
 *          respectively. GNS WR = win rate in games where the card was in the maindeck but never
 *          drawn/seen at all -- the baseline GIH WR is compared against.
 *   IIH = Improvement In Hand (17Lands renamed this from "Improvement When Drawn" on 2025-08-01;
 *         same metric, just the new label) = GIH WR minus GNS WR, i.e. how much the deck's win
 *         rate actually changes when this specific card shows up vs. when it doesn't. 17Lands'
 *         own stated caveat: this is an unweighted difference, so it can overstate a rare bomb's
 *         value off a small handful of high-swing games -- cross-check against GIH WR's own
 *         sample size (# GIH) before leaning on a large IIH alone.
 * Blank cells (small sample size, per 17Lands' own reporting threshold) are returned as null, not
 * 0 -- treat null as "no reliable data," not "bad card."
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parsePercent(raw) {
  if (!raw) return null;
  const n = parseFloat(raw.replace("%", "").replace("pp", ""));
  return isNaN(n) ? null : n;
}

function parseNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

const COLUMN_MAP = {
  "Name": "name", "Color": "color", "Rarity": "rarity",
  "# Seen": "seen", "ALSA": "alsa", "# Picked": "picked", "ATA": "ata",
  "# GP": "gp", "% GP": "gp_pct", "GP WR": "gp_wr",
  "# OH": "oh", "OH WR": "oh_wr", "# GD": "gd", "GD WR": "gd_wr",
  "# GIH": "gih", "GIH WR": "gih_wr", "# GNS": "gns", "GNS WR": "gns_wr",
  "IIH": "iih",
};
const PERCENT_KEYS = new Set(["gp_pct", "gp_wr", "oh_wr", "gd_wr", "gih_wr", "gns_wr", "iih"]);
const NUMBER_KEYS = new Set(["seen", "alsa", "picked", "ata", "gp", "oh", "gd", "gih", "gns"]);

/** Parses raw 17lands.com card_ratings CSV text into an array of normalized row objects. */
function parseCardRatingsCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV has no data rows -- check this is an actual card_ratings export from 17lands.com.");
  }
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => {
      const key = COLUMN_MAP[h] ?? h;
      const raw = values[idx] ?? "";
      row[key] = PERCENT_KEYS.has(key) ? parsePercent(raw) : NUMBER_KEYS.has(key) ? parseNumber(raw) : raw;
    });
    rows.push(row);
  }
  return rows;
}

/** Reads and parses a card_ratings CSV file from disk into a Map<lowercased card name, row>. */
function loadCardRatings(filePath) {
  const csvText = readFileSync(filePath, "utf8");
  const rows = parseCardRatingsCsv(csvText);
  const byName = new Map();
  for (const row of rows) {
    if (row.name) byName.set(row.name.toLowerCase(), row);
  }
  return byName;
}

/**
 * Picks the most-recently-modified .csv file in a directory (the drop-in folder for a manually
 * exported 17Lands snapshot, next to this server) -- a temporary substitute for a real store
 * (e.g. SQLite) until this grows beyond "drop one file in a folder and re-export when you want
 * fresher numbers." Returns null if the directory doesn't exist yet or has no .csv files.
 */
function findLatestCsvInDir(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    return null;
  }
  const csvFiles = entries
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => {
      const full = join(dirPath, f);
      try {
        return { full, mtimeMs: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!csvFiles.length) return null;
  csvFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return csvFiles[0].full;
}

export { parseCardRatingsCsv, loadCardRatings, findLatestCsvInDir };
