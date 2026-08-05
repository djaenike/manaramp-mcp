// Answers "did anyone start a game while I wasn't in a conversation?" — Claude has no standing
// connection to this server and no way to be paged by it; this is the one-shot check meant to run
// at the start of any playtest-related conversation (or whenever asked "check playtest").
// Scans every room the lobby knows about, opens each one just long enough to read its current
// state, and flags any room where the active seat is AI-controlled (i.e. actually needs a move).

const HTTP_BASE = process.env.HTTP_BASE || 'http://127.0.0.1:8787';
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws');

// Same stdout-flush race as play.js/watch-for-turn.js — redirected output can otherwise get
// truncated right before process.exit().
function exitCleanly(code) {
	process.stdout.write('', () => process.exit(code));
}

function getRoomState(roomId) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/api/room/${roomId}`);
		const timer = setTimeout(() => { ws.close(); reject(new Error('timed out waiting for state')); }, 5000);
		ws.addEventListener('message', (event) => {
			let msg;
			try { msg = JSON.parse(event.data); } catch { return; }
			if (msg.type === 'state') {
				clearTimeout(timer);
				ws.close();
				resolve(msg.state);
			}
		});
		ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(e.message || String(e))); });
	});
}

async function main() {
	const res = await fetch(`${HTTP_BASE}/api/lobby`);
	if (!res.ok) throw new Error(`GET /api/lobby failed: ${res.status}`);
	const rooms = await res.json();
	if (rooms.error) throw new Error(rooms.error);

	const aiRooms = rooms.filter((r) => r.seats.some((s) => s.controller === 'ai'));
	if (!aiRooms.length) {
		console.log('No rooms with an AI seat right now.');
		exitCleanly(0);
		return;
	}

	console.log(`${aiRooms.length} room(s) with an AI seat:`);
	for (const room of aiRooms) {
		try {
			const state = await getRoomState(room.roomId);
			const activeSeat = state.seats.find((s) => s.id === state.active);
			const needsMove = activeSeat?.controller === 'ai';
			console.log(
				`- ${room.roomId}  "${room.label}"  turn ${state.turn}, active: ${activeSeat?.label ?? state.active} (${activeSeat?.controller ?? '?'})` +
				(needsMove ? '   <-- needs an AI move' : '')
			);
		} catch (e) {
			console.log(`- ${room.roomId}  "${room.label}"  — couldn't read state: ${e.message}`);
		}
	}
	exitCleanly(0);
}

main().catch((e) => { console.error('ERROR:', e.message); exitCleanly(1); });
