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
	'adjustLife', 'passTurn', 'addCard', 'removeCard', 'adjustCounter', 'declareAttackers',
	'activateAbility'
];

const SUBMIT_TURN_TOOL = {
	name: 'submit_turn',
	description:
		"Submit this seat's entire turn as an ordered list of actions, executed in order against the " +
		'live board state. Use addCard (zone: "battlefield") to play a land/permanent from your hand ' +
		'or create a token; moveCard to change a card\'s zone (e.g. hand -> battlefield, or -> graveyard ' +
		'when it dies); toggleTap to tap/untap something for mana; activateAbility to tap a permanent ' +
		'specifically for a non-mana ability (e.g. a "{T}: ..." effect) — this only taps it and logs ' +
		'the activation distinctly, you still apply whatever the ability actually does yourself via ' +
		'the other actions (adjustLife/addCard/adjustCounter/moveCard), same as resolving any spell; ' +
		'adjustLife/adjustCounter for damage, life swings, and +1/+1 or loyalty counters; draw for any ' +
		'extra card draw beyond the automatic turn draw you already received; declareAttackers to ' +
		'attack (damage resolves automatically once blocks are decided — you do not need to adjust ' +
		'life for combat yourself). End the list with a passTurn action once your turn is complete so ' +
		'play moves to the next seat — if you attacked and blocks are still pending, passTurn will ' +
		'simply fail harmlessly and be retried automatically once combat resolves.',
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
							description: 'Exact existing card name — required by moveCard/toggleTap/removeCard/adjustCounter/activateAbility.'
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
						},
						attackerNames: {
							type: 'array',
							items: { type: 'string' },
							description: 'declareAttackers only: exact names of your own untapped, non-summoning-sick ' +
								'(or hasty) creatures to attack with this turn. Omit or leave empty to attack with nothing.'
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
	'playtest simulator. This is not a fully rules-enforced engine: there is no stack and no ' +
	'priority passing, and casting a spell or activating an ability still just applies its effect ' +
	'directly via the actions available (moveCard/adjustLife/adjustCounter/addCard/removeCard). ' +
	'Combat is the one part of the game that IS structured: use declareAttackers to attack with ' +
	'your untapped, non-summoning-sick (or hasty) creatures — the engine automatically figures out ' +
	'blocks (from your opponent, or from this same engine on their behalf) and resolves damage, ' +
	'deaths, and life loss for you. You never need to manually adjust life or move cards to the ' +
	'graveyard for combat. A card tagged [power/toughness] in the board summary is a creature; ' +
	'[sick] means it has summoning sickness and can\'t attack unless it has haste; [tapped] means ' +
	'it can\'t attack or be tapped for anything else this turn. Use good judgement to play a ' +
	'sensible, reasonably strong turn given your hand, board, and mana available (lands + other ' +
	'mana sources on your battlefield, tapped for cost). Only ever act on your own seat — never ' +
	'move or modify another seat\'s cards or life total. Always respond by calling the submit_turn ' +
	'tool exactly once. If there is nothing productive to do, a single passTurn action is a ' +
	'completely valid turn.';

function describeCard(cardInfo: GameState['cardInfo'], card: Card, detailed: boolean): string {
	const info = cardInfo[card.name.toLowerCase()];
	const tapped = card.tapped ? ' [tapped]' : '';
	const sick = card.summoningSick ? ' [sick]' : '';
	const pt = info?.power != null && info?.toughness != null ? ` [${info.power}/${info.toughness}]` : '';
	const counters = card.counters && Object.keys(card.counters).length
		? ' {' + Object.entries(card.counters).map(([k, v]) => `${k}:${v}`).join(', ') + '}'
		: '';
	if (!detailed) return `${card.name}${pt}${tapped}${sick}${counters}`;
	const cost = info?.manaCost ? ` ${info.manaCost}` : '';
	const type = info?.typeLine ? ` — ${info.typeLine}` : '';
	const text = info?.oracleText ? ` :: ${info.oracleText.replace(/\n/g, ' ')}` : '';
	return `${card.name}${cost}${type}${pt}${tapped}${sick}${counters}${text}`;
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

// Shared plumbing for every Anthropic call in this file: forces structured output via a single
// named tool (tool_choice), throws on any failure (network error, non-2xx, missing/malformed tool
// call) rather than returning something half-parsed for the caller to choke on unpredictably, and
// returns just the validated `input` object of the forced tool call.
async function callAnthropicTool(system: string, userContent: string, tool: { name: string; [k: string]: unknown }, env: Env): Promise<any> {
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
			system,
			messages: [{ role: 'user', content: userContent }],
			tools: [tool],
			tool_choice: { type: 'tool', name: tool.name }
		})
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Anthropic API request failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
	}

	const data: any = await res.json();
	const toolUse = (data.content ?? []).find((block: any) => block.type === 'tool_use' && block.name === tool.name);
	if (!toolUse) {
		throw new Error(`Anthropic response did not include a valid ${tool.name} tool call`);
	}
	return toolUse.input;
}

