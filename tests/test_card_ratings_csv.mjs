// Verifies parseCardRatingsCsv/loadCardRatings against a small representative sample shaped
// exactly like a real 17lands.com/card_ratings CSV export (quoted fields, commas/apostrophes in
// names, blank cells for small sample sizes, negative "pp" values, colorless/gold cards).
import { writeFileSync, unlinkSync } from "fs";
import { parseCardRatingsCsv, loadCardRatings } from "../src/sub-tools/arena-log/card_ratings.js";

const SAMPLE_CSV = [
  '"Name","Color","Rarity","# Seen","ALSA","# Picked","ATA","# GP","% GP","GP WR","# OH","OH WR","# GD","GD WR","# GIH","GIH WR","# GNS","GNS WR","IIH"',
  '"Petrify","W","C","65909","2.83","16429","3.47","94735","91.1%","58.6%","16197","58.1%","23038","60.4%","39235","59.4%","55200","57.9%","1.5pp"',
  '"Abuelo\'s Awakening","W","R","4495","1.71","607","1.74","1321","36.4%","49.1%","212","","322","","534","46.6%","783","50.8%","-4.2pp"',
  '"Anim Pakal, Thousandth Moon","WR","R","2418","1.00","1710","1.00","9432","85.4%","60.1%","1677","67.4%","2097","64.6%","3774","65.8%","5662","56.3%","9.5pp"',
  '"Buried Treasure","","C","134220","7.40","12027","10.36","16521","21.9%","52.8%","2973","50.3%","3599","51.5%","6572","50.9%","9886","54.1%","-3.1pp"',
].join("\n");

const rows = parseCardRatingsCsv(SAMPLE_CSV);
console.log("rows parsed:", rows.length);
console.log(JSON.stringify(rows, null, 2));

const petrify = rows.find((r) => r.name === "Petrify");
const smallSample = rows.find((r) => r.name === "Abuelo's Awakening");
const goldCard = rows.find((r) => r.name === "Anim Pakal, Thousandth Moon");
const colorless = rows.find((r) => r.name === "Buried Treasure");

const pass = rows.length === 4
  && petrify?.gih_wr === 59.4 && petrify?.alsa === 2.83
  // blank cells (small sample) must parse to null, not 0 or NaN or ""
  && smallSample?.oh_wr === null && smallSample?.gd_wr === null
  && smallSample?.iih === -4.2
  && goldCard?.color === "WR"
  && colorless?.color === ""
  // negative pp still parses correctly with the literal minus sign preserved
  && colorless?.iih === -3.1;

// Round-trip through loadCardRatings (the actual file-reading path used by index.js).
const tmpPath = `${process.cwd()}/tests/.tmp_card_ratings_test.csv`;
writeFileSync(tmpPath, SAMPLE_CSV);
const byName = loadCardRatings(tmpPath);
const lookupPass = byName.get("petrify")?.gih_wr === 59.4 && byName.get("nonexistent card") === undefined;
unlinkSync(tmpPath);

console.log(pass && lookupPass
  ? "\nPASS: 17Lands card_ratings CSV parses correctly, including small-sample nulls, gold/colorless cards, and negative pp values."
  : "\nFAIL.");
