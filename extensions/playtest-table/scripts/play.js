// CLI for Claude to actually execute moves — connects briefly, sends one action (or none, for
// just reading state), waits for the resulting broadcast, prints it, disconnects. No browser,
// no clicking: this is the thing the whole browser-automation detour was trying to reach.
//
// Card names are resolved server-side (by GameRoom), not here — that's what makes `batch` safe:
// a batch can play a land by name and then tap that same land by name in the next step, and it
// resolves correctly because the server looks each one up against the state as it exists *after*
// the prior step, not against a stale snapshot fetched before the batch was sent.
//
// Card art/type/cost/text (cardInfo) is resolved server-side too, via the same /api/resolve-deck
// and /api/random-deck HTTP routes the browser's import panel uses — there's no local card
// database file anymore. `state.cardInfo` (returned by every command) has everything already.
//
// Usage:
//   node scripts/play.js state
//   node scripts/play.js move <you|ai> "<card name>" <fromZone> <toZone>
//   node scripts/play.js tap <you|ai> "<card name>"
//   node scripts/play.js draw <you|ai>
//   node scripts/play.js shuffle <you|ai>
//   node scripts/play.js openingHand <you|ai>
//   node scripts/play.js mulligan <you|ai>
//   node scripts/play.js life <you|ai> <+N|-N>
//   node scripts/play.js pass
//   node scripts/play.js importDeck <you|ai> <path to decklist .txt file>   (Moxfield-style export)
//   node scripts/play.js randomDeck <you|ai> ["<commander name>"]          (blank = random pick)
//   node scripts/play.js addCard <you|ai> <zone> "<card name>"        (also how you create tokens — any name works)
//   node scripts/play.js remove <you|ai> <zone> "<card name>"         (deletes outright — for tokens leaving play)
//   node scripts/play.js counter <you|ai> "<card name>" <counterType> <+N|-N>   (zone defaults to battlefield)
//   node scripts/play.js search <you|ai> <library|hand> <query>       (matches by name OR type line, e.g. "land", "goblin")
//   node scripts/play.js reset
//   node scripts/play.js raw '{"type":"...", ...}'
//   node scripts/play.js batch '[{"type":"moveCard","player":"ai","cardName":"Island","fromZone":"hand","toZone":"battlefield"},{"type":"toggleTap","player":"ai","cardName":"Island"},{"type":"passTurn"}]'
//
// A whole turn is normally one `batch` call — one connection, one round trip — instead of one
// process + connection per action.

import fs from 'fs';

const ROOM_URL = process.env.ROOM_URL || 'ws://127.0.0.1:8787/api/room/default';
const HTTP_BASE = ROOM_URL.replace(/^ws/, 'http').replace(/\/api\/room\/.*$/, '');

// process.exit() right after console.log races with stdout when it's redirected to a file (as it
// always is here, since these run backgrounded) — the process can die before the write actually
// flushes, silently truncating the last line or two. Writing an empty string and exiting from its
// callback guarantees the buffer has drained first.
function exitCleanly(code) {
	process.stdout.write('', () => process.exit(code));
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(ROOM_URL);
		ws.addEventListener('open', () => resolve(ws));
		ws.addEventListener('error', (e) => reject(new Error('connection failed: ' + (e.message || e))));
	});
}

function sendAndAwait(ws, action) {
	return new Promise((resolve, reject) => {
		function handler(event) {
			const msg = JSON.parse(event.data);
			if (msg.type === 'state') {
				ws.removeEventListener('message', handler);
				resolve(msg.state);
			} else if (msg.type === 'error') {
				ws.removeEventListener('message', handler);
				reject(new Error(msg.error));
			} else if (msg.type === 'batchErrors') {
				// Arrives before the final 'state' broadcast — log and keep waiting for state.
				console.error('batch had failed sub-action(s):');
				for (const { action: failedAction, error } of msg.errors) {
					console.error(`  ${JSON.stringify(failedAction)} -> ${error}`);
				}
			}
		}
		ws.addEventListener('message', handler);
		if (action) ws.send(JSON.stringify(action));
	});
}

