<script lang="ts">
	// This board is a shared visual aid, not a two-blind-players simulator — every connected
	// socket (you clicking your own moves, Claude's script pushing the AI's) gets the same full
	// state broadcast from the GameRoom Durable Object and renders it the same way. Nothing here
	// holds its own authoritative copy of game state; `game` below is just "what the server told
	// us most recently."
	type ZoneName = 'command' | 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile';
	type PlayerKey = 'you' | 'ai';
	interface Card { id: string; name: string; tapped?: boolean; counters?: Record<string, number> }
	interface PlayerState {
		label: string; life: number;
		command: Card[]; library: Card[]; hand: Card[]; battlefield: Card[]; graveyard: Card[]; exile: Card[];
		mulligans: number;
	}
	interface CardInfoEntry { name: string; image: string | null; typeLine: string; manaCost?: string; oracleText?: string }
	interface ResolveDeckResponse { cardInfo: Record<string, CardInfoEntry>; notFound: string[]; error?: string }
	interface RandomDeckResponse extends ResolveDeckResponse {
		commander: string[]; deckEntries: { qty: number; name: string }[]; sourceCommander: string;
	}
	interface GameState {
		revision: number; turn: number; active: PlayerKey;
		log: { who: PlayerKey | 'system'; text: string }[];
		players: Record<PlayerKey, PlayerState>;
		cardInfo: Record<string, CardInfoEntry>;
	}

	const ROOM_ID = 'default';
	const ZONE_LABELS: Record<ZoneName, string> = {
		battlefield: 'Battlefield', hand: 'Hand', command: 'Command zone',
		graveyard: 'Graveyard', exile: 'Exile', library: 'Library (top)'
	};

	let game: GameState | null = $state(null);
	let connStatus = $state('connecting');
	let statusMsg = $state('');
	let ws: WebSocket | null = null;

	let importOpen = $state(false);
	let importPlayer: PlayerKey = $state('you');
	let importText = $state('');
	let importBusy = $state(false);
	let randomCommanderInput = $state('');

	let cardInput = $state('');
	let addPlayer: PlayerKey = $state('you');
	let addZone: ZoneName = $state('battlefield');

	let zoomCard: CardInfoEntry | null = $state(null);
	let zoneMenu: { player: PlayerKey; zone: ZoneName; cardId: string; name: string; x: number; y: number } | null = $state(null);

	let resetArmed = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	// Card art/type/cost/text all live in the room's own shared state now (resolved once at
	// import time via /api/resolve-deck or /api/random-deck), not a static file this page fetches —
	// so lookups here just read whatever the server has already told us.
	function lookupCard(name: string): CardInfoEntry | null {
		return game?.cardInfo[name.trim().toLowerCase()] ?? null;
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
		ws = new WebSocket(`${proto}://${location.host}/api/room/${ROOM_ID}`);
		connStatus = 'connecting';
		ws.addEventListener('open', () => { connStatus = 'connected'; });
		ws.addEventListener('close', () => { connStatus = 'disconnected'; });
		ws.addEventListener('error', () => { connStatus = 'error'; });
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === 'state') game = msg.state;
			else if (msg.type === 'error') statusMsg = msg.error;
		});
	}

	$effect(() => {
		connect();
		return () => ws?.close();
	});

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
		statusMsg = `Resolving "${name}"...`;
		try {
			const res = await fetch('/api/resolve-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deckEntries: [{ qty: 1, name }] })
			});
			const data = (await res.json()) as ResolveDeckResponse;
			if (data.error) throw new Error(data.error);
			send({ type: 'addCard', player: addPlayer, zone: addZone, name, cardInfo: data.cardInfo });
			statusMsg = data.notFound?.length ? `"${name}" not found on Scryfall — added as text only.` : '';
			cardInput = '';
		} catch (e) {
			statusMsg = e instanceof Error ? e.message : String(e);
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
			statusMsg = 'No cards found in pasted text.';
			return;
		}
		importBusy = true;
		statusMsg = `Resolving ${commanderNames.length + deckEntries.length} card(s) against Scryfall...`;
		try {
			const res = await fetch('/api/resolve-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ commanderNames, deckEntries })
			});
			const data = (await res.json()) as ResolveDeckResponse;
			if (data.error) throw new Error(data.error);
			send({
				type: 'loadDeck', player: importPlayer, commanderNames, deckEntries,
				sourceLabel: 'Imported deck', cardInfo: data.cardInfo
			});
			statusMsg = data.notFound?.length
				? `Loaded — ${data.notFound.length} card(s) not found on Scryfall: ${data.notFound.join(', ')}`
				: 'Deck resolved and loaded.';
			importText = '';
		} catch (e) {
			statusMsg = e instanceof Error ? e.message : String(e);
		} finally {
			importBusy = false;
		}
	}

	async function randomDeck() {
		importBusy = true;
		const requested = randomCommanderInput.trim();
		statusMsg = requested ? `Pulling EDHREC's average build for "${requested}"...` : 'Picking a random commander and pulling its EDHREC average build...';
		try {
			const res = await fetch('/api/random-deck', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requested ? { commander: requested } : {})
			});
			const data = (await res.json()) as RandomDeckResponse;
			if (data.error) throw new Error(data.error);
			send({
				type: 'loadDeck', player: importPlayer,
				commanderNames: data.commander, deckEntries: data.deckEntries,
				sourceLabel: `Random deck: EDHREC average build for "${data.sourceCommander}"`,
				cardInfo: data.cardInfo
			});
			statusMsg = data.notFound?.length
				? `Loaded "${data.sourceCommander}" — ${data.notFound.length} card(s) not found: ${data.notFound.join(', ')}`
				: `Loaded "${data.sourceCommander}".`;
			randomCommanderInput = '';
		} catch (e) {
			statusMsg = e instanceof Error ? e.message : String(e);
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

<div class="toolbar">
	<div class="title-block">
		<h1>Playtest Table</h1>
		<span class="subtitle">live &middot; {connStatus}{game ? ` · turn ${game.turn} · rev ${game.revision}` : ''}</span>
	</div>
	<form class="search-form" onsubmit={submitAddCard}>
		<input type="text" bind:value={cardInput} placeholder="Card name (e.g. Sol Ring)" />
		<select bind:value={addPlayer}>
			<option value="you">You</option>
			<option value="ai">AI</option>
		</select>
		<select bind:value={addZone}>
			<option value="battlefield">Battlefield</option>
			<option value="hand">Hand</option>
			<option value="command">Command zone</option>
			<option value="graveyard">Graveyard</option>
			<option value="exile">Exile</option>
		</select>
		<button type="submit" class="btn primary">Add card</button>
	</form>
	<button type="button" class="btn" onclick={() => (importOpen = !importOpen)}>Import decklist</button>
</div>

{#if statusMsg}
	<div class="status-line">{statusMsg}</div>
{/if}

{#if importOpen}
	<div class="import-panel">
		<div class="import-row">
			<label for="import-player-select">Load deck for</label>
			<select id="import-player-select" bind:value={importPlayer}>
				<option value="you">You</option>
				<option value="ai">AI</option>
			</select>
			<span class="import-hint">
				Paste a Moxfield-style export &mdash; optional "Commander" / "Deck" / "Sideboard" headers, one
				"&lt;qty&gt; &lt;name&gt;" per line. Loading replaces that player's command zone, library, hand,
				battlefield, graveyard, and exile.
			</span>
		</div>
		<textarea rows="8" bind:value={importText} placeholder={'Commander\n1 Zada, Hedron Grinder\n\nDeck\n1 Sol Ring\n30 Mountain'}></textarea>
		<div class="import-row">
			<button type="button" class="btn primary" disabled={importBusy} onclick={submitImport}>Parse &amp; load deck</button>
		</div>
		<div class="import-row divider">
			<input type="text" bind:value={randomCommanderInput} placeholder="Commander name (blank = random)" />
			<button type="button" class="btn" disabled={importBusy} onclick={randomDeck}>Random deck from EDHREC</button>
			<span class="import-hint">Pulls a real decklist off the internet &mdash; EDHREC's average build for the named commander, or a random one from a small curated pool if left blank.</span>
		</div>
	</div>
{/if}

{#if game}
	<div class="turn-bar">
		<div class="turn-info">
			<span>Turn</span>
			<span class="turn-num">{game.turn}</span>
			<span class="active-chip {game.active}">{game.active === 'you' ? 'You are active' : 'AI is active'}</span>
		</div>
		<div class="end-turn-row">
			<button class="btn {resetArmed ? 'danger-txt' : ''}" onclick={clickReset}>
				{resetArmed ? 'Click again to confirm reset' : 'Reset table'}
			</button>
			<button class="btn primary" onclick={() => send({ type: 'passTurn' })}>Pass turn &rarr;</button>
		</div>
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

		{#snippet playerRow(key: PlayerKey)}
			{@const p = game!.players[key]}
			<section class="player-row {key}">
				<div class="stat-col">
					<div class="life-block">
						<div class="name">{p.label}</div>
						<div class="life-value {p.life <= 10 ? 'low' : ''}">{p.life}</div>
						<div class="stepper">
							<button onclick={() => send({ type: 'adjustLife', player: key, delta: -1 })} aria-label="Decrease life">&minus;</button>
							<button onclick={() => send({ type: 'adjustLife', player: key, delta: 1 })} aria-label="Increase life">+</button>
						</div>
					</div>
					<div class="lib-block">
						Library<br /><span class="lib-value">{p.library.length}</span>
						<div class="stepper">
							<button class="btn small" onclick={() => send({ type: 'draw', player: key })}>Draw</button>
							<button class="btn small" onclick={() => send({ type: 'shuffleLibrary', player: key })}>Shuffle</button>
						</div>
					</div>
					<div class="hand-setup">
						<button class="btn small" onclick={() => send({ type: 'openingHand', player: key })}>Opening 7</button>
						<button class="btn small" onclick={() => send({ type: 'mulligan', player: key })}>Mulligan ({p.mulligans})</button>
					</div>
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
										<button class="chip-main" onclick={() => send({ type: 'moveCard', player: key, cardId: c.id, fromZone: 'command', toZone: 'battlefield' })} title="{c.name} — click to cast to battlefield">
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
									<button class="chip-main" onclick={(e) => openZoneMenu(key, 'hand', c, e.currentTarget)} title={c.name}>
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
										<button class="chip-main" onclick={(e) => openZoneMenu(key, 'graveyard', c, e.currentTarget)} title={c.name}>
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
										<button class="chip-main" onclick={(e) => openZoneMenu(key, 'exile', c, e.currentTarget)} title={c.name}>
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

		{@render playerRow('ai')}

		{#snippet battlefieldCardChip(key: PlayerKey, c: Card)}
			<div class="card-chip bf-card {c.tapped ? 'tapped' : ''}">
				<button class="chip-main" onclick={() => send({ type: 'toggleTap', player: key, cardId: c.id })} title={c.name}>
					{@render cardImg(c.name)}
					<span class="cname">{c.name}</span>
					{#if c.counters && Object.keys(c.counters).length}
						<span class="counter-badge">{Object.entries(c.counters).map(([t, n]) => `${n} ${t}`).join(', ')}</span>
					{/if}
				</button>
				<button class="menu-btn zoom-btn" onclick={(e) => { e.stopPropagation(); openZoom(c.name); }} title="View larger">&#128269;</button>
				<button class="menu-btn" onclick={(e) => { e.stopPropagation(); openZoneMenu(key, 'battlefield', c, e.currentTarget); }} title="Move to another zone">&#8942;</button>
			</div>
		{/snippet}

		<div class="shared-battlefield">
			{#each (['ai', 'you'] as PlayerKey[]) as key}
				{@const p = game.players[key]}
				{@const groups = groupByCategory(p.battlefield)}
				<div class="sb-half">
					<div class="sb-label">{key === 'ai' ? 'AI' : 'Your'} battlefield &middot; {p.battlefield.length} permanent(s)</div>
					{#if !p.battlefield.length}
						<div class="empty-hint">No permanents in play</div>
					{:else}
						{#each CATEGORY_ORDER as cat}
							{#if groups[cat]?.length}
								<div class="bf-category">
									<div class="bf-cat-label">{cat} ({groups[cat].length})</div>
									<div class="card-grid">
										{#each groups[cat] as c (c.id)}
											{@render battlefieldCardChip(key, c)}
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					{/if}
				</div>
				{#if key === 'ai'}<div class="sb-divider"></div>{/if}
			{/each}
		</div>

		{@render playerRow('you')}
	</div>

	<aside class="spine">
		<h2>Game log</h2>
		<ul class="log-list">
			{#each game.log as entry, i (i)}
				<li class="who-{entry.who}"><span class="who">{entry.who}</span>{entry.text}</li>
			{/each}
		</ul>
	</aside>
{/if}

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
	:global(html), :global(body) {
		margin: 0; background: var(--surface); color: var(--fg); font-family: var(--font-body);
	}
	:global(body) {
		min-height: 100vh; padding: clamp(0.75rem, 2vw, 1.5rem);
		display: flex; flex-direction: column; gap: 0.9rem;
	}
	h1, h2 { font-family: var(--font-display); font-weight: 600; margin: 0; }
	button { font-family: inherit; cursor: pointer; }

	.toolbar, .import-panel, .turn-bar, .player-row, .shared-battlefield, .spine {
		background: var(--surface-zone); border: 1px solid var(--border); border-radius: 12px;
	}
	.toolbar { padding: 0.85rem 1.1rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; }
	.title-block { display: flex; align-items: baseline; gap: 0.6rem; margin-right: auto; }
	.title-block h1 { font-size: 1.35rem; }
	.subtitle { font-size: 0.78rem; color: var(--fg-dim); }
	.status-line { font-size: 0.82rem; color: var(--danger); padding: 0 0.2rem; }

	.search-form { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
	.search-form input[type='text'], .import-row input[type='text'] {
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg);
		padding: 0.45rem 0.65rem; font-size: 0.88rem; width: 15rem; max-width: 40vw;
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

	.import-panel { padding: 0.85rem 1.1rem; display: flex; flex-direction: column; gap: 0.6rem; }
	.import-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
	.import-row.divider { border-top: 1px solid var(--border); padding-top: 0.6rem; }
	.import-hint { font-size: 0.76rem; color: var(--fg-dim); }
	.import-panel textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.8rem; resize: vertical; }

	.turn-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 1rem; }
	.turn-info { display: flex; align-items: center; gap: 0.7rem; font-size: 0.85rem; }
	.turn-num { font-family: var(--font-display); font-size: 1.05rem; }
	.active-chip { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.2rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); }
	.active-chip.you { color: var(--ok); border-color: var(--ok); }
	.active-chip.ai { color: var(--accent); border-color: var(--accent); }
	.end-turn-row { display: flex; gap: 0.5rem; }

	.board { display: flex; flex-direction: column; gap: 0.9rem; }
	.player-row { padding: 0.9rem; display: grid; grid-template-columns: 9.5rem 1fr 12rem; gap: 0.9rem; }
	.player-row.ai { border-top: 2px solid var(--accent); }
	.player-row.you { border-bottom: 2px solid var(--ok); }

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
	.sb-half { min-height: 11rem; display: flex; flex-direction: column; gap: 0.65rem; }
	.sb-label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); }
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
	.who-you { border-left-color: var(--ok); }
	.who-you .who { color: var(--ok); }
	.who-ai { border-left-color: var(--accent); }
	.who-ai .who { color: var(--accent); }
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
