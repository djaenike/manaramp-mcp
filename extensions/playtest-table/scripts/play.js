// CLI for Claude to actually execute moves — connects briefly, sends one action (or none, for
// just reading state), waits for the resulting broadcast, prints it, disconnects. No browser,
// no clicking: this is the thing the whole browser-automation detour was trying to reach.
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
//   node scripts/play.js loadPreset <you|ai> "<preset name substring>"
//   node scripts/play.js addCard <you|ai> <zone> "<card name>"
//   node scripts/play.js reset
//   node scripts/play.js raw '{"type":"...", ...}'

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOM_URL = process.env.ROOM_URL || 'ws://127.0.0.1:8787/api/room/default';
const PRESETS_PATH = path.join(__dirname, '..', 'static', 'deck-data', 'presets.json');

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
			}
		}
		ws.addEventListener('message', handler);
		if (action) ws.send(JSON.stringify(action));
	});
}

function findCardId(state, player, zone, name) {
	const arr = state.players[player][zone];
	const card = arr.find((c) => c.name.toLowerCase() === name.toLowerCase());
	if (!card) throw new Error(`no card named "${name}" in ${player}'s ${zone} (have: ${arr.map((c) => c.name).join(', ') || 'nothing'})`);
	return card.id;
}

function summarize(state) {
	const lines = [];
	lines.push(`turn ${state.turn}, active: ${state.active}, revision ${state.revision}`);
	for (const key of ['you', 'ai']) {
		const p = state.players[key];
		lines.push(
			`${key} (${p.label}) — life ${p.life} | command: [${p.command.map((c) => c.name).join(', ')}] | ` +
			`hand (${p.hand.length}): [${p.hand.map((c) => c.name).join(', ')}] | ` +
			`battlefield (${p.battlefield.length}): [${p.battlefield.map((c) => c.name + (c.tapped ? ' (tapped)' : '')).join(', ')}] | ` +
			`library: ${p.library.length} | graveyard: ${p.graveyard.length} | exile: ${p.exile.length}`
		);
	}
	lines.push('--- last 5 log entries ---');
	state.log.slice(-5).forEach((e) => lines.push(`${e.who}: ${e.text}`));
	return lines.join('\n');
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	if (!cmd) {
		console.error('missing command — see top of scripts/play.js for usage');
		process.exit(1);
	}

	const ws = await connect();
	// Connecting always gets the current state pushed immediately, with no action needed.
	const initial = await sendAndAwait(ws, null);

	let result = initial;
	try {
		if (cmd === 'state') {
			// nothing further to do, already have it
		} else if (cmd === 'move') {
			const [player, name, fromZone, toZone] = args;
			const cardId = findCardId(initial, player, fromZone, name);
			result = await sendAndAwait(ws, { type: 'moveCard', player, cardId, fromZone, toZone });
		} else if (cmd === 'tap') {
			const [player, name] = args;
			const cardId = findCardId(initial, player, 'battlefield', name);
			result = await sendAndAwait(ws, { type: 'toggleTap', player, cardId });
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
		} else if (cmd === 'loadPreset') {
			const [player, needle] = args;
			const presets = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
			const preset = presets.find((p) => p.label.toLowerCase().includes(needle.toLowerCase()));
			if (!preset) throw new Error(`no preset matches "${needle}". Options: ${presets.map((p) => p.label).join(' | ')}`);
			result = await sendAndAwait(ws, {
				type: 'loadDeck', player,
				commanderNames: preset.commander, deckEntries: preset.deck,
				sourceLabel: `Loaded preset "${preset.label}"`
			});
		} else if (cmd === 'addCard') {
			const [player, zone, name] = args;
			result = await sendAndAwait(ws, { type: 'addCard', player, zone, name });
		} else if (cmd === 'reset') {
			result = await sendAndAwait(ws, { type: 'resetTable' });
		} else if (cmd === 'raw') {
			result = await sendAndAwait(ws, JSON.parse(args[0]));
		} else {
			throw new Error('unknown command: ' + cmd);
		}
	} finally {
		ws.close();
	}

	console.log(summarize(result));
	process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
