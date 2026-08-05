import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveCardInfo } from '$lib/server/deck-resolve';
import type { DeckEntry } from '$lib/server/types';

// Takes a parsed decklist (commander names + {qty, name} entries — same shape whether it came from
// a pasted Moxfield export or the random-deck route) and cross-references every card against
// Scryfall. This is the "any deck, not just the two I hand-resolved" piece — every import goes
// through here now, not through a static file someone had to build ahead of time.
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { commanderNames?: string[]; deckEntries?: DeckEntry[] };
	const commanderNames = body.commanderNames ?? [];
	const deckEntries = body.deckEntries ?? [];

	const names = [...commanderNames, ...deckEntries.map((e) => e.name)];
	if (!names.length) {
		return json({ error: 'no card names provided' }, { status: 400 });
	}

	try {
		const { cardInfo, notFound } = await resolveCardInfo(names);
		return json({ cardInfo, notFound });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
	}
};
