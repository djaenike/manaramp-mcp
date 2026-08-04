// Server-side card representation deliberately excludes image/typeLine — art and type text are
// a pure rendering concern the Svelte client resolves itself from the static card-db.json by
// name, so the Durable Object's persisted state (and every state broadcast) stays small and has
// nothing to do with Scryfall art at all.
export interface Card {
	id: string;
	name: string;
	tapped?: boolean;
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
}

export interface DeckEntry {
	qty: number;
	name: string;
}
