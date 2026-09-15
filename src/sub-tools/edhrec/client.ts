/**
 * sub-tools/edhrec/client.ts
 * EDHREC has no official API — this hits the same undocumented JSON endpoints
 * their own site uses to render pages. May change or break without notice.
 */

const EDHREC_BASE = "https://json.edhrec.com/pages";

// Converts a card/commander name into EDHREC's URL slug format.
// e.g. "Atraxa, Grand Unifier" -> "atraxa-grand-unifier"
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['’,]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export { EDHREC_BASE, slugify };
