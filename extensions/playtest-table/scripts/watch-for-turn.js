// Waits until it's the AI's turn, then exits. This is a client, not a server — it holds one
// outbound WebSocket connection to the room (same as play.js, same as any browser tab) and just
// watches state broadcasts. The actual "wake Claude up" mechanism isn't this script itself — it's
// that a background process Claude launched has exited, which the harness reports automatically.
// This script's only job is to make sure that exit happens at the right moment.

const ROOM_URL = process.env.ROOM_URL || 'ws://127.0.0.1:8787/api/room/default';

// process.exit() right after console.log races with stdout when it's redirected to a file (as it
// always is here, since this runs backgrounded) — flushing via the write callback first avoids
// silently truncating the final summary before the harness reads the output file.
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

function waitForAiTurn(ws) {
	return new Promise((resolve, reject) => {
		ws.addEventListener('message', function handler(event) {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (msg.type === 'error') {
				ws.removeEventListener('message', handler);
				reject(new Error(msg.error));
				return;
			}
			if (msg.type !== 'state') return;
			if (msg.state.active === 'ai') {
				ws.removeEventListener('message', handler);
				resolve(msg.state);
			}
		});
	});
}

function describeCard(c) {
	const bits = [c.name];
	if (c.tapped) bits.push('(tapped)');
	if (c.counters && Object.keys(c.counters).length) {
		bits.push(`[${Object.entries(c.counters).map(([t, n]) => `${n} ${t}`).join(', ')}]`);
	}
	return bits.join(' ');
}

function summarize(state) {
	const lines = [];
	lines.push(`It's the AI's turn (turn ${state.turn}).`);
	for (const key of ['you', 'ai']) {
		const p = state.players[key];
		lines.push(
			`${key} — life ${p.life} | hand (${p.hand.length}): [${p.hand.map((c) => c.name).join(', ')}] | ` +
			`battlefield: [${p.battlefield.map(describeCard).join(', ')}]`
		);
	}
	lines.push('--- last 5 log entries ---');
	state.log.slice(-5).forEach((e) => lines.push(`${e.who}: ${e.text}`));
	return lines.join('\n');
}

async function main() {
	console.log('watching', ROOM_URL, '— waiting for active === "ai" ...');
	const ws = await connect();
	const state = await waitForAiTurn(ws);
	ws.close();
	console.log(summarize(state));
	exitCleanly(0);
}

main().catch((e) => { console.error('ERROR:', e.message); exitCleanly(1); });