async function resolveDeck(commanderNames, deckEntries) {
	const res = await fetch(`${HTTP_BASE}/api/resolve-deck`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ commanderNames, deckEntries })
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error);
	return data; // { cardInfo, notFound }
}

async function fetchRandomDeck(commander) {
	const res = await fetch(`${HTTP_BASE}/api/random-deck`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(commander ? { commander } : {})
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error);
	return data; // { commander, deckEntries, cardInfo, notFound, sourceCommander }
}

function parseDecklist(text) {
	const lines = text.split(/\r?\n/);
	let section = 'deck';
	const commanderNames = [];
	const deckEntries = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const m = line.match(/^(\d+)x?\s+(.+)$/i);
		if (!m) {
			const lower = line.toLowerCase();
			if (lower.startsWith('commander')) section = 'commander';
			else if (lower.startsWith('sideboard')) section = 'sideboard';
			else if (lower.startsWith('deck') || lower.startsWith('mainboard')) section = 'deck';
			continue;
		}
		const qty = parseInt(m[1], 10);
		const name = m[2].trim();
		if (section === 'commander') commanderNames.push(name);
		else if (section === 'deck') deckEntries.push({ qty, name });
	}
	return { commanderNames, deckEntries };
}

function describeCard(c) {
	const bits = [c.name];
	if (c.tapped) bits.push('(tapped)');
	if (c.counters && Object.keys(c.counters).length) {
		const counterStr = Object.entries(c.counters).map(([type, n]) => `${n} ${type}`).join(', ');
		bits.push(`[${counterStr}]`);
	}
	return bits.join(' ');
}

