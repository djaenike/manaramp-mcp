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
	'Golos, Tireless Pilgrim',
	'Feather, the Redeemed'
];

export interface ResolveResult {
	cardInfo: Record<string, CardInfoEntry>;
	notFound: string[];
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
		const res = await fetch(`${SCRYFALL_BASE}/cards/collection`, {
			method: 'POST',
			headers: { ...HEADERS, 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) })
		});
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
				oracleText: card.oracle_text ?? (card.card_faces?.map((f: any) => f.oracle_text).join(' // ') ?? '')
			};
		}
		for (const nf of data.not_found ?? []) {
			if (nf?.name) notFound.push(nf.name);
		}
		// Scryfall asks for a light delay between requests from the same client.
		if (i + 75 < unique.length) await new Promise((r) => setTimeout(r, 80));
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
	const res = await fetch(`${EDHREC_BASE}/average-decks/${slug}.json`, { headers: HEADERS });
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
