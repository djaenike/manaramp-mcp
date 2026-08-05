// Server-side card representation deliberately excludes image/typeLine — those live in
// GameState.cardInfo (see CardInfoEntry below), keyed by name, so individual Card instances in a
// zone stay lightweight and the same card's art/text isn't duplicated everywhere it appears.
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

// An opaque seat identifier — no longer a closed 2-value union. The set of valid keys for a given
// room is whatever GameState.seats contains; GameRoom.player() is the runtime guard, not the type.
export type PlayerKey = string;

// Static-ish per-seat metadata, plus one bit of live state (claimedBy) that changes as browsers
// claim/release it. Order in GameState.seats IS turn order IS render order — no separate ordering
// field needed.
export interface SeatDef {
	id: string;
	label: string;
	controller: 'human' | 'ai';
	claimedBy: string | null;
}

export interface LogEntry {
	who: PlayerKey | 'system';
	text: string;
}

export interface GameState {
	revision: number;
	turn: number;
	active: PlayerKey;
	log: LogEntry[];
	seats: SeatDef[];
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
