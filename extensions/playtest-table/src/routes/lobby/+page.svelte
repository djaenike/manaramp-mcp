<script lang="ts">
	import { goto } from '$app/navigation';

	interface SeatSummary { id: string; label: string; controller: 'human' | 'ai'; claimedBy: string | null }
	interface RoomSummary { roomId: string; label: string; seats: SeatSummary[]; createdAt: number }

	let rooms: RoomSummary[] = $state([]);
	let loading = $state(true);
	let loadError = $state('');

	async function loadRooms() {
		loading = true;
		try {
			const res = await fetch('/api/lobby');
			const data = await res.json();
			if (data.error) throw new Error(data.error);
			rooms = data as RoomSummary[];
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		loadRooms();
	});

	// A 2-human table with exactly one seat still unclaimed is a real open game — someone's there,
	// waiting for an opponent.
	let openGames = $derived(
		rooms.filter(
			(r) =>
				r.seats.length === 2 &&
				r.seats.every((s) => s.controller === 'human') &&
				r.seats.some((s) => s.claimedBy) &&
				r.seats.some((s) => !s.claimedBy)
		)
	);

	type View = 'main' | 'human';
	let view: View = $state('main');
	let playerName = $state('');
	let busy = $state(false);
	// Room creation now routinely takes a few real seconds (Scryfall rate-limit-compliant pacing
	// while resolving the seeded deck's card data) — a disabled button with no other feedback reads
	// as stuck/broken over that span, so this gives the busy period a visible, specific label.
	let busyLabel = $state('');
	let actionError = $state('');

	async function createRoom(label: string, seats: { label: string; controller: 'human' | 'ai' }[]) {
		const res = await fetch('/api/lobby', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ label, seats })
		});
		const data = await res.json();
		if (data.error) throw new Error(data.error);
		return data.roomId as string;
	}

	async function watchAiVsAi() {
		busy = true;
		busyLabel = 'Creating table — resolving both decks against Scryfall…';
		actionError = '';
		try {
			const roomId = await createRoom('AI vs AI', [
				{ label: 'AI 1', controller: 'ai' },
				{ label: 'AI 2', controller: 'ai' }
			]);
			await goto(`/room/${roomId}`);
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
			busy = false;
			busyLabel = '';
		}
	}

	async function playVsAi() {
		busy = true;
		actionError = '';
		const name = playerName.trim();
		if (!name) {
			actionError = 'Enter your name first.';
			busy = false;
			return;
		}
		busyLabel = "Creating table — resolving the AI's deck against Scryfall…";
		try {
			const roomId = await createRoom(`${name} vs AI`, [
				{ label: name, controller: 'human' },
				{ label: 'AI', controller: 'ai' }
			]);
			await goto(`/room/${roomId}?as=${encodeURIComponent(name)}`);
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
			busy = false;
			busyLabel = '';
		}
	}

	async function openHumanView() {
		actionError = '';
		if (!playerName.trim()) {
			actionError = 'Enter your name first.';
			return;
		}
		view = 'human';
		await loadRooms();
	}

	async function joinGame(roomId: string) {
		busy = true;
		busyLabel = 'Joining table…';
		await goto(`/room/${roomId}?as=${encodeURIComponent(playerName.trim())}`);
	}

	async function startNewTable() {
		busy = true;
		busyLabel = 'Creating table…';
		actionError = '';
		const name = playerName.trim();
		try {
			// The second seat has no placeholder persona — it's genuinely unclaimed until someone
			// joins, and the board/lobby both render that as "open," not as a fake name.
			const roomId = await createRoom(`${name}'s table`, [
				{ label: name, controller: 'human' },
				{ label: 'Open seat', controller: 'human' }
			]);
			await goto(`/room/${roomId}?as=${encodeURIComponent(name)}`);
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
			busy = false;
			busyLabel = '';
		}
	}

	function relativeTime(ts: number): string {
		const mins = Math.round((Date.now() - ts) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.round(hrs / 24)}d ago`;
	}
</script>

<svelte:head>
	<title>Playtest Table &mdash; Lobby</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Playtest Table</h1>
		<span class="subtitle">Play a deck against the AI, against another person, or watch two AIs play each other.</span>
	</header>

	{#if view === 'main'}
		<section class="panel">
			<label class="field">
				<span>Your name</span>
				<input type="text" bind:value={playerName} placeholder="Your name" />
			</label>
			<div class="action-grid">
				<button class="action-btn" disabled={busy} onclick={watchAiVsAi}>
					<span class="action-title">AI vs AI</span>
					<span class="action-desc">Spectate &mdash; Claude plays both sides, board is read-only</span>
				</button>
				<button class="action-btn" disabled={busy} onclick={playVsAi}>
					<span class="action-title">Me vs AI</span>
					<span class="action-desc">You control one side, Claude controls the other</span>
				</button>
				<button class="action-btn" disabled={busy} onclick={openHumanView}>
					<span class="action-title">Playtest another human</span>
					<span class="action-desc">See who's waiting, or start your own table</span>
					<span class="action-badge" class:pulse={openGames.length > 0}>{openGames.length} open</span>
				</button>
			</div>
			{#if busy && busyLabel}<div class="empty-hint">{busyLabel}</div>{/if}
			{#if actionError}<div class="error-line">{actionError}</div>{/if}
		</section>
	{:else}
		<section class="panel">
			<div class="panel-head">
				<button class="back-link" onclick={() => (view = 'main')}>&larr; Back</button>
				<h2>Active games</h2>
				<button class="btn small" onclick={loadRooms} disabled={loading}>Refresh</button>
			</div>
			{#if loadError}
				<div class="error-line">{loadError}</div>
			{:else if loading}
				<div class="empty-hint">Loading&hellip;</div>
			{:else if !openGames.length}
				<div class="empty-hint">No one's waiting right now &mdash; start a table and wait for someone to join.</div>
			{:else}
				<ul class="room-list">
					{#each openGames as room (room.roomId)}
						<li>
							<div class="room-card">
								<span class="room-label">{room.label}</span>
								<span class="room-seats">{room.seats.find((s) => s.claimedBy)?.label} is waiting</span>
								<span class="room-age">{relativeTime(room.createdAt)}</span>
								<button class="btn primary small" disabled={busy} onclick={() => joinGame(room.roomId)}>Join</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
			{#if busy && busyLabel}<div class="empty-hint">{busyLabel}</div>{/if}
			{#if actionError}<div class="error-line">{actionError}</div>{/if}
			<button class="btn" disabled={busy} onclick={startNewTable}>Start a new table &mdash; wait for someone to join</button>
		</section>
	{/if}
</div>

<style>
	:root {
		--ink-950: #0b120f; --ink-900: #101712;
		--felt-800: #16241d; --felt-700: #1e2f26; --felt-600: #28392f;
		--brass-500: #c8a24a; --brass-300: #e4c877; --brass-700: #8f7332;
		--paper-50: #eef1ec;
		--line: rgba(255, 255, 255, 0.09);
		--text-hi: #f2efe4; --text-lo: rgba(242, 239, 228, 0.62);
		--danger: #c1443b; --ok: #6f9a6a;
		--surface: var(--ink-950); --surface-zone: var(--felt-800); --surface-slot: var(--felt-700);
		--border: var(--line); --fg: var(--text-hi); --fg-dim: var(--text-lo);
		--accent: var(--brass-500);
		--font-display: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
		--font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	}
	@media (prefers-color-scheme: light) {
		:root {
			--surface: var(--paper-50); --surface-zone: #e6e9e1; --surface-slot: #dadecf;
			--border: rgba(16, 23, 18, 0.12); --fg: var(--ink-900); --fg-dim: rgba(16, 23, 18, 0.6);
			--accent: var(--brass-700);
		}
	}
	:global(*, *::before, *::after) { box-sizing: border-box; }
	:global(html), :global(body) { margin: 0; background: var(--surface); color: var(--fg); font-family: var(--font-body); }
	:global(body) {
		min-height: 100vh; width: 100%; padding: clamp(0.75rem, 2vw, 1.5rem);
		display: flex; flex-direction: column; align-items: center;
	}
	h1, h2 { font-family: var(--font-display); font-weight: 600; margin: 0; }
	button { font-family: inherit; cursor: pointer; }

	.page { width: 100%; max-width: 42rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; }
	.page-head { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.5rem 0.2rem 0; }
	.page-head h1 { font-size: 1.6rem; }
	.subtitle { font-size: 0.85rem; color: var(--fg-dim); }

	.panel { background: var(--surface-zone); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.75rem; }
	.panel-head { display: flex; align-items: center; gap: 0.6rem; }
	.panel-head h2 { flex: 1; }

	.btn { background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg); padding: 0.45rem 0.75rem; font-size: 0.82rem; }
	.btn:hover { border-color: var(--accent); }
	.btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.btn.small { padding: 0.3rem 0.55rem; font-size: 0.75rem; }
	.btn.primary { background: var(--accent); color: var(--ink-950); border-color: var(--accent); font-weight: 600; }

	.back-link {
		background: none; border: none; color: var(--fg-dim); font-size: 0.85rem; font-weight: 600;
		padding: 0.3rem 0.4rem; margin-left: -0.4rem; border-radius: 6px; transition: color 0.15s;
	}
	.back-link:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }

	.field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; color: var(--fg-dim); min-width: 0; }
	.field input {
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 7px; color: var(--fg);
		padding: 0.55rem 0.7rem; font-size: 0.92rem; width: 100%;
	}

	.action-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.65rem; }
	.action-btn {
		position: relative; text-align: left; background: var(--surface-slot); border: 1px solid var(--border);
		border-radius: 10px; padding: 0.75rem 0.85rem; color: var(--fg); display: flex; flex-direction: column;
		gap: 0.25rem; min-width: 0;
	}
	.action-btn:hover { border-color: var(--accent); }
	.action-btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.action-title { font-weight: 600; font-size: 0.95rem; }
	.action-desc { font-size: 0.76rem; color: var(--fg-dim); line-height: 1.35; }
	.action-badge {
		align-self: flex-start; margin-top: 0.15rem; font-size: 0.68rem; font-weight: 600;
		padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-dim);
	}
	.action-badge.pulse { color: var(--ok); border-color: var(--ok); }

	.empty-hint, .error-line { font-size: 0.85rem; color: var(--fg-dim); font-style: italic; }
	.error-line { color: var(--danger); font-style: normal; }

	.room-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
	.room-card {
		display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; min-width: 0;
		background: var(--surface-slot); border: 1px solid var(--border); border-radius: 9px;
		padding: 0.6rem 0.8rem;
	}
	.room-label { font-weight: 600; }
	.room-seats { font-size: 0.82rem; color: var(--fg-dim); }
	.room-age { font-size: 0.75rem; color: var(--fg-dim); margin-left: auto; }
</style>
