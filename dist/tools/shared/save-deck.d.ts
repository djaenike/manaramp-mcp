import { DeckPromptConstraints } from '../../functions/query/deck-prompts.js';
import { DeckAnalysis } from './deck-analysis.js';
import { McpContext } from '../types.js';
import 'mongodb';
import '../../functions/reference/deck-validation.js';
import '../../functions/query/cards.js';
import '../../functions/reference/bracket-facts.js';
import '../../functions/query/combos.js';
import 'zod';

interface SaveDeckInput {
    decklist_text: string;
    deck_name: string;
    format: string;
    wincon_summary: string;
    general_strategy: string;
    bracket_estimate?: string | null;
    is_public?: boolean;
    /** Overwrite this deck instead of creating one. Must belong to the caller. */
    deck_id?: string | null;
    prompt_id?: string | null;
    constraints?: DeckPromptConstraints | null;
    source: string;
    /** Only save when the analysis finds no blocking issue (wrong size, off-identity, illegal,
     *  unknown cards) -- fill_deck_plan's direct save. validate_and_submit saves regardless, as before. */
    requireClean?: boolean;
}
type SaveDeckResult = {
    saved: true;
    deck_id: string;
    deck_url: string;
    analysis: DeckAnalysis;
    priceSource: string;
} | {
    saved: false;
    error?: string;
    analysis?: DeckAnalysis;
    priceSource: string;
};
declare function saveDecklist(ctx: McpContext, input: SaveDeckInput): Promise<SaveDeckResult>;

export { type SaveDeckInput, type SaveDeckResult, saveDecklist };
