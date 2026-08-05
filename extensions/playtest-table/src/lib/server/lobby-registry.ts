// A singleton Durable Object (always addressed via idFromName('singleton')) that just holds a
// JSON list of rooms so a fresh browser tab has something to discover — there's no API to
// enumerate GameRoom's idFromName-derived instances from outside, so this list is the only
// record of "what rooms exist." Plain request/response JSON, no websocket: the lobby list isn't
// realtime-pushed, a refetch on navigating to /lobby is all this needs.
//
// claimedBy is kept in sync live: GameRoom pushes a best-effort update here every time a seat is
// claimed/released (see game-room.ts's notifyLobby), so the lobby can tell "1 seat taken, 1 open"
// apart from "nobody's here yet" without asking every room directly.
export interface SeatSummary {
	id: string;
	label: string;
	controller: 'human' | 'ai';
	claimedBy: string | null;
}

export interface RoomSummary {
	roomId: string;
	label: string;
	seats: SeatSummary[];
	createdAt: number;
}

export class LobbyRegistry {
	ctx: DurableObjectState;
	rooms: RoomSummary[] | null = null;

	constructor(ctx: DurableObjectState) {
		this.ctx = ctx;
	}

	async load(): Promise<RoomSummary[]> {
		if (this.rooms) return this.rooms;
		this.rooms = (await this.ctx.storage.get<RoomSummary[]>('rooms')) ?? [];
		return this.rooms;
	}

	async save() {
		await this.ctx.storage.put('rooms', this.rooms ?? []);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const rooms = await this.load();

		if (request.method === 'GET' && url.pathname.endsWith('/list')) {
			return Response.json(rooms);
		}

		if (request.method === 'POST' && url.pathname.endsWith('/create')) {
			const body = (await request.json()) as RoomSummary;
			rooms.unshift(body);
			await this.save();
			return Response.json(body);
		}

		if (request.method === 'POST' && url.pathname.endsWith('/remove')) {
			const { roomId } = (await request.json()) as { roomId: string };
			this.rooms = rooms.filter((r) => r.roomId !== roomId);
			await this.save();
			return Response.json({ ok: true });
		}

		if (request.method === 'POST' && url.pathname.endsWith('/seat-update')) {
			const { roomId, seatId, claimedBy, label } = (await request.json()) as
				{ roomId: string; seatId: string; claimedBy: string | null; label?: string };
			const room = rooms.find((r) => r.roomId === roomId);
			const seat = room?.seats.find((s) => s.id === seatId);
			if (seat) {
				seat.claimedBy = claimedBy;
				if (label) seat.label = label;
				await this.save();
			}
			return Response.json({ ok: true });
		}

		return new Response('unknown lobby action', { status: 400 });
	}
}
