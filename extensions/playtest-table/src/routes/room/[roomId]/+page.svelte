<script lang="ts">
	// This board is a shared visual aid, not a two-blind-players simulator — every connected
	// socket (you clicking your own moves, Claude's script pushing the AI's) gets the same full
	// state broadcast from the GameRoom Durable Object and renders it the same way. Nothing here
	// holds its own authoritative copy of game state; `game` below is just "what the server told
	// us most recently."
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	type ZoneName = 'command' | 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile';
	// An opaque seat id, not a closed 2-value union — the valid set for this room is whatever
	// game.seats contains.
	type PlayerKey = string;
	interface Card { id: string; name: string; tapped?: boolean; counters?: Record<string, number> }
	interface PlayerState {
		label: string; life: number;
		command: Card[]; library: Card[]; hand: Card[]; battlefield: Card[]; graveyard: Card[]; exile: Card[];
		mulligans: number;
	}
	interface SeatDef { id: string; label: string; controller: 'human' | 'ai'; claimedBy: string | null }
	interface CardInfoEntry { name: string; image: string | null; typeLine: string; manaCost?: string; oracleText?: string }
	interface ResolveDeckResponse { cardInfo: Record<string, CardInfoEntry>; notFound: string[]; error?: string }
	interface RandomDeckResponse extends ResolveDeckResponse {
		commander: string[]; deckEntries: { qty: number; name: string }[]; sourceCommander: string;
	}
	interface GameState {
		revision: number; turn: number; active: PlayerKey;
		log: { who: PlayerKey | 'system'; text: string }[];
		seats: SeatDef[];
		players: Record<PlayerKey, PlayerState>;
		cardInfo: Record<string, CardInfoEntry>;
	}

	let roomId = $derived(page.params.roomId);
	const ZONE_LABELS: Record<ZoneName, string> = {
		battlefield: 'Battlefield', hand: 'Hand', command: 'Command zone',
		graveyard: 'Graveyard', exile: 'Exile', library: 'Library (top)'
	};

	let game: GameState | null = $state(null);
	let connStatus = $state('connecting');
	// 'info' covers anything that isn't a genuine problem (resolving/loading/success messages) —
	// only real failures get the red/error treatment.
	let statusMsg = $state('');
	let statusKind: 'info' | 'error' = $state('info');
	function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
		statusMsg = msg;
		statusKind = kind;
	}
	let ws: WebSocket | null = null;

	// A per-browser id, not a real account — "claiming" a seat is a client-side-only UI
	// convenience (which browser tab thinks it's playing which seat), not server-enforced access
	// control. Anyone can still send moves for any seat regardless of claim state.
	let clientId = $state('');
	$effect(() => {
		let id = localStorage.getItem('ptClientId');
		if (!id) {
			id = crypto.randomUUID();
			localStorage.setItem('ptClientId', id);
		}
		clientId = id;
	});

	// No fallback to seats[0] here — if this clientId hasn't actually claimed a seat, mySeat must be
	// null (a pure spectator, or the split second before the auto-claim effect below resolves), not
	// silently pretend to be whichever seat happens to be first. That matters once a room can be
	// visited by more than one browser: a fallback would make an unrelated visitor to a full PvP
	// room appear to "own" someone else's already-claimed seat.
	let mySeatId = $derived(game?.seats.find((s) => s.claimedBy === clientId)?.id ?? '');
	let mySeat = $derived(mySeatId ? (game?.seats.find((s) => s.id === mySeatId) ?? null) : null);
	// Which seat renders on top vs. bottom. If I have a seat, mine is always the bottom row (the
	// existing "your row on the bottom" convention); if I don't (spectating), just show both seats
	// in their natural order — nobody's row gets "mine" styling or controls.
	let displaySeats = $derived.by((): [SeatDef | null, SeatDef | null] => {
		if (!game) return [null, null];
		if (mySeat) return [game.seats.find((s) => s.id !== mySeatId) ?? null, mySeat];
		return [game.seats[0] ?? null, game.seats[1] ?? null];
	});
	let otherSeat = $derived(displaySeats[0]);
	let bottomSeat = $derived(displaySeats[1]);

	// The name a joining player typed into the lobby's "Play vs AI" / "Play vs a Human" flow — used
	// only to rename the seat this browser ends up claiming, so a joiner isn't stuck under whatever
	// generic label the room was created with.
	let joinName = $derived(page.url.searchParams.get('as') ?? '');

	// One rule covers every case: whoever loads a room with no seat of their own yet takes the
	// first still-open human seat. The creator of a "vs AI" or "vs a Human" table gets auto-seated
	// the moment their own browser connects; a second player joining the same PvP room gets
	// whichever seat is left. AI-vs-AI rooms have zero open human seats, so nobody auto-claims —
	// that's what makes them read-only/spectator automatically.
	$effect(() => {
		if (!game) return;
		if (game.seats.some((s) => s.claimedBy === clientId)) return;
		const openHuman = game.seats.filter((s) => s.controller === 'human' && !s.claimedBy);
		if (openHuman.length) claimSeat(openHuman[0].id);
	});
	// AI-vs-AI rooms are just rooms where every seat happens to be AI-controlled — no separate
	// "spectator mode" flag, this is derived straight from the seat list. Spectators get a
	// read-only board; every mutating control below checks this.
	let allAi = $derived(game?.seats.every((s) => s.controller === 'ai') ?? false);

	// Which seat the import panel currently targets — defaults to nothing until you either open
	// your own ("Import your deck") or click "Change deck" on an AI seat. AI seats have no
	// fairness concern (nobody's being spied on), so this is deliberately allowed regardless of
	// claim state or spectator mode — it's table setup, not a move.
	let importOpen = $state(false);
	let importTargetSeat = $state('');
	let importTargetLabel = $derived(game?.seats.find((s) => s.id === importTargetSeat)?.label ?? '');
	let importText = $state('');
	let importBusy = $state(false);

	function openImportFor(seatId: string) {
		importTargetSeat = seatId;
		importOpen = true;
	}

	// Ad-hoc card/token adding lives on the battlefield itself (see the mini-add-form in the
	// shared-battlefield template below), not the top toolbar — it's specifically for creating
	// tokens mid-game, always onto your own battlefield.
	let cardInput = $state('');

	let zoomCard: CardInfoEntry | null = $state(null);
	let zoneMenu: { player: PlayerKey; zone: ZoneName; cardId: string; name: string; x: number; y: number } | null = $state(null);

	let resetArmed = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	// Explicit, deliberate table termination — not tied to navigation/back/tab-close, since a real
	// PvP game shouldn't die just because one player's browser hiccups. Double-click-to-confirm,
	// same pattern as reset.
	let endArmed = $state(false);
	let endTimer: ReturnType<typeof setTimeout> | null = null;
	function clickEndTable() {
		if (!endArmed) {
			endArmed = true;
			endTimer = setTimeout(() => { endArmed = false; }, 4000);
			return;
		}
		if (endTimer) clearTimeout(endTimer);
		endArmed = false;
		send({ type: 'endTable' });
	}

	// Card art/type/cost/text all live in the room's own shared state now (resolved once at
	// import time via /api/resolve-deck or /api/random-deck), not a static file this page fetches —
	// so lookups here just read whatever the server has already told us.
	function lookupCard(name: string): CardInfoEntry | null {
		return game?.cardInfo[name.trim().toLowerCase()] ?? null;
	}

	function seatLabel(who: string): string {
		if (who === 'system') return 'system';
		return game?.seats.find((s) => s.id === who)?.label ?? who;
	}
	function whoClass(who: string): string {
		if (who === 'system') return 'who-system';
		return who === mySeatId ? 'who-mine' : 'who-theirs';
	}

	// Ordered so the battlefield reads the way a physical table does: lands along the bottom of
	// each player's zone, then the things that actually attack/block, then support permanents.
	const CATEGORY_ORDER = ['Land', 'Creature', 'Planeswalker', 'Enchantment', 'Artifact', 'Other'] as const;

	function categorize(name: string): (typeof CATEGORY_ORDER)[number] {
		const typeLine = lookupCard(name)?.typeLine ?? '';
		if (typeLine.includes('Land')) return 'Land';
		if (typeLine.includes('Creature')) return 'Creature';
		if (typeLine.includes('Planeswalker')) return 'Planeswalker';
		if (typeLine.includes('Enchantment')) return 'Enchantment';
		if (typeLine.includes('Artifact')) return 'Artifact';
		return 'Other';
	}

	function groupByCategory(cards: Card[]): Partial<Record<(typeof CATEGORY_ORDER)[number], Card[]>> {
		const groups: Partial<Record<(typeof CATEGORY_ORDER)[number], Card[]>> = {};
		for (const c of cards) {
			const cat = categorize(c.name);
			(groups[cat] ??= []).push(c);
		}
		return groups;
	}

	function send(action: Record<string, unknown>) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
	}

	function connect() {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(`${proto}://${location.host}/api/room/${roomId}`);
		connStatus = 'connecting';
		ws.addEventListener('open', () => { connStatus = 'connected'; });
		ws.addEventListener('close', () => { connStatus = 'disconnected'; });
		ws.addEventListener('error', () => { connStatus = 'error'; });
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === 'state') game = msg.state;
			else if (msg.type === 'error') setStatus(msg.error, 'error');
			else if (msg.type === 'ended') goto('/lobby');
		});
	}

	$effect(() => {
		connect();
		return () => ws?.close();
	});

	// --- seat claiming -----------------------------------------------------------------------
	function claimSeat(seatId: string) {
		send({ type: 'claimSeat', seatId, clientId, label: joinName || undefined });
	}
	function releaseSeat(seatId: string) {
		send({ type: 'releaseSeat', seatId, clientId });
	}

	// Re-sending claimSeat for a seat this clientId already owns just updates the label — covers
	// anyone who lands on a room via a bare link (no ?as= from the lobby) and wants to fix their
	// name after the fact.
	let nameEditOpen = $state(false);
	let nameEditValue = $state('');
	function startNameEdit() {
		nameEditValue = mySeat?.label ?? '';
		nameEditOpen = true;
	}
	function submitNameEdit(e: Event) {
		e.preventDefault();
		if (!mySeatId || !nameEditValue.trim()) return;
		send({ type: 'claimSeat', seatId: mySeatId, clientId, label: nameEditValue.trim() });
		nameEditOpen = false;
	}

	// --- zone-move popover -----------------------------------------------------------------
	function openZoneMenu(player: PlayerKey, zone: ZoneName, card: Card, anchor: HTMLElement) {
		const rect = anchor.getBoundingClientRect();
		zoneMenu = { player, zone, cardId: card.id, name: card.name, x: rect.left, y: rect.bottom + 4 };
	}
	function closeZoneMenu() { zoneMenu = null; }
	function moveTo(toZone: ZoneName) {
		if (!zoneMenu) return;
		send({ type: 'moveCard', player: zoneMenu.player, cardId: zoneMenu.cardId, fromZone: zoneMenu.zone, toZone });
		closeZoneMenu();
	}

	// --- card zoom modal ---------------------------------------------------------------------
	function openZoom(name: string) {
		zoomCard = lookupCard(name) ?? { name, image: null, typeLine: '' };
	}
	function closeZoom() { zoomCard = null; }

	// --- toolbar / import actions ------------------------------------------------------------
	// Every card that enters the game — added ad hoc, pasted as a decklist, or pulled randomly
	// from EDHREC — goes through the same server-side resolve step so it always ends up with real
	// art/type/cost/text, not just a name.
	async function submitAddCard(e: Event) {
		e.preventDefault();
		const name = cardInput.trim();
		if (!name) return;
		setStatus(`Resolving "${name}"...`);
		try {
			const res = await fetch('/api/resolve-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deckEntries: [{ qty: 1, name }] })
			});
			const data = (await res.json()) as ResolveDeckResponse;
			if (data.error) throw new Error(data.error);
			send({ type: 'addCard', player: mySeatId, zone: 'battlefield', name, cardInfo: data.cardInfo });
			setStatus(data.notFound?.length ? `"${name}" not found on Scryfall — added as text only.` : '');
			cardInput = '';
		} catch (e) {
			setStatus(e instanceof Error ? e.message : String(e), 'error');
		}
	}

	function parseDecklist(text: string) {
		const lines = text.split(/\r?\n/);
		let section: 'commander' | 'deck' | 'sideboard' = 'deck';
		const commanderNames: string[] = [];
		const deckEntries: { qty: number; name: string }[] = [];
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

	async function submitImport() {
		const { commanderNames, deckEntries } = parseDecklist(importText);
		if (!commanderNames.length && !deckEntries.length) {
			setStatus('No cards found in pasted text.', 'error');
			return;
		}
		importOpen = false;
		importBusy = true;
		setStatus(`Resolving ${commanderNames.length + deckEntries.length} card(s) against Scryfall...`);
		try {
			const res = await fetch('/api/resolve-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ commanderNames, deckEntries })
			});
			const data = (await res.json()) as ResolveDeckResponse;
			if (data.error) throw new Error(data.error);
			send({
				type: 'loadDeck', player: importTargetSeat, commanderNames, deckEntries,
				sourceLabel: 'Imported deck', cardInfo: data.cardInfo
			});
			// AI seats get a hand drawn immediately, same as at room creation — nobody's sitting there
			// to click "Opening 7" for them. Human decks stay manual (you decide when to draw).
			if (game?.seats.find((s) => s.id === importTargetSeat)?.controller === 'ai') {
				send({ type: 'openingHand', player: importTargetSeat });
			}
			setStatus(
				data.notFound?.length
					? `Loaded — ${data.notFound.length} card(s) not found on Scryfall: ${data.notFound.join(', ')}`
					: 'Deck resolved and loaded.'
			);
			importText = '';
		} catch (e) {
			setStatus(e instanceof Error ? e.message : String(e), 'error');
		} finally {
			importBusy = false;
		}
	}

	// Always a genuinely random commander — a specific deck comes from the paste-a-decklist path
	// above instead (someone's own build, or one Claude already put together for them elsewhere).
	async function randomDeck() {
		importOpen = false;
		importBusy = true;
		setStatus("Picking a random commander and pulling its EDHREC average build...");
		try {
			const res = await fetch('/api/random-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			const data = (await res.json()) as RandomDeckResponse;
			if (data.error) throw new Error(data.error);
			send({
				type: 'loadDeck', player: importTargetSeat,
				commanderNames: data.commander, deckEntries: data.deckEntries,
				sourceLabel: `Random deck: EDHREC average build for "${data.sourceCommander}"`,
				cardInfo: data.cardInfo
			});
			if (game?.seats.find((s) => s.id === importTargetSeat)?.controller === 'ai') {
				send({ type: 'openingHand', player: importTargetSeat });
			}
			setStatus(
				data.notFound?.length
					? `Loaded "${data.sourceCommander}" — ${data.notFound.length} card(s) not found: ${data.notFound.join(', ')}`
					: `Loaded "${data.sourceCommander}".`
			);
		} catch (e) {
			setStatus(e instanceof Error ? e.message : String(e), 'error');
		} finally {
			importBusy = false;
		}
	}

	function clickReset() {
		if (!resetArmed) {
			resetArmed = true;
			resetTimer = setTimeout(() => { resetArmed = false; }, 4000);
			return;
		}
		if (resetTimer) clearTimeout(resetTimer);
		resetArmed = false;
		send({ type: 'resetTable' });
	}
</script>

<svelte:head>
	<title>Playtest Table</title>
</svelte:head>

<div class="page-wrap">
<div class="toolbar">
	<div class="title-block">
		<a class="back-link" href="/lobby">&larr; Lobby</a>
		<h1>Playtest Table</h1>
		<span class="subtitle">live &middot; {connStatus}{game ? ` · turn ${game.turn} · rev ${game.revision}` : ''}</span>
	</div>
	{#if mySeat}
		<button type="button" class="btn purple" onclick={() => openImportFor(mySeatId)}>Import your deck</button>
	{/if}
	{#if game}
		<button type="button" class="btn danger-txt {endArmed ? 'armed' : ''}" onclick={clickEndTable}>
			{endArmed ? 'Click again to end table' : 'End table'}
		</button>
	{/if}
</div>

{#if statusMsg}
	<div class="status-line {statusKind}">{statusMsg}</div>
{/if}

{#if importOpen && importTargetSeat}
	<div class="import-panel">
		<div class="import-row">
			<span class="import-hint">
				Loading a deck here replaces <strong>{importTargetSeat === mySeatId ? 'your own' : `${importTargetLabel}'s`}</strong>
				command zone, library, hand, battlefield, graveyard, and exile — paste a Moxfield-style export below
				(optional "Commander" / "Deck" / "Sideboard" headers, one "&lt;qty&gt; &lt;name&gt;" per line).
			</span>
			<button type="button" class="btn small" onclick={() => (importOpen = false)}>Close</button>
		</div>
		<textarea rows="8" bind:value={importText} placeholder={'Commander\n1 Zada, Hedron Grinder\n\nDeck\n1 Sol Ring\n30 Mountain'}></textarea>
		<div class="import-row">
			<button type="button" class="btn purple" disabled={importBusy} onclick={submitImport}>Parse &amp; load deck</button>
		</div>
		<div class="import-row divider">
			<button type="button" class="btn" disabled={importBusy} onclick={randomDeck}>Random deck from EDHREC</button>
			<span class="import-hint">Pulls a real decklist off the internet &mdash; EDHREC's average build for a random commander from a small curated pool. Want a specific deck? Paste it above instead.</span>
		</div>
	</div>
{/if}

{#if game}
	<div class="turn-bar">
		<div class="turn-info">
			<span>Turn</span>
			<span class="turn-num">{game.turn}</span>
			<span class="active-chip {game.active === mySeatId ? 'mine' : 'theirs'}">
				{game.active === mySeatId ? 'You are active' : `${seatLabel(game.active)} is active`}
			</span>
			{#if allAi}<span class="spectator-chip">Spectating &mdash; AI vs AI</span>{/if}
		</div>
		{#if mySeat}
			<div class="end-turn-row">
				<button class="btn {resetArmed ? 'danger-txt' : ''}" onclick={clickReset}>
					{resetArmed ? 'Click again to confirm reset' : 'Reset table'}
				</button>
				<button class="btn purple" onclick={() => send({ type: 'passTurn' })}>Pass turn &rarr;</button>
			</div>
		{/if}
	</div>

	<div class="board">
		{#snippet cardImg(name: string)}
			{@const known = lookupCard(name)}
			{#if known?.image}
				<img src={known.image} alt="" loading="lazy" />
			{:else}
				<div class="text-fallback">{name}</div>
			{/if}
		{/snippet}

		{#snippet playerRow(seat: SeatDef)}
			{@const key = seat.id}
			{@const p = game!.players[key]}
			<section class="player-row {seat.id === mySeatId ? 'mine' : 'theirs'}">
				<div class="side-tag">{seat.id === mySeatId ? '▸ Your side — play from here' : `${seat.label}'s side`}</div>
				<div class="stat-col">
					<div class="life-block">
						<div class="name">{p.label}</div>
						<div class="life-value {p.life <= 10 ? 'low' : ''}">{p.life}</div>
						{#if seat.id === mySeatId}
							<div class="stepper">
								<button onclick={() => send({ type: 'adjustLife', player: key, delta: -1 })} aria-label="Decrease life">&minus;</button>
								<button onclick={() => send({ type: 'adjustLife', player: key, delta: 1 })} aria-label="Increase life">+</button>
							</div>
						{/if}
					</div>
					{#if seat.controller === 'ai'}
						<div class="seat-claim ai">AI-controlled</div>
						<button class="seat-claim mine subtle" onclick={() => openImportFor(seat.id)}>Change deck</button>
					{:else if seat.claimedBy === clientId}
						{#if nameEditOpen}
							<form class="name-edit" onsubmit={submitNameEdit}>
								<input type="text" bind:value={nameEditValue} placeholder="Your name" />
								<button type="submit" class="btn small primary">Save</button>
							</form>
						{:else}
							<button class="seat-claim mine" onclick={startNameEdit}>{p.label} &middot; edit name</button>
							<button class="seat-claim mine subtle" onclick={() => releaseSeat(seat.id)}>Release seat</button>
						{/if}
					{:else if seat.claimedBy}
						<div class="seat-claim taken">Claimed</div>
					{:else}
						<button class="seat-claim open" onclick={() => claimSeat(seat.id)}>Claim seat</button>
					{/if}
					<div class="lib-block">
						Library<br /><span class="lib-value">{p.library.length}</span>
						{#if seat.id === mySeatId}
							<div class="stepper">
								<button class="btn small" onclick={() => send({ type: 'draw', player: key })}>Draw</button>
								<button class="btn small" onclick={() => send({ type: 'shuffleLibrary', player: key })}>Shuffle</button>
							</div>
						{/if}
					</div>
					{#if seat.id === mySeatId}
						<div class="hand-setup">
							<button class="btn small" onclick={() => send({ type: 'openingHand', player: key })}>Opening 7</button>
							<button class="btn small" onclick={() => send({ type: 'mulligan', player: key })}>Mulligan ({p.mulligans})</button>
						</div>
					{/if}
				</div>
				<div class="mid-col">
					<div class="zone-label"><span>Command zone</span><span>{p.command.length}</span></div>
					<div class="battlefield compact">
						{#if !p.command.length}
							<div class="empty-hint">No commander loaded &mdash; use Import decklist</div>
						{:else}
							<div class="card-grid">
								{#each p.command as c (c.id)}
									<div class="card-chip command-chip">
										<button class="chip-main" disabled={seat.id !== mySeatId} onclick={() => send({ type: 'moveCard', player: key, cardId: c.id, fromZone: 'command', toZone: 'battlefield' })} title="{c.name} — click to cast to battlefield">
											{@render cardImg(c.name)}
											<span class="cname">{c.name}</span>
										</button>
										<button class="menu-btn zoom-btn" onclick={(e) => { e.stopPropagation(); openZoom(c.name); }} title="View larger">&#128269;</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
					<div class="zone-label" style="margin-top:0.5rem;"><span>Hand</span><span>{p.hand.length}</span></div>
					{#if !p.hand.length}
						<div class="empty-hint">Hand empty</div>
					{:else}
						<div class="hand-strip">
							{#each p.hand as c (c.id)}
								<div class="card-chip">
									<button class="chip-main" disabled={seat.id !== mySeatId} onclick={(e) => openZoneMenu(key, 'hand', c, e.currentTarget)} title={c.name}>
										{@render cardImg(c.name)}
									</button>
									<button class="menu-btn zoom-btn" onclick={(e) => { e.stopPropagation(); openZoom(c.name); }} title="View larger">&#128269;</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>
				<div class="side-zones">
					<div class="mini-zone">
						<div class="count-row"><span class="zone-label" style="margin:0;">Graveyard</span><span class="n">{p.graveyard.length}</span></div>
						{#if p.graveyard.length}
							<div class="mini-list">
								{#each p.graveyard.slice(-6) as c (c.id)}
									<div class="card-chip mini">
										<button class="chip-main" disabled={seat.id !== mySeatId} onclick={(e) => openZoneMenu(key, 'graveyard', c, e.currentTarget)} title={c.name}>
											{@render cardImg(c.name)}
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
					<div class="mini-zone">
						<div class="count-row"><span class="zone-label" style="margin:0;">Exile</span><span class="n">{p.exile.length}</span></div>
						{#if p.exile.length}
							<div class="mini-list">
								{#each p.exile.slice(-6) as c (c.id)}
									<div class="card-chip mini">
										<button class="chip-main" disabled={seat.id !== mySeatId} onclick={(e) => openZoneMenu(key, 'exile', c, e.currentTarget)} title={c.name}>
											{@render cardImg(c.name)}
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</section>
		{/snippet}

		{#if otherSeat}{@render playerRow(otherSeat)}{/if}

		{#snippet battlefieldCardChip(key: PlayerKey, c: Card)}
			<div class="card-chip bf-card {c.tapped ? 'tapped' : ''}">
				<button class="chip-main" disabled={key !== mySeatId} onclick={() => send({ type: 'toggleTap', player: key, cardId: c.id })} title={c.name}>
					{@render cardImg(c.name)}
					<span class="cname">{c.name}</span>
					{#if c.counters && Object.keys(c.counters).length}
						<span class="counter-badge">{Object.entries(c.counters).map(([t, n]) => `${n} ${t}`).join(', ')}</span>
					{/if}
				</button>
				<button class="menu-btn zoom-btn" onclick={(e) => { e.stopPropagation(); openZoom(c.name); }} title="View larger">&#128269;</button>
				{#if key === mySeatId}
					<button class="menu-btn" onclick={(e) => { e.stopPropagation(); openZoneMenu(key, 'battlefield', c, e.currentTarget); }} title="Move to another zone">&#8942;</button>
				{/if}
			</div>
		{/snippet}

		<div class="shared-battlefield">
			{#each displaySeats.filter((s): s is SeatDef => !!s) as seat, i (seat.id)}
				{@const p = game.players[seat.id]}
				{@const groups = groupByCategory(p.battlefield)}
				<div class="sb-half {seat.id === mySeatId ? 'mine' : 'theirs'}">
					<div class="sb-label">
						{seat.id === mySeatId ? '▸ Your battlefield' : `${seat.label}'s battlefield`} &middot; {p.battlefield.length} permanent(s)
					</div>
					{#if seat.id === mySeatId}
						<form class="mini-add-form" onsubmit={submitAddCard}>
							<input type="text" bind:value={cardInput} placeholder="Add a card or token to your battlefield" />
							<button type="submit" class="btn small">Add</button>
						</form>
					{/if}
					{#if !p.battlefield.length}
						<div class="empty-hint">No permanents in play</div>
					{:else}
						{#each CATEGORY_ORDER as cat}
							{#if groups[cat]?.length}
								<div class="bf-category">
									<div class="bf-cat-label">{cat} ({groups[cat].length})</div>
									<div class="card-grid">
										{#each groups[cat] as c (c.id)}
											{@render battlefieldCardChip(seat.id, c)}
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					{/if}
				</div>
				{#if i === 0}<div class="sb-divider"></div>{/if}
			{/each}
		</div>

		{#if bottomSeat}{@render playerRow(bottomSeat)}{/if}
	</div>

	<aside class="spine">
		<h2>Game log</h2>
		<ul class="log-list">
			{#each game.log as entry, i (i)}
				<li class={whoClass(entry.who)}><span class="who">{seatLabel(entry.who)}</span>{entry.text}</li>
			{/each}
		</ul>
	</aside>
{/if}
</div>

{#if zoneMenu}
	<div class="zone-menu-backdrop" onclick={closeZoneMenu}></div>
	<div class="zone-menu" style="top:{zoneMenu.y}px; left:{zoneMenu.x}px;">
		<div class="zone-menu-title">{zoneMenu.name}</div>
		{#each Object.entries(ZONE_LABELS) as [zone, label]}
			{#if zone !== zoneMenu.zone}
				<button onclick={() => moveTo(zone as ZoneName)}>&rarr; {label}</button>
			{/if}
		{/each}
		{#if zoneMenu.zone === 'battlefield'}
			<div class="zone-menu-divider"></div>
			<button onclick={() => { send({ type: 'adjustCounter', player: zoneMenu!.player, cardId: zoneMenu!.cardId, counterType: '+1/+1', delta: 1 }); closeZoneMenu(); }}>+1/+1 counter</button>
			<button onclick={() => { send({ type: 'adjustCounter', player: zoneMenu!.player, cardId: zoneMenu!.cardId, counterType: '+1/+1', delta: -1 }); closeZoneMenu(); }}>&minus;1/&minus;1 counter</button>
		{/if}
	</div>
{/if}

{#if zoomCard}
	{@const known = zoomCard}
	<div class="card-modal-backdrop" onclick={closeZoom}>
		<div class="card-modal" onclick={(e) => e.stopPropagation()}>
			{#if known.image}
				<img src={known.image} alt="" />
			{:else}
				<div class="text-fallback large">{known.name}</div>
			{/if}
			<div class="card-modal-name">{known.name}</div>
			<button class="btn card-modal-close" onclick={closeZoom}>Close</button>
		</div>
	</div>
{/if}

<style>
	:root {
		--ink-950: #0b120f; --ink-900: #101712;
		--felt-800: #16241d; --felt-700: #1e2f26; --felt-600: #28392f;
		--brass-500: #c8a24a; --brass-300: #e4c877; --brass-700: #8f7332;
		--paper-50: #eef1ec;
		--line: rgba(255, 255, 255, 0.09);
		--text-hi: #f2efe4; --text-lo: rgba(242, 239, 228, 0.62);
		--danger: #c1443b; --ok: #6f9a6a;
		--purple: #7c5cd6; --purple-hi: #a488ea;
		--surface: var(--ink-950); --surface-zone: var(--felt-800); --surface-slot: var(--felt-700); --surface-raised: var(--felt-600);
		--border: var(--line); --fg: var(--text-hi); --fg-dim: var(--text-lo);
		--accent: var(--brass-500); --accent-hi: var(--brass-300);
		--font-display: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
		--font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	}
	@media (prefers-color-scheme: light) {
		:root {
			--surface: var(--paper-50); --surface-zone: #e6e9e1; --surface-slot: #dadecf; --surface-raised: #d2d6cb;
			--border: rgba(16, 23, 18, 0.12); --fg: var(--ink-900); --fg-dim: rgba(16, 23, 18, 0.6);
			--accent: var(--brass-700); --accent-hi: #a9853a;
		}
	}
	:global(*, *::before, *::after) { box-sizing: border-box; }
	:global(html), :global(body) {
		margin: 0; background: var(--surface); color: var(--fg); font-family: var(--font-body);
	}
	:global(body) {
		min-height: 100vh; width: 100%; padding: clamp(0.75rem, 2vw, 1.5rem);
		display: flex; flex-direction: column; align-items: center;
	}
	h1, h2 { font-family: var(--font-display); font-weight: 600; margin: 0; }
	button { font-family: inherit; cursor: pointer; }

	.page-wrap { width: 100%; max-width: 78rem; margin: 0 auto; display: flex; flex-direction: column; gap: 0.9rem; }

	.toolbar, .import-panel, .turn-bar, .player-row, .shared-battlefield, .spine {
		background: var(--surface-zone); border: 1px solid var(--border); border-radius: 12px;
	}
	.toolbar { padding: 0.85rem 1.1rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; }
	.title-block { display: flex; align-items: baseline; gap: 0.6rem; margin-right: auto; }
	.title-block h1 { font-size: 1.35rem; }
	.back-link {
		font-size: 0.8rem; font-weight: 600; color: var(--fg); text-decoration: none;
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px;
		padding: 0.4rem 0.7rem; display: inline-flex; align-items: center;
	}
	.back-link:hover { border-color: var(--accent); color: var(--accent); }
	.subtitle { font-size: 0.78rem; color: var(--fg-dim); }
	.status-line { font-size: 0.82rem; color: var(--fg-dim); padding: 0 0.2rem; }
	.status-line.error { color: var(--danger); font-weight: 600; }

	.import-row input[type='text'] {
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg);
		padding: 0.45rem 0.65rem; font-size: 0.88rem; width: 15rem; max-width: 40vw;
	}
	.mini-add-form { display: flex; gap: 0.4rem; margin-bottom: 0.2rem; }
	.mini-add-form input {
		flex: 1; min-width: 0; background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px;
		color: var(--fg); padding: 0.4rem 0.6rem; font-size: 0.82rem;
	}
	select, .import-panel textarea {
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg);
		padding: 0.45rem 0.5rem; font-size: 0.82rem;
	}
	.btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.btn {
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg);
		padding: 0.45rem 0.75rem; font-size: 0.82rem;
	}
	.btn:hover { border-color: var(--accent); }
	.btn.primary { background: var(--accent); color: var(--ink-950); border-color: var(--accent); font-weight: 600; }
	.btn.small { padding: 0.25rem 0.5rem; font-size: 0.72rem; }
	.btn.danger-txt { color: var(--danger); border-color: var(--danger); }
	.btn.danger-txt.armed { background: var(--danger); color: #fff; font-weight: 700; }
	.btn.purple {
		background: linear-gradient(135deg, var(--purple-hi), var(--purple) 70%);
		color: #fff; border-color: var(--purple-hi); font-weight: 700;
		box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--purple) 55%, transparent);
	}
	.btn.purple:hover { filter: brightness(1.1); border-color: var(--purple-hi); }

	.import-panel { padding: 0.85rem 1.1rem; display: flex; flex-direction: column; gap: 0.6rem; }
	.import-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
	.import-row.divider { border-top: 1px solid var(--border); padding-top: 0.6rem; }
	.import-hint { font-size: 0.76rem; color: var(--fg-dim); }
	.import-panel textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem; resize: vertical; }

	.turn-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 1rem; flex-wrap: wrap; }
	.turn-info { display: flex; align-items: center; gap: 0.7rem; font-size: 0.85rem; flex-wrap: wrap; }
	.turn-num { font-family: var(--font-display); font-size: 1.05rem; }
	.active-chip { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.2rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); }
	.active-chip.mine { color: var(--ok); border-color: var(--ok); }
	.active-chip.theirs { color: var(--accent); border-color: var(--accent); }
	.spectator-chip { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.2rem 0.55rem; border-radius: 999px; border: 1px dashed var(--fg-dim); color: var(--fg-dim); }
	.end-turn-row { display: flex; gap: 0.5rem; }

	.board { display: flex; flex-direction: column; gap: 0.9rem; }
	.player-row {
		padding: 0.9rem; display: grid; grid-template-columns: 9.5rem 1fr 12rem;
		grid-template-rows: auto 1fr; gap: 0.3rem 0.9rem; border: 2px solid transparent;
	}
	.side-tag {
		grid-column: 1 / -1; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding-bottom: 0.35rem; margin-bottom: 0.3rem; border-bottom: 1px solid var(--border);
	}
	.player-row.theirs { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 6%, var(--surface-zone)); }
	.player-row.theirs .side-tag { color: var(--accent); }
	.player-row.mine { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, var(--surface-zone)); }
	.player-row.mine .side-tag { color: var(--ok); font-size: 0.8rem; }

	.stat-col { display: flex; flex-direction: column; gap: 0.6rem; }
	.life-block, .lib-block { background: var(--surface-slot); border: 1px solid var(--border); border-radius: 9px; padding: 0.55rem 0.6rem; text-align: center; }
	.life-block .name { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); }
	.life-value { font-family: var(--font-display); font-size: 2rem; line-height: 1.1; margin: 0.15rem 0; }
	.life-value.low { color: var(--danger); }
	.stepper { display: flex; align-items: center; justify-content: center; gap: 0.4rem; flex-wrap: wrap; }
	.stepper button { width: 1.6rem; height: 1.6rem; border-radius: 6px; background: var(--surface-raised); border: 1px solid var(--border); color: var(--fg); }
	.lib-block { font-size: 0.78rem; color: var(--fg-dim); }
	.lib-value { font-family: var(--font-display); font-size: 1.15rem; color: var(--fg); }
	.hand-setup { display: flex; flex-direction: column; gap: 0.3rem; }
	.hand-setup button { width: 100%; }

	.seat-claim {
		font-size: 0.68rem; text-align: center; padding: 0.3rem 0.4rem; border-radius: 7px;
		border: 1px solid var(--border); background: var(--surface-slot); color: var(--fg-dim);
	}
	button.seat-claim { font-family: inherit; }
	.seat-claim.open { color: var(--accent); border-color: var(--accent); cursor: pointer; }
	.seat-claim.mine { color: var(--ok); border-color: var(--ok); cursor: pointer; }
	.seat-claim.mine.subtle { color: var(--fg-dim); border-color: var(--border); font-size: 0.62rem; padding: 0.2rem 0.4rem; }
	.seat-claim.ai { font-style: italic; }
	.name-edit { display: flex; gap: 0.3rem; }
	.name-edit input {
		flex: 1; min-width: 0; background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px;
		color: var(--fg); padding: 0.3rem 0.45rem; font-size: 0.75rem;
	}

	.zone-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); margin-bottom: 0.35rem; display: flex; justify-content: space-between; }
	.battlefield { background: var(--surface-slot); border: 1px solid var(--border); border-radius: 9px; padding: 0.6rem; min-height: 8rem; }
	.battlefield.compact { min-height: auto; margin-bottom: 0.5rem; }
	.card-grid, .hand-strip, .mini-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.mini-list { gap: 0.3rem; }

	.card-chip { position: relative; width: 4.6rem; }
	.card-chip.mini { width: 2.4rem; }
	.hand-strip .card-chip { width: 3.6rem; }
	.card-chip.tapped .chip-main { transform: rotate(90deg); }
	.chip-main {
		display: block; width: 100%; background: var(--surface-raised); border: 1px solid var(--border);
		border-radius: 7px; overflow: hidden; padding: 0; text-align: left; color: inherit;
	}
	.card-chip.command-chip .chip-main { border-color: var(--accent); border-width: 2px; }
	.chip-main :global(img), .text-fallback {
		display: block; width: 100%; aspect-ratio: 5/7; object-fit: cover; background: var(--surface-slot);
	}
	.text-fallback { display: flex; align-items: center; justify-content: center; font-size: 0.55rem; padding: 0.2rem; text-align: center; color: var(--fg-dim); }
	.text-fallback.large { aspect-ratio: 5/7; font-size: 1rem; }
	.cname { font-size: 0.6rem; padding: 0.2rem 0.3rem; line-height: 1.15; color: var(--fg); background: rgba(0,0,0,0.35); position: absolute; bottom: 0; left: 0; right: 0; }
	.mini .cname { display: none; }
	.counter-badge {
		position: absolute; top: 0.15rem; left: 50%; transform: translateX(-50%);
		font-size: 0.58rem; font-weight: 600; line-height: 1; padding: 0.15rem 0.35rem;
		border-radius: 999px; background: var(--accent); color: var(--ink-950); white-space: nowrap;
	}
	.menu-btn {
		position: absolute; top: 0.15rem; right: 0.15rem; width: 1.1rem; height: 1.1rem; border-radius: 4px;
		background: rgba(0,0,0,0.5); color: #fff; border: none; font-size: 0.65rem;
		display: flex; align-items: center; justify-content: center;
	}
	.menu-btn.zoom-btn { left: 0.15rem; right: auto; }
	.empty-hint { font-size: 0.76rem; color: var(--fg-dim); font-style: italic; padding: 0.3rem 0.1rem; }

	.shared-battlefield { padding: 1.1rem 1.3rem; display: flex; flex-direction: column; gap: 0.9rem; }
	.sb-half { min-height: 11rem; display: flex; flex-direction: column; gap: 0.65rem; margin: -0.6rem -0.7rem; padding: 0.6rem 0.7rem; border-radius: 9px; }
	.sb-half.mine { background: color-mix(in srgb, var(--ok) 7%, transparent); }
	.sb-half.theirs { background: color-mix(in srgb, var(--accent) 5%, transparent); }
	.sb-label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); }
	.sb-half.mine .sb-label { color: var(--ok); font-weight: 700; font-size: 0.85rem; }
	.sb-half.theirs .sb-label { color: var(--accent); font-weight: 600; }
	.sb-divider { height: 1px; background: var(--border); margin: 0.2rem 0; }
	.bf-category { display: flex; flex-direction: column; gap: 0.35rem; }
	.bf-cat-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-dim); opacity: 0.75; }
	.bf-card { width: 6rem; }

	.side-zones { display: flex; flex-direction: column; gap: 0.6rem; }
	.mini-zone { background: var(--surface-slot); border: 1px solid var(--border); border-radius: 9px; padding: 0.5rem 0.6rem; flex: 1; }
	.count-row { display: flex; align-items: center; justify-content: space-between; }
	.n { font-family: var(--font-display); }

	.spine { padding: 0.9rem; display: flex; flex-direction: column; }
	.spine h2 { font-size: 0.95rem; margin-bottom: 0.5rem; }
	.log-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 16rem; display: flex; flex-direction: column; gap: 0.45rem; }
	.log-list li { font-size: 0.82rem; line-height: 1.4; padding-left: 0.7rem; border-left: 2px solid var(--border); }
	.log-list .who { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 0.35rem; }
	.who-mine { border-left-color: var(--ok); }
	.who-mine .who { color: var(--ok); }
	.who-theirs { border-left-color: var(--accent); }
	.who-theirs .who { color: var(--accent); }
	.who-system { border-left-color: var(--fg-dim); }
	.who-system .who { color: var(--fg-dim); }

	.zone-menu-backdrop { position: fixed; inset: 0; z-index: 499; }
	.zone-menu {
		position: fixed; z-index: 500; background: var(--surface-raised); border: 1px solid var(--border);
		border-radius: 8px; padding: 0.3rem; display: flex; flex-direction: column; gap: 0.15rem;
		box-shadow: 0 8px 24px rgba(0,0,0,0.35); min-width: 9.5rem;
	}
	.zone-menu-title { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-dim); padding: 0.25rem 0.55rem 0.35rem; border-bottom: 1px solid var(--border); margin-bottom: 0.15rem; }
	.zone-menu button { text-align: left; background: transparent; border: none; color: var(--fg); padding: 0.4rem 0.55rem; font-size: 0.8rem; border-radius: 5px; }
	.zone-menu button:hover { background: var(--surface-slot); }
	.zone-menu-divider { height: 1px; background: var(--border); margin: 0.15rem 0; }

	.card-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 2rem; }
	.card-modal { background: var(--surface-zone); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; max-width: min(90vw, 26rem); max-height: 90vh; display: flex; flex-direction: column; gap: 0.6rem; }
	.card-modal img { width: 100%; border-radius: 8px; display: block; }
	.card-modal-name { font-family: var(--font-display); font-size: 1.1rem; text-align: center; }
	.card-modal-close { align-self: center; }
</style>
