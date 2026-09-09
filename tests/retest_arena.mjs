import { LogReader } from "./sub-tools/arena-log/log_reader.js";
import { extractGreEvents, buildMatchTimeline } from "./sub-tools/arena-log/gre_match_parser.js";
import { enrichTimeline } from "./sub-tools/arena-log/grpid_resolver.js";
import { DraftScanner } from "./sub-tools/arena-log/draft_log_parser.js";

const CARD_DB = {
  105182: { name: 'Forest' }, 105178: { name: 'Swamp' }, 95199: { name: 'Forest' },
  93940: { name: 'Llanowar Elves' }, 93982: { name: 'Thornwood Falls' },
  98430: { name: 'Moonshadow' }, 94074: { name: 'Springbloom Druid' },
};
async function fakeSearchCards(query) {
  const id = parseInt(query.split(':')[1], 10);
  return CARD_DB[id] ? [CARD_DB[id]] : [];
}

const reader = new LogReader('/mnt/user-data/uploads/Player.log');
const { lines } = reader.readNewLines();
const { events, droppedCount } = extractGreEvents(lines);
const { timeline } = buildMatchTimeline(events);
const enriched = await enrichTimeline(timeline, fakeSearchCards);

console.log('Parsed events:', events.length, '| dropped:', droppedCount, '(expect 63 / 1)');
let ok = true;
for (const t of enriched) {
  if (t.kind === 'landPlayed' || t.kind === 'spellCast') {
    const name = t.card ? t.card.name : 'UNRESOLVED';
    console.log(' ', t.kind, '->', name, '(turn', t.turn+')');
    if (name === 'UNRESOLVED') ok = false;
  }
}

// quick draft scanner sanity check too
const scanner = new DraftScanner();
const draftStartLine = '[UnityCrossThreadLogger]==> Event_Join ' + JSON.stringify({
  id: 'x', request: JSON.stringify({ Payload: JSON.stringify({ EventName: 'PremierDraft_FIN_20260101' }) }),
});
const r = scanner.processLines([draftStartLine]);
console.log('DraftScanner still works:', r.length === 1 && r[0].kind === 'draftStart');

console.log(ok ? "\nALL ESM FUNCTIONAL TESTS PASSED" : "\nSOMETHING BROKE IN CONVERSION");
