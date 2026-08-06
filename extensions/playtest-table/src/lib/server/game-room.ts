import type { Card, DeckEntry, GameState, PlayerKey, PlayerState, SeatDef, ZoneName } from './types';
import { RANDOM_COMMANDERS, fetchEdhrecAverageDeck, resolveCardInfo } from './deck-resolve';
import { requestAiTurn } from './ai-turn';

const ALL_ZONES: ZoneName[] = ['command', 'library', 'hand', 'battlefield', 'graveyard', 'exile'];

// A backstop against a genuine runaway loop (e.g. a stuck deck that only ever draws-and-passes),
// not a realistic ceiling — most games never get within an order of magnitude of this.
const MAX_AI_MOVES_PER_ROOM = 300;

// Fallback shape for a room that's never been seeded via the lobby's /init call (e.g. hit
// directly by an old habit or a script against a fresh room id) — reproduces the original
// you-vs-ai board exactly.
const DEFAULT_SEATS: SeatDef[] = [
	{ id: 'you', label: 'You', controller: 'human', claimedBy: null },
	{ id: 'ai', label: 'AI', controller: 'ai', claimedBy: null }
];

function emptyPlayer(label: string): PlayerState {
	return {
		label,
		life: 40,
		command: [],
		library: [],
		hand: [],
		battlefield: [],
		graveyard: [],
		exile: [],
		mulligans: 0
	};
}

// cardInfo defaults to {} for a brand-new room, but "Reset table" passes through whatever's
// already been resolved — resetting the board shouldn't throw away Scryfall lookups you already
// paid for, since cardInfo only ever grows and is never wrong to keep around.
function freshState(seats: SeatDef[] = DEFAULT_SEATS, cardInfo: GameState['cardInfo'] = {}): GameState {
	return {
		revision: 0,
		turn: 1,
		active: seats[0].id,
		log: [{ who: 'system', text: 'Table opened. Load a deck for each side, draw an opening hand, and play.' }],
		seats,
		players: Object.fromEntries(seats.map((s) => [s.id, emptyPlayer(s.label)])),
		cardInfo,
		aiMoveCount: 0,
		aiConsecutiveFailures: 0
	};
}

function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

// One room = one Durable Object = one authoritative GameState. Every connected client (you
// clicking your own moves, Claude's WebSocket script pushing the AI's moves) sends the same
// small action messages; this class is the only thing that ever mutates state, and it broadcasts
// the full resulting state back out after every action so every connected socket stays in sync
// without needing its own copy of the mutation logic.
export class GameRoom {
	ctx: DurableObjectState;
	env: Env;
	game: GameState | null = null;
	idCounter = 0;
	lastBatchErrors: { action: unknown; error: string }[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	// Best-effort push to the lobby registry so /lobby can show "1 seat taken, 1 open" without
	// asking every room directly. this.ctx.id.name recovers the roomId string this instance was
	// addressed by (only populated when the id came from idFromName, which is always true here).
	// Never lets a registry hiccup break the actual claim/release action — it already happened.
	private notifyLobby(seatId: string, claimedBy: string | null, label?: string) {
		const roomId = this.ctx.id.name;
		if (!roomId || !this.env?.LOBBY) return;
		const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('singleton'));
		stub.fetch('http://lobby/seat-update', {
			method: 'POST',
			body: JSON.stringify({ roomId, seatId, claimedBy, label })
		}).catch(() => {});
	}

	async loadGame(): Promise<GameState> {
		if (this.game) return this.game;
		const stored = await this.ctx.storage.get<GameState>('game');
		this.game = stored && Array.isArray(stored.seats) ? stored : freshState(DEFAULT_SEATS, stored?.cardInfo ?? {});
		// Guards against state persisted before cardInfo existed — without this, the first
		// Object.assign(this.game.cardInfo, ...) in loadDeck/addCard throws on old rooms.
		this.game.cardInfo ??= {};
		return this.game;
	}

	async saveGame() {
		if (this.game) await this.ctx.storage.put('game', this.game);
	}

