import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchEdhrecAverageDeck, resolveCardInfo, RANDOM_COMMANDERS } from '$lib/server/deck-resolve';

// Pulls a real decklist off the internet (EDHREC's average build for a commander) instead of
// sampling from whatever cards happen to already be known — "grab a random existing deck" done
// for real, not simulated from a small local pool.
export const POST: RequestHandler = async ({ request }) => {
	let commander = '';
	try {
		const body = (await request.json()) as { commander?: string };
		commander = (body.commander ?? '').trim();
	} catch {
		// no body / not JSON — fine, we'll pick a random commander below
	}

	if (!commander) {
		commander = RANDOM_COMMANDERS[Math.floor(Math.random() * RANDOM_COMMANDERS.length)];
	}

	try {
		const { commander: commanderNames, deckEntries } = await fetchEdhrecAverageDeck(commander);
		const names = [...commanderNames, ...deckEntries.map((e) => e.name)];
		const { cardInfo, notFound } = await resolveCardInfo(names);
		return json({ commander: commanderNames, deckEntries, cardInfo, notFound, sourceCommander: commander });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
	}
};