export async function requestAiTurn(game: GameState, seatId: PlayerKey, env: Env): Promise<any[]> {
	const input = await callAnthropicTool(SYSTEM_PROMPT, summarizeGameState(game, seatId), SUBMIT_TURN_TOOL, env);
	if (!Array.isArray(input?.actions)) {
		throw new Error('Anthropic response did not include a valid actions array');
	}
	// Never trust the model to have followed the "only act on your own seat" instruction — rewrite
	// `player` on every action to the seat that's actually allowed to act here, the same defensive
	// fix already applied to the human-facing MCP tools after the "AI played my cards" bug earlier
	// this project.
	return input.actions.map((action: any) => ({ ...action, player: seatId }));
}

const DECLARE_BLOCKS_TOOL = {
	name: 'declare_blocks',
	description:
		'Declare your blocks against the current attackers, or none at all. For each attacker you ' +
		"choose to block, list its exact name and the exact name(s) of your creature(s) blocking it " +
		"(multiple blockers on one attacker are allowed). Leave 'blocks' empty to take all the damage.",
	input_schema: {
		type: 'object',
		properties: {
			blocks: {
				type: 'array',
				description: 'One entry per attacker you are choosing to block.',
				items: {
					type: 'object',
					properties: {
						attackerName: { type: 'string', description: "Exact name of the attacking creature you're blocking." },
						blockerNames: { type: 'array', items: { type: 'string' }, description: 'Exact name(s) of your creature(s) assigned to block it.' }
					},
					required: ['attackerName', 'blockerNames']
				}
			}
		},
		required: ['blocks']
	}
};

// Focused, single-decision call — much cheaper/faster than a full requestAiTurn, and used both for
// an AI defender responding to a human's or another AI's attack. Resolves names to ids directly
// against the live GameState (this file has no access to GameRoom's private id-resolution
// helpers); any assignment referencing an unknown or already-used name is silently dropped rather
// than thrown, matching the existing "collect errors, don't abort" philosophy used for batches.
export async function requestAiBlocks(game: GameState, seatId: PlayerKey, env: Env): Promise<Record<string, string[]>> {
	const combat = game.combat!;
	const attackerBattlefield = game.players[combat.attackerSeat].battlefield;
	const attackerLines = combat.attackers.map((id) => {
		const card = attackerBattlefield.find((c) => c.id === id);
		return card ? `- ${describeCard(game.cardInfo, card, true)}` : null;
	}).filter(Boolean).join('\n');

	const userContent =
		summarizeGameState(game, seatId) +
		`\n\nYou are being attacked. Attackers:\n${attackerLines}\n\n` +
		'Declare your blocks (or none) by calling declare_blocks.';

	const input = await callAnthropicTool(SYSTEM_PROMPT, userContent, DECLARE_BLOCKS_TOOL, env);
	const blockerBattlefield = game.players[seatId].battlefield;
	const usedBlockerIds = new Set<string>();
	const blocks: Record<string, string[]> = {};

	for (const entry of input?.blocks ?? []) {
		const attackerCard = attackerBattlefield.find((c) => c.name.toLowerCase() === (entry?.attackerName ?? '').toLowerCase());
		if (!attackerCard || !combat.attackers.includes(attackerCard.id)) continue;
		const blockerIds: string[] = [];
		for (const name of entry?.blockerNames ?? []) {
			const blockerCard = blockerBattlefield.find(
				(c) => c.name.toLowerCase() === (name ?? '').toLowerCase() && !usedBlockerIds.has(c.id)
			);
			if (!blockerCard) continue;
			usedBlockerIds.add(blockerCard.id);
			blockerIds.push(blockerCard.id);
		}
		if (blockerIds.length) blocks[attackerCard.id] = blockerIds;
	}
	return blocks;
}

// Another focused call, for an AI seat that's over the hand-size limit at end of turn. The tool
// schema is built fresh per call with minItems/maxItems pinned to the exact required count, rather
// than a shared constant — this is the one tool in this file whose shape genuinely depends on the
// call's own arguments.
export async function requestAiDiscard(game: GameState, seatId: PlayerKey, count: number, env: Env): Promise<string[]> {
	const tool = {
		name: 'declare_discard',
		description: `Choose exactly ${count} card(s) from your hand to discard.`,
		input_schema: {
			type: 'object',
			properties: {
				cardNames: {
					type: 'array',
					items: { type: 'string' },
					minItems: count,
					maxItems: count,
					description: `Exact names of ${count} card(s) in your hand to discard.`
				}
			},
			required: ['cardNames']
		}
	};
	const userContent = summarizeGameState(game, seatId) + `\n\nYour hand is over the limit — choose ${count} card(s) to discard.`;
	const input = await callAnthropicTool(SYSTEM_PROMPT, userContent, tool, env);

	const hand = [...game.players[seatId].hand];
	const chosenIds: string[] = [];
	for (const name of input?.cardNames ?? []) {
		const idx = hand.findIndex((c) => c.name.toLowerCase() === (name ?? '').toLowerCase());
		if (idx === -1) continue;
		chosenIds.push(hand[idx].id);
		hand.splice(idx, 1); // don't let one repeated name consume the same card twice
	}
	// Pad or truncate deterministically so the caller always gets exactly `count` valid ids, even
	// if the model's answer didn't fully resolve — same "never half-fail the caller" philosophy as
	// requestAiTurn's error handling.
	while (chosenIds.length < count && hand.length) chosenIds.push(hand.pop()!.id);
	return chosenIds.slice(0, count);
}
