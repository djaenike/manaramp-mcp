import { Effect, CardSummary } from './cards.js';
import 'mongodb';

/**
 * functions/query/card-view.ts
 *
 * The card shape fill_deck_plan / edit_deck return to the model (2026-09-27) -- enough to judge a pick
 * and see synergies WITHOUT the raw Forge effects tree:
 *
 *   abilities[] -- one per ability: what fires it (`on` + `on_what`), what it does (`does`, in chain
 *                  order), what it hits (`targets`), its cost, and whether it's optional ("you may").
 *   makes_tokens -- what it creates, resolved from Forge's token scripts ("1/1 red Goblin").
 *   roles        -- manaramp's precomputed role flags (ramp/draw/removal...), same rules as the website.
 *
 * Seeing "Goblin Instigator: on etb -> does Token, makes 1/1 red Goblin" next to "Impact Tremors: on
 * etb of Creature.YouCtrl -> does DealDamage to Player.Opponent" makes the loop visible without
 * guessing. Oracle text rides along as the ground truth for the fine print.
 *
 * The trigger-name normalization (etb/dies/attacks/...) is the one the website's card page used to
 * show; Forge's own Mode$ vocabulary, not guessed.
 */

interface CardAbility {
    kind: string;
    on: string | null;
    on_what: string | null;
    does: string[];
    targets: string | null;
    cost: string | null;
    optional: boolean;
}
declare function abilitiesOf(effects: Effect[]): CardAbility[];
declare function tokensOf(effects: Effect[]): string[];
/** A pick in a fill/edit response. `slot` = the plan slot that chose it. */
declare function toPlanCard(c: CardSummary, slot?: string, opts?: {
    withText?: boolean;
}): Record<string, unknown>;
/** Alternates / utility lands: same shape minus oracle text. */
declare const toBriefPlanCard: (c: CardSummary, slot?: string) => Record<string, unknown>;
/** What a commander REWARDS (2026-09-27) -- a rules-based read of its abilities + text, so a model
 *  building with no stated theme starts from what this commander actually pays off, not from a
 *  remembered "typical" list. Hints, not verdicts: the model still reads the abilities itself. */
declare function commanderRewards(c: CardSummary): string[];

export { type CardAbility, abilitiesOf, commanderRewards, toBriefPlanCard, toPlanCard, tokensOf };
