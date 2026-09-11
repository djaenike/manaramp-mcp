/**
 * sub-tools/scryfall/images.js
 * The final deck report is typically shown as a published Artifact, and Artifacts run
 * under a CSP that silently blocks images from any external host -- including
 * Scryfall's own image CDN (cards.scryfall.io) -- so a plain <img src="https://..."> in
 * the report never renders there. Inlining each image as a base64 data: URI sidesteps
 * that entirely (a data: URI isn't an external fetch). Not needed by search_cards/
 * get_card_by_name, which only return the raw Scryfall URL for Claude to reason over --
 * this is specific to the rendered HTML report.
 */

import { HEADERS } from "./client.js";

async function fetchImageAsDataUri(url) {
  if (!url) return null;
  try {
    // Scryfall's image CDN (cards.scryfall.io) rejects requests with no/generic User-Agent
    // the same way their API does -- a plain fetch(url) here silently 400s.
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null; // a single card's image failing to fetch shouldn't fail the whole report
  }
}

/** Mutates cardDetails in place, replacing each entry's image_url with an inlined data URI. */
async function inlineCardImages(cardDetails, { concurrency = 8 } = {}) {
  const entries = Array.from(cardDetails.entries()).filter(([, details]) => details?.image_url);
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(batch.map(async ([name, details]) => {
      cardDetails.set(name, { ...details, image_url: await fetchImageAsDataUri(details.image_url) });
    }));
  }
  return cardDetails;
}

export { fetchImageAsDataUri, inlineCardImages };
