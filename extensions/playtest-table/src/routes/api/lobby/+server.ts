import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { SeatDef } from '$lib/server/types';
import type { SeatSummary } from '$lib/server/lobby-registry';

// GET lists every room the registry knows about; POST mints a new one. Room creation talks to two
// different Durable Objects: GAME_ROOM gets seeded with the actual seats (via its non-websocket
// /init POST) before anyone connects, and LOBBY records a display-only summary of the same room so
// /lobby has something to list. These are deliberately separate concerns — GameRoom's `seats`
// track live claim state as people join; the registry's copy is frozen at creation time.

function lobbyStub(platform: App.Platform | undefined) {
	if (!platform?.env?.LOBBY) throw new Error('LOBBY binding not available (are you running via wrangler, not vite dev?)');
	return platform.env.LOBBY.get(platform.env.LOBBY.idFromName('singleton'));
}

export const GET: RequestHandler = async ({ platform }) => {
	try {
		const res = await lobbyStub(platform).fetch('http://lobby/list');
		return new Response(await res.text(), { headers: { 'content-type': 'application/json' } });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const body = (await request.json()) as { label?: string; seats?: { label: string; controller: 'human' | 'ai' }[] };
	const seatInputs = body.seats ?? [];
	if (seatInputs.length < 2) {
		return json({ error: 'a room needs at least 2 seats' }, { status: 400 });
	}
	if (!platform?.env?.GAME_ROOM) {
		return json({ error: 'GAME_ROOM binding not available (are you running via wrangler, not vite dev?)' }, { status: 500 });
	}

	const roomId = crypto.randomUUID();
	const seats: SeatDef[] = seatInputs.map((s, i) => ({
		id: `seat${i}`,
		label: s.label || `Seat ${i + 1}`,
		controller: s.controller === 'ai' ? 'ai' : 'human',
		claimedBy: null
	}));

	const gameStub = platform.env.GAME_ROOM.get(platform.env.GAME_ROOM.idFromName(roomId));
	const initRes = await gameStub.fetch('http://room/init', {
		method: 'POST',
		body: JSON.stringify({ type: 'init', seats })
	});
	if (!initRes.ok) {
		return json({ error: 'failed to seed room: ' + (await initRes.text()) }, { status: 502 });
	}

	// Built from the same `seats` array GameRoom was seeded with (not the raw input) so seat ids
	// line up — GameRoom pushes live claimedBy/label updates here keyed by seat id as people join.
	const summary = {
		roomId,
		label: body.label || 'Untitled table',
		seats: seats.map((s): SeatSummary => ({ id: s.id, label: s.label, controller: s.controller, claimedBy: null })),
		createdAt: Date.now()
	};
	try {
		await lobbyStub(platform).fetch('http://lobby/create', {
			method: 'POST',
			body: JSON.stringify(summary)
		});
	} catch (e) {
		// The room itself is already seeded and playable even if the lobby listing fails — don't
		// fail room creation just because it won't show up in the list.
		console.log('[lobby] failed to record room in registry:', e instanceof Error ? e.message : String(e));
	}

	return json({ roomId });
};
