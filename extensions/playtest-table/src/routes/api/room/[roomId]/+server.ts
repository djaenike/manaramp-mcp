import type { RequestHandler } from './$types';

// Forwards a WebSocket upgrade request to this room's Durable Object instance. One roomId always
// maps to the same DO instance (idFromName), so every client that connects to /api/room/<id>
// ends up talking to the same in-memory room, which is what makes broadcast-to-room work.
export const GET: RequestHandler = async ({ request, params, platform }) => {
	if (request.headers.get('upgrade') !== 'websocket') {
		return new Response('expected a websocket upgrade request', { status: 426 });
	}
	if (!platform?.env?.GAME_ROOM) {
		return new Response('GAME_ROOM binding not available (are you running via wrangler, not vite dev?)', { status: 500 });
	}

	const id = platform.env.GAME_ROOM.idFromName(params.roomId);
	const stub = platform.env.GAME_ROOM.get(id);
	return stub.fetch(request);
};
