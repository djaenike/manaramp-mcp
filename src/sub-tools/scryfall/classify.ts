/**
 * sub-tools/scryfall/classify.ts
 * Pure card-shape classifiers, no fetches. Lives at the Scryfall layer (not
 * delivery/) so both search_cards/get_card_by_name (category field on lookup
 * results, for use while picking cards) and delivery/report_data.js (the final
 * report's per-card category + count breakdown) share one definition instead of
 * two drifting copies.
 */

// Shape shared by anything classify.js's helpers accept -- a raw Scryfall card object, or the
// slimmer { type_line, oracle_text } detail records consistency.js/report_data.js pass around.
interface ClassifiableCard {
  type_line?: string | null;
  oracle_text?: string | null;
}

const MANA_ROCK_PATTERN = /\{T\}:\s*Add/i;
const CARD_DRAW_PATTERN = /\bdraws?\s+(a|an|\d+|one|two|three|four|five)\s+cards?\b/i;
const REMOVAL_PATTERN = /\b(destroy target|exile target|deals?\s+\d+\s+damage to target)\b/i;

// Priority order matters: an Artifact Creature is a Creature, not an Artifact; a Land
// is checked last since a handful of nonbasic lands also say "Artifact" in their type line.
function classifyCategory(typeLine?: string | null): string {
  const t = typeLine ?? "";
  if (t.includes("Creature")) return "Creature";
  if (t.includes("Instant")) return "Instant";
  if (t.includes("Sorcery")) return "Sorcery";
  if (t.includes("Enchantment")) return "Enchantment";
  if (t.includes("Artifact")) return "Artifact";
  if (t.includes("Planeswalker")) return "Planeswalker";
  if (t.includes("Land")) return "Land";
  return "Other";
}

// These three take a { type_line, oracle_text } shaped object (Scryfall's own field
// names) so callers can pass a raw Scryfall card object directly.
function isManaRock(card?: ClassifiableCard | null): boolean {
  return (card?.type_line ?? "").includes("Artifact") && MANA_ROCK_PATTERN.test(card?.oracle_text ?? "");
}

function isCardDraw(card?: ClassifiableCard | null): boolean {
  return CARD_DRAW_PATTERN.test(card?.oracle_text ?? "");
}

function isRemoval(card?: ClassifiableCard | null): boolean {
  return REMOVAL_PATTERN.test(card?.oracle_text ?? "");
}

export { classifyCategory, isManaRock, isCardDraw, isRemoval };
export type { ClassifiableCard };
