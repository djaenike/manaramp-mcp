import type { Card, GameState, PlayerKey } from './types';

// Called directly from GameRoom's Durable Object alarm handler — this is what makes an AI seat's
// turn happen with zero dependency on any Claude Code/Desktop session being open anywhere. Every
// call is billed to whoever owns ANTHROPIC_API_KEY, so this file is written for cheap-by-default
// (see DEFAULT_MODEL) and for reusing the exact action vocabulary GameRoom.applyAction() already
// accepts, rather than inventing a second language a human-driven session and an AI-driven one
// could drift out of sync on.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1536;

// Deliberately excludes openingHand/mulligan/claimSeat/loadDeck/resetTable — those are pregame or
// meta-table actions that would be destructive or nonsensical for an automated mid-game turn to
// invoke (e.g. mulligan would reshuffle an established hand back into the library mid-game).
const ACTION_TYPES = [
	'moveCard', 'toggleTap', 'draw', 'shuffleLibrary',
	'adjustLife', 'passTurn', 'addCard', 'removeCard', 'adjustCounter'
];

const SUBMIT_TURN_TOOL = {
	name: 'submit_turn',
	description:
		"Submit this seat's entire turn as an ordered list of actions, executed in order against the " +
		'live board state. Use addCard (zone: "battlefield") to play a land/permanent from your hand ' +
		'or create a token; moveCard to change a card\'s zone (e.g. hand -> battlefield, or -> graveyard ' +
		'when it dies); toggleTap to tap/untap something for mana or an ability; adjustLife/adjustCounter ' +
		'for damage, life swings, and +1/+1 or loyalty counters; draw for any extra card draw beyond the ' +
		'automatic turn draw you already received. End the list with a passTurn action once your turn is ' +
		'complete so play moves to the next seat.',
	input_schema: {
		type: 'object',
		properties: {
			actions: {
				type: 'array',
				description: 'Ordered list of actions making up this whole turn, ending in a passTurn action.',
				items: {
					type: 'object',
					properties: {
						type: { type: 'string', enum: ACTION_TYPES },
						cardName: {
							type: 'string',
							description: 'Exact existing card name — required by moveCard/toggleTap/removeCard/adjustCounter.'
						},
						fromZone: { type: 'string', description: 'moveCard only: the zone the card is currently in.' },
						toZone: { type: 'string', description: 'moveCard only: the zone to move it to.' },
						zone: {
							type: 'string',
							description: 'addCard/removeCard/adjustCounter only: which zone (command/library/hand/battlefield/graveyard/exile).'
						},
						name: { type: 'string', description: 'addCard only: exact card/token name to create.' },
						delta: { type: 'number', description: 'adjustLife/adjustCounter only: signed integer change.' },
						counterType: {
							type: 'string',
							description: 'adjustCounter only: counter type, e.g. "+1/+1", "loyalty", "poison".'
						}
					},
					required: ['type']
				}
			}
		},
		required: ['actions']
	}
};

const SYSTEM_PROMPT =
	'You are playing one seat in a simplified, informal Commander (EDH) Magic: The Gathering ' +
	'playtest simulator. This is not a rules-enforced engine: there is no stack, no priority ' +
	'passing, no mana pool tracking, and combat damage isn\'t auto-resolved — represent the outcome ' +
	'of any spell, attack, or ability yourself via the actions available (moveCard/adjustLife/' +
	'adjustCounter/addCard/removeCard). Use good judgement to play a sensible, reasonably strong ' +
	'turn given your hand, board, and mana available (lands + other mana sources on your ' +
	'battlefield, tapped for cost). Only ever act on your own seat — never move or modify another ' +
	'seat\'s cards or life total. Always respond by calling the submit_turn tool exactly once. If ' +
	'there is nothing productive to do, a single passTurn action is a completely valid turn.';