	// Idempotent on purpose: the lobby's create route calls this right after allocating a
	// roomId, but if the room somehow already has saved state, seeding it again must not clobber
	// an in-progress game.
	async initSeats(seats: SeatDef[]) {
		const stored = await this.ctx.storage.get<GameState>('game');
		if (stored && Array.isArray(stored.seats)) {
			this.game = stored;
			this.game.cardInfo ??= {};
			return;
		}
		this.game = freshState(seats, stored?.cardInfo ?? {});
		// AI seats get a real deck (and an opening hand) immediately — "Me vs AI"/"AI vs AI" shouldn't
		// start with an empty board waiting on someone to manually load one via chat/CLI first.
		for (const seat of seats) {
			if (seat.controller === 'ai') await this.autoLoadRandomDeck(seat.id);
		}
		await this.saveGame();
		// Covers the AI-vs-AI case: freshState() sets active to seats[0], which may already be
		// AI-controlled before anyone ever calls passTurn().
		this.maybeScheduleAiTurn();
	}

	// Reactive per-room scheduling (a Durable Object Alarm), not a global cron sweep — fires once,
	// ~1.5s after whatever just made this seat active, giving the just-saved state a moment to
	// broadcast first and keeping AI-vs-AI spectator play watchable instead of instant.
	private maybeScheduleAiTurn() {
		const seat = this.game?.seats.find((s) => s.id === this.game?.active);
		if (seat?.controller === 'ai') this.ctx.storage.setAlarm(Date.now() + 1500);
	}

	// Cloudflare calls this automatically when a scheduled alarm fires. This is what makes an AI
	// seat's turn happen with zero dependency on any Claude Code/Desktop session being open — the
	// Worker calls Anthropic's API directly, using its own ANTHROPIC_API_KEY secret.
	async alarm() {
		await this.loadGame();
		const game = this.game!;
		const seat = game.seats.find((s) => s.id === game.active);
		if (!seat || seat.controller !== 'ai') return; // stale/superseded alarm — nothing to do

		if ((game.aiMoveCount ?? 0) >= MAX_AI_MOVES_PER_ROOM) {
			this.addLog('system', 'Automatic AI play limit reached for this room — no further automatic moves.');
			await this.saveGame();
			return;
		}

		try {
			const actions = await requestAiTurn(game, seat.id, this.env);
			game.aiMoveCount = (game.aiMoveCount ?? 0) + 1;
			game.aiConsecutiveFailures = 0;
			this.applyAction({ type: 'batch', actions });
			// Safety net: if the model's batch didn't end with passTurn, force it so the room can
			// never stall waiting on a move that already happened.
			if (game.active === seat.id) this.passTurn();
		} catch (e) {
			game.aiConsecutiveFailures = (game.aiConsecutiveFailures ?? 0) + 1;
			const errMsg = e instanceof Error ? e.message : String(e);
			this.addLog('system', `AI move failed (${game.aiConsecutiveFailures}/3): ${errMsg}`);
			if (game.aiConsecutiveFailures >= 3) {
				this.addLog(
					'system',
					'Stopping automatic play for this seat after repeated failures — check the ' +
						'ANTHROPIC_API_KEY secret, then pass the turn manually to resume.'
				);
				await this.saveGame();
				this.broadcast();
				return; // do not reschedule — avoids hot-looping a persistently broken call (e.g. a bad key)
			}
		}

		await this.saveGame();
		this.broadcast();
		this.maybeScheduleAiTurn();
	}