function summarize(state) {
	const lines = [];
	lines.push(`turn ${state.turn}, active: ${state.active}, revision ${state.revision}`);
	for (const key of ['you', 'ai']) {
		const p = state.players[key];
		lines.push(
			`${key} (${p.label}) — life ${p.life} | command: [${p.command.map((c) => c.name).join(', ')}] | ` +
			`hand (${p.hand.length}): [${p.hand.map((c) => c.name).join(', ')}] | ` +
			`battlefield (${p.battlefield.length}): [${p.battlefield.map(describeCard).join(', ')}] | ` +
			`library: ${p.library.length} | graveyard: ${p.graveyard.length} | exile: ${p.exile.length}`
		);
	}
	lines.push('--- last 8 log entries ---');
	state.log.slice(-8).forEach((e) => lines.push(`${e.who}: ${e.text}`));
	return lines.join('\n');
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	if (!cmd) {
		console.error('missing command — see top of scripts/play.js for usage');
		exitCleanly(1);
		return;
	}

	const ws = await connect();
	// Connecting always gets the current state pushed immediately, with no action needed.
	const initial = await sendAndAwait(ws, null);

	let result = initial;
	try {
		if (cmd === 'state') {
			// nothing further to do, already have it
		} else if (cmd === 'move') {
			const [player, cardName, fromZone, toZone] = args;
			result = await sendAndAwait(ws, { type: 'moveCard', player, cardName, fromZone, toZone });
		} else if (cmd === 'tap') {
			const [player, cardName] = args;
			result = await sendAndAwait(ws, { type: 'toggleTap', player, cardName });
		} else if (cmd === 'draw') {
			result = await sendAndAwait(ws, { type: 'draw', player: args[0] });
		} else if (cmd === 'shuffle') {
			result = await sendAndAwait(ws, { type: 'shuffleLibrary', player: args[0] });
		} else if (cmd === 'openingHand') {
			result = await sendAndAwait(ws, { type: 'openingHand', player: args[0] });
		} else if (cmd === 'mulligan') {
			result = await sendAndAwait(ws, { type: 'mulligan', player: args[0] });
		} else if (cmd === 'life') {
			const [player, deltaStr] = args;
			result = await sendAndAwait(ws, { type: 'adjustLife', player, delta: parseInt(deltaStr, 10) });
		} else if (cmd === 'pass') {
			result = await sendAndAwait(ws, { type: 'passTurn' });
		} else if (cmd === 'importDeck') {
			const [player, filePath] = args;
			const text = fs.readFileSync(filePath, 'utf8');
			const { commanderNames, deckEntries } = parseDecklist(text);
			if (!commanderNames.length && !deckEntries.length) throw new Error('no cards found in ' + filePath);
			console.error(`resolving ${commanderNames.length + deckEntries.length} card name(s) against Scryfall...`);
			const { cardInfo, notFound } = await resolveDeck(commanderNames, deckEntries);
			if (notFound.length) console.error('not found:', notFound.join(', '));
			result = await sendAndAwait(ws, {
				type: 'loadDeck', player, commanderNames, deckEntries, cardInfo,
				sourceLabel: 'Imported deck'
			});
		} else if (cmd === 'randomDeck') {
			const [player, commander] = args;
			console.error(commander ? `pulling EDHREC average build for "${commander}"...` : 'picking a random commander from EDHREC...');
			const data = await fetchRandomDeck(commander);
			if (data.notFound?.length) console.error('not found:', data.notFound.join(', '));
			console.error(`resolved: ${data.sourceCommander}`);
			result = await sendAndAwait(ws, {
				type: 'loadDeck', player,
				commanderNames: data.commander, deckEntries: data.deckEntries, cardInfo: data.cardInfo,
				sourceLabel: `Random deck: EDHREC average build for "${data.sourceCommander}"`
			});
		} else if (cmd === 'addCard') {
			const [player, zone, name] = args;
			const { cardInfo } = await resolveDeck([], [{ qty: 1, name }]);
			result = await sendAndAwait(ws, { type: 'addCard', player, zone, name, cardInfo });
		} else if (cmd === 'remove') {
			const [player, zone, cardName] = args;
			result = await sendAndAwait(ws, { type: 'removeCard', player, zone, cardName });
		} else if (cmd === 'counter') {
			const [player, cardName, counterType, deltaStr] = args;
			result = await sendAndAwait(ws, { type: 'adjustCounter', player, cardName, counterType, delta: parseInt(deltaStr, 10) });
		} else if (cmd === 'search') {
			const [player, zone, ...queryParts] = args;
			const query = queryParts.join(' ').toLowerCase();
			const cardInfo = initial.cardInfo || {};
			const cards = initial.players[player][zone] || [];
			const matches = cards.filter((c) => {
				if (c.name.toLowerCase().includes(query)) return true;
				const known = cardInfo[c.name.toLowerCase()];
				return !!(known && known.typeLine && known.typeLine.toLowerCase().includes(query));
			});
			const counts = {};
			for (const c of matches) counts[c.name] = (counts[c.name] || 0) + 1;
			console.log(`Matches for "${query}" in ${player}'s ${zone} (${matches.length} card(s) out of ${cards.length}):`);
			for (const [name, n] of Object.entries(counts)) console.log(`  ${name} x${n}`);
			exitCleanly(0);
			return;
		} else if (cmd === 'reset') {
			result = await sendAndAwait(ws, { type: 'resetTable' });
		} else if (cmd === 'raw') {
			result = await sendAndAwait(ws, JSON.parse(args[0]));
		} else if (cmd === 'batch') {
			const actions = JSON.parse(args[0]);
			result = await sendAndAwait(ws, { type: 'batch', actions });
		} else {
			throw new Error('unknown command: ' + cmd);
		}
	} finally {
		ws.close();
	}

	console.log(summarize(result));
	exitCleanly(0);
}

main().catch((e) => { console.error('ERROR:', e.message); exitCleanly(1); });