function describeCard(cardInfo: GameState['cardInfo'], card: Card, detailed: boolean): string {
	const info = cardInfo[card.name.toLowerCase()];
	const tapped = card.tapped ? ' [tapped]' : '';
	const counters = card.counters && Object.keys(card.counters).length
		? ' {' + Object.entries(card.counters).map(([k, v]) => `${k}:${v}`).join(', ') + '}'
		: '';
	if (!detailed) return `${card.name}${tapped}${counters}`;
	const cost = info?.manaCost ? ` ${info.manaCost}` : '';
	const type = info?.typeLine ? ` — ${info.typeLine}` : '';
	const text = info?.oracleText ? ` :: ${info.oracleText.replace(/\n/g, ' ')}` : '';
	return `${card.name}${cost}${type}${tapped}${counters}${text}`;
}

// Everyone's battlefield/graveyard/exile is genuinely public information in Magic, so those are
// described in full for every seat. Hand contents are real hidden information — only the acting
// seat's own hand gets card-level detail; every other seat's hand is reported as a count only.
export function summarizeGameState(game: GameState, seatId: PlayerKey): string {
	const lines: string[] = [];
	lines.push(`Turn ${game.turn}. It is your turn to act — your seat id is "${seatId}".`);
	lines.push('');
	for (const seat of game.seats) {
		const p = game.players[seat.id];
		if (!p) continue;
		const mine = seat.id === seatId;
		lines.push(`Seat "${seat.id}" (${seat.label}${mine ? ', YOU' : ''}) — life ${p.life}:`);
		lines.push(`  Command zone: ${p.command.map((c) => c.name).join(', ') || '(empty)'}`);
		lines.push(
			`  Battlefield: ${p.battlefield.length ? p.battlefield.map((c) => describeCard(game.cardInfo, c, mine)).join('; ') : '(empty)'}`
		);
		lines.push(`  Graveyard: ${p.graveyard.map((c) => c.name).join(', ') || '(empty)'}`);
		lines.push(`  Exile: ${p.exile.map((c) => c.name).join(', ') || '(empty)'}`);
		if (mine) {
			lines.push(
				`  Your hand (${p.hand.length}): ${p.hand.length ? p.hand.map((c) => describeCard(game.cardInfo, c, true)).join('; ') : '(empty)'}`
			);
		} else {
			lines.push(`  Hand: ${p.hand.length} card(s), hidden.`);
		}
		lines.push(`  Library: ${p.library.length} card(s) left.`);
		lines.push('');
	}
	lines.push('Recent log:');
	lines.push(game.log.slice(-15).map((l) => `[${l.who}] ${l.text}`).join('\n') || '(none yet)');
	return lines.join('\n');
}

// Throws on any failure (network error, non-2xx, missing/malformed tool call) — the caller
// (GameRoom.alarm()) is what decides how to react to a failure, this never returns a half-parsed
// result for applyAction to choke on unpredictably.
export async function requestAiTurn(game: GameState, seatId: PlayerKey, env: Env): Promise<any[]> {
	const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;

	const res = await fetch(ANTHROPIC_API_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01'
		},
		body: JSON.stringify({
			model,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: summarizeGameState(game, seatId) }],
			tools: [SUBMIT_TURN_TOOL],
			tool_choice: { type: 'tool', name: 'submit_turn' }
		})
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Anthropic API request failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
	}

	const data: any = await res.json();
	const toolUse = (data.content ?? []).find((block: any) => block.type === 'tool_use' && block.name === 'submit_turn');
	if (!toolUse || !Array.isArray(toolUse.input?.actions)) {
		throw new Error('Anthropic response did not include a valid submit_turn tool call');
	}

	// Never trust the model to have followed the "only act on your own seat" instruction — rewrite
	// `player` on every action to the seat that's actually allowed to act here, the same defensive
	// fix already applied to the human-facing MCP tools after the "AI played my cards" bug earlier
	// this project.
	return toolUse.input.actions.map((action: any) => ({ ...action, player: seatId }));
}
