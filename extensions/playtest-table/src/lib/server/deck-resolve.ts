import type { CardInfoEntry, DeckEntry } from './types';

// Runs on the Worker, not in the browser — deliberately. Scryfall/EDHREC may or may not set
// permissive CORS headers for direct browser calls, and there's no way to test that from inside
// claude.ai's Artifact sandbox where this project started. Server-to-server fetch (Worker to
// Scryfall) isn't subject to CORS at all — only browsers enforce it — so resolving here sidesteps
// the question entirely instead of hoping the answer is "yes, they allow it."
const SCRYFALL_BASE = 'https://api.scryfall.com';
const EDHREC_BASE = 'https://json.edhrec.com/pages';
const HEADERS = { 'User-Agent': 'scryfall-mcp-playtest/1.0', Accept: 'application/json' };

// Same conversion index.js uses for EDHREC's URL slugs, e.g. "Atraxa, Grand Unifier" -> "atraxa-grand-unifier".
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/['’,]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// A small curated pool for "random deck" — EDHREC has no real "random commander" endpoint, and an
// arbitrary/obscure commander risks a thin or missing EDHREC page. These are all popular enough to
// reliably have a well-populated average-decklist page.
export const RANDOM_COMMANDERS = [
	'Atraxa, Grand Unifier',
	'Muldrotha, the Gravetide',
	'Meren of Clan Nel Toth',
	'Yuriko, the Tiger\'s Shadow',
	'Edgar Markov',
	'Prosper, Tome-Bound',
	'Korvold, Fae-Cursed King',
	'The Ur-Dragon',
	'Ezuri, Claw of Progress',
	'Krenko, Mob Boss',
	'Yarok, the Desecrated',
	'Kenrith, the Returned King',
	'Niv-Mizzet, Parun',
	'Feather, the Redeemed'
];

export interface ResolveResult {
	cardInfo: Record<string, CardInfoEntry>;
	notFound: string[];
}

// Scryfall's documented hard limit for /cards/collection is 2/second (500ms apart) — a small
// safety margin (520ms) is added on top. This module-level timestamp persists for as long as this
// Worker instance/isolate stays warm, so it paces resolveCardInfo's own chunk-to-chunk requests
// AND, best-effort, requests from other nearby calls sharing the same warm isolate.
const SCRYFALL_COLLECTION_MIN_INTERVAL_MS = 520;
let lastScryfallCollectionRequestAt = 0;

// A refused-connection-style problem for this file: Scryfall rate-limits by client IP, and
// Cloudflare Workers egress through a shared IP pool (not a dedicated per-project IP) — meaning
// this Worker can get 429'd by Scryfall's rate limiter even at modest request volume, in a way
// that never showed up testing locally (where outbound requests went through the dev machine's
// own IP instead). Retries a 429 a few times with backoff (respecting Retry-After if Scryfall
// sends one) before giving up, rather than failing the whole deck load on the first rate limit hit.
// `paceAsScryfallCollection` additionally enforces PROACTIVE pacing before the request even goes
// out (not just reactive backoff after a 429) — only meaningful for actual Scryfall calls, so the
// EDHREC call site below (which has no such documented limit) leaves it off.
async function fetchWithRetry(
	url: string, options: RequestInit, maxRetries = 3, paceAsScryfallCollection = false
): Promise<Response> {
	if (paceAsScryfallCollection) {
		const waitMs = lastScryfallCollectionRequestAt + SCRYFALL_COLLECTION_MIN_INTERVAL_MS - Date.now();
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
		lastScryfallCollectionRequestAt = Date.now();
	}
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, options);
		if (res.status !== 429 || attempt >= maxRetries) return res;
		const retryAfterHeader = res.headers.get('Retry-After');
		const waitMs = retryAfterHeader
			? Math.min((Number(retryAfterHeader) || 1) * 1000, 30000)
			: 400 * Math.pow(2, attempt);
		await new Promise((r) => setTimeout(r, waitMs));
		if (paceAsScryfallCollection) lastScryfallCollectionRequestAt = Date.now();
	}
}

function cardImage(card: any): string | null {
	if (card.image_uris?.normal) return card.image_uris.normal;
	if (card.card_faces?.[0]?.image_uris?.normal) return card.card_faces[0].image_uris.normal;
	return null;
}

// Resolves a flat list of card names against Scryfall's batch endpoint (max 75 identifiers per
// call), chunking as needed. This is the one place actual card data (image/type/cost/text) enters
// the system — everything downstream (GameState.cardInfo, the client's renderer, Claude's own
// state reads) just reads what this produces.
export async function resolveCardInfo(names: string[]): Promise<ResolveResult> {
	const unique = Array.from(new Set(names.filter(Boolean)));
	const cardInfo: Record<string, CardInfoEntry> = {};
	const notFound: string[] = [];

	for (let i = 0; i < unique.length; i += 75) {
		const chunk = unique.slice(i, i + 75);
		const res = await fetchWithRetry(`${SCRYFALL_BASE}/cards/collection`, {
			method: 'POST',
			headers: { ...HEADERS, 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) })
		}, 3, true);
		if (!res.ok) {
			throw new Error(`Scryfall collection request failed: ${res.status} ${res.statusText}`);
		}
		const data: any = await res.json();
		for (const card of data.data ?? []) {
			cardInfo[card.name.toLowerCase()] = {
				name: card.name,
				image: cardImage(card),
				typeLine: card.type_line ?? '',
				manaCost: card.mana_cost ?? '',
				oracleText: card.oracle_text ?? (card.card_faces?.map((f: any) => f.oracle_text).join(' // ') ?? ''),
				power: card.power ?? card.card_faces?.[0]?.power ?? null,
				toughness: card.toughness ?? card.card_faces?.[0]?.toughness ?? null
			};
		}
		for (const nf of data.not_found ?? []) {
			if (nf?.name) notFound.push(nf.name);
		}
	}

	return { cardInfo, notFound };
}

export interface EdhrecDeck {
	commander: string[];
	deckEntries: DeckEntry[];
}

// Same endpoint/shape index.js's edhrec_get_average_decklist tool uses, just called from the
// Worker instead of the local MCP server.
export async function fetchEdhrecAverageDeck(commanderName: string): Promise<EdhrecDeck> {
	const slug = slugify(commanderName);
	const res = await fetchWithRetry(`${EDHREC_BASE}/average-decks/${slug}.json`, { headers: HEADERS });
	if (res.status === 404) {
		throw new Error(`No EDHREC page found for commander "${commanderName}". Check spelling.`);
	}
	if (!res.ok) {
		throw new Error(`EDHREC request failed: ${res.status} ${res.statusText}`);
	}
	const data: any = await res.json();
	const deck = data?.deck;
	if (!deck) throw new Error(`No average decklist found for "${commanderName}".`);

	const commander: string[] = deck.commander ?? [commanderName];
	const deckEntries: DeckEntry[] = [];
	for (const list of Object.values(deck.cards ?? {}) as any[]) {
		for (const [name, qty] of list) {
			deckEntries.push({ name, qty: Number(qty) || 1 });
		}
	}
	return { commander, deckEntries };
}
