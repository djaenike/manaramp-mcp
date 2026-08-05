// Server-side card representation deliberately excludes image/typeLine — art and type text are
// a pure rendering concern the Svelte client resolves itself from the static card-db.json by
// name, so the Durable Object's persisted state (and every state broadcast) stays small and has
// nothing to do with Scryfall art at all.
export interface Card {
	id: string;
	name: string;
	tapped?: boolean;
	// Arbitrary counter types ("+1/+1", "loyalty", "poison", whatever) -> count. Absent/zero
	// entries are cleaned up rather than kept at 0, so "has counters" is just "object has keys".
	counters?: Record<string, number>;
}

export type ZoneName = 'command' | 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile';

export interface PlayerState {
	label: string;
	life: number;
	command: Card[];
	library: Card[];
	hand: Card[];
	battlefield: Card[];
	graveyard: Card[];
	exile: Card[];
	mulligans: number;
}

export type PlayerKey = 'you' | 'ai';

export interface LogEntry {
	who: PlayerKey | 'system';
	text: string;
}

export interface GameState {
	revision: number;
	turn: number;
	active: PlayerKey;
	log: LogEntry[];
	players: Record<PlayerKey, PlayerState>;
	// Grows every time any deck is imported into this room — never shrinks, never overwritten with
	// worse data, so the second time a card shows up (even in a totally different deck) it's free.
	cardInfo: Record<string, CardInfoEntry>;
}

export interface DeckEntry {
	qty: number;
	name: string;
}

// Resolved once (server-side, from Scryfall) whenever a deck is imported, then merged into the
// room's shared GameState.cardInfo dictionary — individual Card instances only ever carry a name,
// so this is the one place image/type/cost/text actually live, looked up by name at render time.
export interface CardInfoEntry {
	name: string;
	image: string | null;
	typeLine: string;
	manaCost: string;
	oracleText: string;
}