	// Best-effort: a failed Scryfall/EDHREC lookup just logs and leaves that seat empty rather than
	// blocking room creation entirely. Also reused whenever a deck needs to be changed later (a
	// human clicking "New random deck" on an AI seat sends the exact same loadDeck action this
	// produces, just from the browser instead of at seed time).
	private async autoLoadRandomDeck(seatId: string, commanderName?: string) {
		try {
			const pick = commanderName || RANDOM_COMMANDERS[Math.floor(Math.random() * RANDOM_COMMANDERS.length)];
			const { commander, deckEntries } = await fetchEdhrecAverageDeck(pick);
			const names = [...commander, ...deckEntries.map((e) => e.name)];
			const { cardInfo } = await resolveCardInfo(names);
			this.loadDeck(seatId, commander, deckEntries, `Random deck: EDHREC average build for "${pick}"`, cardInfo);
			this.openingHand(seatId);
		} catch (e) {
			this.addLog('system', `Couldn't auto-load a deck for ${seatId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	nextId(): string {
		this.idCounter += 1;
		return 'c' + Date.now().toString(36) + '-' + this.idCounter;
	}

	broadcast() {
		const sockets = this.ctx.getWebSockets();
		const payload = JSON.stringify({ type: 'state', state: this.game });
		console.log(`[room] broadcasting rev=${this.game?.revision} turn=${this.game?.turn} active=${this.game?.active} to ${sockets.length} socket(s)`);
		for (const ws of sockets) {
			try {
				ws.send(payload);
			} catch {
				// socket already gone; nothing to do
			}
		}
	}

	addLog(who: GameState['log'][number]['who'], text: string) {
		if (!this.game) return;
		this.game.log.push({ who, text });
		if (this.game.log.length > 300) this.game.log.shift();
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade') !== 'websocket') {
			// The lobby's create route seeds a brand-new room with its chosen seats via a plain POST,
			// before anyone ever opens a websocket to it.
			if (request.method === 'POST') {
				let body: any;
				try {
					body = await request.json();
				} catch {
					return new Response('invalid json', { status: 400 });
				}
				if (body?.type === 'init') {
					await this.initSeats(body.seats ?? DEFAULT_SEATS);
					return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
				}
				return new Response('unknown POST action', { status: 400 });
			}
			return new Response('expected a websocket upgrade request', { status: 426 });
		}
		const game = await this.loadGame();

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		console.log(`[room] connect — now ${this.ctx.getWebSockets().length} socket(s), sending current state (rev=${game.revision})`);
		// There's no "connection opened" lifecycle hook in the Hibernation API — webSocketMessage/
		// Close/Error are the only ones Cloudflare actually calls. So the initial state has to be
		// sent here, directly on the server-side socket, before the 101 response goes out.
		server.send(JSON.stringify({ type: 'state', state: game }));

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		await this.loadGame();
		if (!this.game) return;

		let msg: any;
		try {
			msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
		} catch {
			console.log('[room] received non-JSON message, ignoring');
			return;
		}

		console.log(`[room] action: ${msg.type} ${JSON.stringify(msg)}`);

		// Deliberately not routed through applyAction: ending a table is destructive (wipes storage,
		// removes it from the lobby list) and needs real awaited async work, unlike every other
		// action, which only ever mutates the in-memory game object.
		if (msg.type === 'endTable') {
			await this.endTable();
			return;
		}

		this.lastBatchErrors = [];
		try {
			this.applyAction(msg);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			console.log(`[room] action failed: ${errMsg}`);
			ws.send(JSON.stringify({ type: 'error', error: errMsg }));
			return;
		}

		if (this.lastBatchErrors.length) {
			ws.send(JSON.stringify({ type: 'batchErrors', errors: this.lastBatchErrors }));
		}

		await this.saveGame();
		this.broadcast();
	}

	// Explicit and deliberate, not tied to anyone navigating away or closing a tab — a real PvP
	// game shouldn't die just because one player hit "back" for a second. Wipes persisted storage
	// and removes the room from the lobby list so it can't be rejoined or resurrected, then tells
	// every connected client (both players, any spectator) to leave.
	async endTable() {
		const roomId = this.ctx.id.name;
		if (roomId && this.env?.LOBBY) {
			const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('singleton'));
			await stub.fetch('http://lobby/remove', { method: 'POST', body: JSON.stringify({ roomId }) }).catch(() => {});
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		this.game = null;
		const payload = JSON.stringify({ type: 'ended' });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// socket already gone; nothing to do
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		console.log(`[room] disconnect — now ${this.ctx.getWebSockets().length - 1} socket(s) (code=${code})`);
		ws.close(code, reason);
	}

	async webSocketError(ws: WebSocket) {
		try {
			ws.close(1011, 'error');
		} catch {
			// already closed
		}
	}

	// --- action handling -----------------------------------------------------------------

	applyAction(msg: any) {
		const game = this.game!;
		switch (msg.type) {
			case 'moveCard': {
				const cardId = msg.cardId ?? this.findCardIdByName(msg.player, msg.fromZone, msg.cardName);
				return this.moveCard(msg.player, cardId, msg.fromZone, msg.toZone);
			}
			case 'toggleTap': {
				const cardId = msg.cardId ?? this.findCardIdByName(msg.player, 'battlefield', msg.cardName);
				return this.toggleTap(msg.player, cardId);
			}
			case 'batch': {
				// Applied in order, against the state as it exists after each prior step — so a
				// batch like [play land by name, tap that same land by name] resolves correctly
				// even though the land doesn't exist yet when the batch is sent. Doesn't throw on
				// a failed sub-action; collects errors so the rest of the batch (and the final
				// save+broadcast) still happens instead of silently discarding earlier progress.
				const errors: { action: unknown; error: string }[] = [];
				for (const sub of msg.actions ?? []) {
					try {
						this.applyAction(sub);
					} catch (e) {
						errors.push({ action: sub, error: e instanceof Error ? e.message : String(e) });
					}
				}
				if (errors.length) {
					console.log(`[room] batch had ${errors.length} failed sub-action(s): ${JSON.stringify(errors)}`);
				}
				this.lastBatchErrors = errors;
				return;
			}
			case 'draw':
				return this.draw(msg.player);
			case 'shuffleLibrary':
				return this.shuffleLibrary(msg.player);
			case 'openingHand':
				return this.openingHand(msg.player);
			case 'mulligan':
				return this.mulligan(msg.player);
			case 'adjustLife':
				return this.adjustLife(msg.player, msg.delta);
			case 'passTurn':
				return this.passTurn();
			case 'claimSeat':
				return this.claimSeat(msg.seatId, msg.clientId, msg.label);
			case 'releaseSeat':
				return this.releaseSeat(msg.seatId, msg.clientId);
			case 'loadDeck':
				return this.loadDeck(
					msg.player, msg.commanderNames ?? [], msg.deckEntries ?? [],
					msg.sourceLabel ?? 'Loaded deck', msg.cardInfo ?? {}
				);
			case 'addCard':
				return this.addCard(msg.player, msg.zone, msg.name, msg.cardInfo ?? {});
			case 'removeCard': {
				const cardId = msg.cardId ?? this.findCardIdByName(msg.player, msg.zone, msg.cardName);
				return this.removeCard(msg.player, msg.zone, cardId);
			}
			case 'adjustCounter': {
				const zone: ZoneName = msg.zone ?? 'battlefield';
				const cardId = msg.cardId ?? this.findCardIdByName(msg.player, zone, msg.cardName);
				return this.adjustCounter(msg.player, zone, cardId, msg.counterType, msg.delta);
			}
			case 'resetTable':
				this.game = freshState(this.game?.seats ?? DEFAULT_SEATS, this.game?.cardInfo ?? {});
				return;
			default:
				throw new Error('unknown action: ' + msg.type);
		}
	}

	private player(key: PlayerKey): PlayerState {
		const p = this.game!.players[key];
		if (!p) throw new Error('unknown player: ' + key);
		return p;
	}

	private zoneArr(key: PlayerKey, zone: ZoneName): Card[] {
		return this.player(key)[zone];
	}

	private findCardIdByName(player: PlayerKey, zone: ZoneName, name: string): string {
		const card = this.zoneArr(player, zone).find((c) => c.name.toLowerCase() === (name ?? '').toLowerCase());
		if (!card) {
			const have = this.zoneArr(player, zone).map((c) => c.name).join(', ') || 'nothing';
			throw new Error(`no card named "${name}" in ${player}'s ${zone} (have: ${have})`);
		}
		return card.id;
	}

	moveCard(player: PlayerKey, cardId: string, fromZone: ZoneName, toZone: ZoneName) {
		if (!ALL_ZONES.includes(toZone)) throw new Error('unknown zone: ' + toZone);
		const fromArr = this.zoneArr(player, fromZone);
		const idx = fromArr.findIndex((c) => c.id === cardId);
		if (idx === -1) return;
		const [card] = fromArr.splice(idx, 1);
		card.tapped = false;
		const toArr = this.zoneArr(player, toZone);
		if (toZone === 'library') toArr.unshift(card);
		else toArr.push(card);
		this.addLog(player, `${card.name} moved: ${fromZone} → ${toZone}`);
	}

	toggleTap(player: PlayerKey, cardId: string) {
		const card = this.player(player).battlefield.find((c) => c.id === cardId);
		if (!card) return;
		card.tapped = !card.tapped;
	}

	draw(player: PlayerKey) {
		const p = this.player(player);
		if (!p.library.length) return;
		const card = p.library.shift()!;
		p.hand.push(card);
		this.addLog(player, `${p.label} drew ${card.name}.`);
	}

	shuffleLibrary(player: PlayerKey) {
		const p = this.player(player);
		shuffle(p.library);
		this.addLog(player, `${p.label} shuffled their library.`);
	}

	openingHand(player: PlayerKey) {
		const p = this.player(player);
		if (!p.library.length && !p.hand.length) throw new Error(`Import a decklist for ${p.label} first.`);
		p.library = p.library.concat(p.hand);
		p.hand = [];
		shuffle(p.library);
		const n = Math.min(7, p.library.length);
		p.hand = p.library.splice(0, n);
		this.addLog(player, `${p.label} drew an opening hand of ${n}.`);
	}

	mulligan(player: PlayerKey) {
		const p = this.player(player);
		if (!p.library.length && !p.hand.length) throw new Error(`Import a decklist for ${p.label} first.`);
		p.library = p.library.concat(p.hand);
		p.hand = [];
		shuffle(p.library);
		const n = Math.min(7, p.library.length);
		p.hand = p.library.splice(0, n);
		p.mulligans += 1;
		this.addLog(player, `${p.label} mulliganed (${p.mulligans}) and drew a fresh 7 — simplified, no London bottoming.`);
	}

	adjustLife(player: PlayerKey, delta: number) {
		const n = Number(delta);
		if (!Number.isInteger(n)) throw new Error('delta must be an integer');
		this.player(player).life += n;
	}

	passTurn() {
		const game = this.game!;
		// seats[] is turn order — cycling its index generalizes the old you/ai binary toggle to any
		// number of seats. Wrapping back to the first seat is what starting a new turn means.
		const idx = game.seats.findIndex((s) => s.id === game.active);
		const nextIdx = (idx + 1) % game.seats.length;
		const nextSeat = game.seats[nextIdx];
		const next: PlayerKey = nextSeat.id;
		if (nextIdx === 0) game.turn += 1;
		game.active = next;
		// Real Magic has an automatic untap step — without this, a tapped permanent stays tapped
		// forever until someone remembers to toggle it back, and re-tapping it for "this turn's
		// mana" on an already-tapped land silently untaps it instead (a toggle, not a set).
		for (const card of this.player(next).battlefield) card.tapped = false;
		this.addLog('system', `Turn passed — ${nextSeat.label}'s turn (turn ${game.turn})`);

		// Real Magic also has an automatic draw step, with the standard exception that whoever
		// goes first skips it on their very first turn. That exception falls out for free here:
		// the starting player's first turn is set directly by freshState(), never by passTurn(),
		// so this only ever fires on a turn that's actually being *passed into* — exactly the
		// turns where a draw is supposed to happen. Also removes a whole round trip Claude used to
		// need (call `draw`, look at the result, then decide) before it could act on the AI's turn.
		const p = this.player(next);
		if (p.library.length) {
			const card = p.library.shift()!;
			p.hand.push(card);
			this.addLog(next, `${p.label} drew ${card.name} for the turn.`);
		}

		this.maybeScheduleAiTurn();
	}

	// Claiming is a client-side-only convenience (which browser tab thinks it's "playing" which
	// seat), not server-enforced access control — any client can still send moves for any seat
	// regardless of claim state. It only exists so the UI knows which controls to default to.
	// An optional label lets whoever's claiming (re)name the seat to their own name at the same
	// time — otherwise a joining player would be stuck under whatever generic label the room was
	// created with.
	claimSeat(seatId: string, clientId: string, label?: string) {
		const seat = this.game!.seats.find((s) => s.id === seatId);
		if (!seat) throw new Error('unknown seat: ' + seatId);
		if (seat.controller === 'ai') throw new Error('seat is AI-controlled, cannot be claimed');
		if (seat.claimedBy && seat.claimedBy !== clientId) throw new Error('seat already claimed');
		seat.claimedBy = clientId;
		if (label) {
			seat.label = label;
			// PlayerState.label is a separate copy taken at seat-creation time (see freshState) — keep
			// it in sync so the board's life/hand/log display picks up the real name too, not just the
			// seat list.
			this.player(seatId).label = label;
		}
		this.notifyLobby(seatId, clientId, label);
	}

	releaseSeat(seatId: string, clientId: string) {
		const seat = this.game!.seats.find((s) => s.id === seatId);
		if (seat && seat.claimedBy === clientId) {
			seat.claimedBy = null;
			this.notifyLobby(seatId, null);
		}
	}

	loadDeck(
		player: PlayerKey, commanderNames: string[], deckEntries: DeckEntry[], sourceLabel: string,
		cardInfo: GameState['cardInfo'] = {}
	) {
		const p = this.player(player);
		Object.assign(this.game!.cardInfo, cardInfo);

		const command: Card[] = commanderNames.map((name) => ({ id: this.nextId(), name }));
		const library: Card[] = [];
		deckEntries.forEach((entry) => {
			for (let i = 0; i < entry.qty; i++) library.push({ id: this.nextId(), name: entry.name });
		});
		shuffle(library);

		p.command = command;
		p.library = library;
		p.hand = [];
		p.battlefield = [];
		p.graveyard = [];
		p.exile = [];
		p.mulligans = 0;

		const unresolved = [...commanderNames, ...deckEntries.map((e) => e.name)]
			.filter((n) => !this.game!.cardInfo[n.toLowerCase()]);
		const note = unresolved.length ? ` (${unresolved.length} card(s) unresolved: ${unresolved.join(', ')})` : '';
		this.addLog(
			player,
			`${sourceLabel} for ${p.label}: ${command.length} commander(s), ${library.length} library card(s).${note}`
		);
	}

	addCard(player: PlayerKey, zone: ZoneName, name: string, cardInfo: GameState['cardInfo'] = {}) {
		if (!ALL_ZONES.includes(zone)) throw new Error('unknown zone: ' + zone);
		Object.assign(this.game!.cardInfo, cardInfo);
		const card: Card = { id: this.nextId(), name };
		this.zoneArr(player, zone).push(card);
		this.addLog(player, `${name} added to ${zone}.`);
	}

	// For tokens that leave play (real Magic tokens cease to exist once they change zones) or
	// general cleanup — deletes the card outright rather than moving it somewhere else.
	removeCard(player: PlayerKey, zone: ZoneName, cardId: string) {
		const arr = this.zoneArr(player, zone);
		const idx = arr.findIndex((c) => c.id === cardId);
		if (idx === -1) return;
		const [card] = arr.splice(idx, 1);
		this.addLog(player, `${card.name} removed from ${zone}.`);
	}

	adjustCounter(player: PlayerKey, zone: ZoneName, cardId: string, counterType: string, delta: number) {
		const n = Number(delta);
		if (!Number.isInteger(n) || n === 0) throw new Error('delta must be a non-zero integer');
		if (!counterType) throw new Error('counterType is required');
		const card = this.zoneArr(player, zone).find((c) => c.id === cardId);
		if (!card) throw new Error(`card not found in ${player}'s ${zone}`);
		card.counters ??= {};
		const next = (card.counters[counterType] ?? 0) + n;
		if (next <= 0) delete card.counters[counterType];
		else card.counters[counterType] = next;
		this.addLog(player, `${card.name}: ${n > 0 ? '+' : ''}${n} ${counterType} counter(s) (now ${card.counters[counterType] ?? 0}).`);
	}
}
