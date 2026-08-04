import type { Card, DeckEntry, GameState, PlayerKey, PlayerState, ZoneName } from './types';

const ALL_ZONES: ZoneName[] = ['command', 'library', 'hand', 'battlefield', 'graveyard', 'exile'];

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

function freshState(): GameState {
	return {
		revision: 0,
		turn: 1,
		active: 'you',
		log: [{ who: 'system', text: 'Table opened. Load a deck for each side, draw an opening hand, and play.' }],
		players: { you: emptyPlayer('You'), ai: emptyPlayer('AI') }
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
	game: GameState | null = null;
	idCounter = 0;

	constructor(ctx: DurableObjectState) {
		this.ctx = ctx;
	}

	async loadGame(): Promise<GameState> {
		if (this.game) return this.game;
		const stored = await this.ctx.storage.get<GameState>('game');
		this.game = stored ?? freshState();
		return this.game;
	}

	async saveGame() {
		if (this.game) await this.ctx.storage.put('game', this.game);
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

		try {
			this.applyAction(msg);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			console.log(`[room] action failed: ${errMsg}`);
			ws.send(JSON.stringify({ type: 'error', error: errMsg }));
			return;
		}

		await this.saveGame();
		this.broadcast();
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
			case 'moveCard':
				return this.moveCard(msg.player, msg.cardId, msg.fromZone, msg.toZone);
			case 'toggleTap':
				return this.toggleTap(msg.player, msg.cardId);
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
			case 'loadDeck':
				return this.loadDeck(msg.player, msg.commanderNames ?? [], msg.deckEntries ?? [], msg.sourceLabel ?? 'Loaded deck');
			case 'addCard':
				return this.addCard(msg.player, msg.zone, msg.name);
			case 'resetTable':
				this.game = freshState();
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
		const next: PlayerKey = game.active === 'you' ? 'ai' : 'you';
		if (next === 'you') game.turn += 1;
		game.active = next;
		// Real Magic has an automatic untap step — without this, a tapped permanent stays tapped
		// forever until someone remembers to toggle it back, and re-tapping it for "this turn's
		// mana" on an already-tapped land silently untaps it instead (a toggle, not a set).
		for (const card of this.player(next).battlefield) card.tapped = false;
		this.addLog('system', `Turn passed — ${next === 'you' ? 'your' : "AI's"} turn (turn ${game.turn})`);
	}

	loadDeck(player: PlayerKey, commanderNames: string[], deckEntries: DeckEntry[], sourceLabel: string) {
		const p = this.player(player);
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

		this.addLog(
			player,
			`${sourceLabel} for ${p.label}: ${command.length} commander(s), ${library.length} library card(s).`
		);
	}

	addCard(player: PlayerKey, zone: ZoneName, name: string) {
		if (!ALL_ZONES.includes(zone)) throw new Error('unknown zone: ' + zone);
		const card: Card = { id: this.nextId(), name };
		this.zoneArr(player, zone).push(card);
		this.addLog(player, `${name} added to ${zone}.`);
	}
}
