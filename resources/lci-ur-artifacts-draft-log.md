# Lost Caverns of Ixalan — UR Artifacts/Pirates Draft Log

**Date:** September 11, 2026
**Tool used:** scryfall-mcp `arena_draft_assistance` (with 17lands card_ratings CSV)
**Result:** 1-3 in Bronze ranked

---

## Full Pick Log

### Pack 1
| Pick | Card |
|---|---|
| 1 | Abrade |
| 2 | Captain Storm, Cosmium Raider |
| 3 | Ancestors' Aid |
| 4 | Compass Gnome |
| 5 | Captain Storm, Cosmium Raider (2nd) |
| 6 | Orazca Puzzle-Door |
| 7 | Orazca Puzzle-Door (2nd) |
| 8 | Daring Discovery |
| 9 | Hotfoot Gnome |
| 10 | Didact Echo |
| 11 | Shipwreck Sentry |
| 12 | Didact Echo (2nd) |
| 13 | Marauding Brinefang |
| 14 | Didact Echo (3rd) |
| 15 | Unidentified land (grpId 87453 — never resolved in card data) |

### Pack 2
| Pick | Card |
|---|---|
| 1 | Waylaying Pirates |
| 2 | Oaken Siren |
| 3 | Oaken Siren (2nd) |
| 4 | Waterwind Scout |
| 5 | Sunshot Militia |
| 6 | Cartographer's Companion |
| 7 | Brazen Blademaster |
| 8 | Unlucky Drop |
| 9 | Marauding Brinefang (2nd) |
| 10 | Ancestral Reminiscence |
| 11 | Disruptor Wanderglyph |
| 12 | Daring Discovery (2nd) |
| 13 | Glorifier of Suffering (off-color throwaway) |
| 14 | Unidentified (grpId 87215 — never resolved) |
| 15 | Unidentified (grpId 87148 — never resolved) |

### Pack 3
| Pick | Card |
|---|---|
| 1 | Shipwreck Sentry (2nd) |
| 2 | Oaken Siren (3rd) |
| 3 | Sunfire Torch |
| 4 | Plundering Pirate |
| 5 | Unidentified (grpId 87186 — never resolved) |
| 6 | Shipwreck Sentry (3rd) |
| 7 | Hotfoot Gnome (2nd) |
| 8 | Unlucky Drop (2nd) |
| 9 | Tectonic Hazard (weak, cut) |
| 10 | Hunter's Blowgun (marginal, cut) |
| 11 | Frilled Cave-Wurm (weak, cut) |
| 12 | Volatile Fault |
| 13 | Bloodthorn Flail (off-color, cut) |
| 14 | Relic's Roar (weak, cut) |
| 15 | Unidentified land (grpId 87453 — same unresolved card as P1P15) |

**Note:** 5 cards across the draft never resolved to card data via Scryfall lookup (grpIds 87453 x2, 87215, 87148, 87186). These are excluded from deck analysis below — worth checking the collection/deck builder directly if curious what they were.

---

## Final Deck: UR Artifacts/Pirates (40 cards)

**Creatures (16)**
- Oaken Siren x3 (2 CMC) — flying/vigilance, artifact, Pirate
- Captain Storm, Cosmium Raider x2 (2 CMC) — counters off artifacts entering
- Shipwreck Sentry x2 (2 CMC) — Pirate, attacks with an artifact out
- Sunshot Militia (2 CMC) — reach/finisher
- Compass Gnome (2 CMC) — fixing + artifact
- Waterwind Scout (3 CMC) — flying, makes a Map
- Plundering Pirate (3 CMC) — Pirate, makes a Treasure
- Brazen Blademaster (3 CMC) — Pirate, pumps with 2+ artifacts
- Cartographer's Companion (3 CMC) — artifact creature, makes a Map
- Waylaying Pirates (4 CMC) — stun-taps with an artifact out
- Didact Echo x2 (5 CMC) — draws a card, can fly late

**Spells (7)**
- Sunfire Torch (1 CMC) — cheap equipment, reach
- Abrade (2 CMC) — premium removal
- Ancestors' Aid (2 CMC) — trick + Treasure
- Unlucky Drop x2 (4 CMC) — tempo removal
- Daring Discovery (5 CMC) — unblockable + card advantage
- Marauding Brinefang (7 CMC, Islandcycles for 2) — flexible top-end

**Lands (17):** 10 Island, 7 Mountain

**Sideboard candidates:** Hotfoot Gnome x2, 3rd Shipwreck Sentry, 3rd Didact Echo, 2nd Daring Discovery, 2nd Marauding Brinefang, Disruptor Wanderglyph, Ancestral Reminiscence, Orazca Puzzle-Door x2

**Cut (off-color/weak):** Glorifier of Suffering, Frilled Cave-Wurm, Relic's Roar, Tectonic Hazard, Hunter's Blowgun, Bloodthorn Flail

---

## Match Results: 1-3

| Game | Result | Cause |
|---|---|---|
| 1 | Loss | Flooded — drew all lands, not enough card draw to dig out |
| 2 | Win | — |
| 3 | Loss | Cut to 16 lands + swapped in Cogwork Wrestler (untested card), cut Unlucky Drop/Didact Echo/Marauding Brinefang — then got mana screwed |
| 4 | Loss | Added the land back, but swapped in Daring Discovery over removal — had no answers when the board needed one |

**Takeaways for next time:**
- Stick with 17 lands given the curve (tops out at 5, plus a 7-drop).
- Don't cut Unlucky Drop — it's one of the deck's best pieces of interaction (59.8% GIH WR).
- Card advantage (Daring Discovery, Didact Echo) isn't a substitute for removal — the deck needs both.

---

## MCP Runtime Issues (Developer Feedback)

**Symptom:** `arena_draft_assistance` calls started fast (early Pack 1) but slowed to roughly **1 minute per call by Pack 3**. This is a serious usability problem — Arena draft pick timers don't allow for that kind of delay, making the tool close to unusable late in a draft.

**Likely root causes** (based on the pattern of scaling slowdown):
1. **Full log re-parse per call.** `Player.log` only grows during a session. If the tool re-reads and re-parses the entire file from the start on every call rather than resuming from a saved byte/line offset, parse time scales with file size — consistent with the "fast early, slow late" pattern observed.
2. **Full pick-history re-resolution per call.** The `picks_made` array returned grows every pick and appears to get fully re-resolved (name/oracle text/ratings) each call rather than caching previously-resolved cards by ID. This means the cost of resolving pick 45 also re-does the work for picks 1-44.
3. **Repeated CSV load.** The 286-row `card_ratings-*.csv` should be cheap to parse, but if it's reloaded per call rather than cached in memory for the session, it adds a fixed cost on top of the above.
4. **Card resolution lookup method.** If Scryfall/17lands lookups are done via linear scan or repeated fuzzy matching rather than an indexed/hashed lookup by grpId, that cost also multiplies with both pick count and calls made.

**Suggested fixes:**
- Track a persistent read offset (byte position or line number) into `Player.log` so each call only parses new content since the last read, rather than the whole file.
- Cache resolved card data (name, oracle text, ratings) by ID for the session so repeat lookups for the same 40+ already-picked cards are instant.
- Load the ratings CSV once per session (in memory) rather than per call.
- Consider building an ID → card index (hash map) once at CSV/session load rather than scanning per lookup.

**Secondary issue — unresolved cards:** 5 of the 45 total cards seen across the draft (~11%) never resolved to card data (grpId returned with `card: null`). This didn't block play, but it did prevent draft advice and final deckbuilding analysis for those slots. Worth checking whether the Scryfall/17lands lookup is failing silently on certain card IDs (possibly newer or oddly-named cards, or a stale/incomplete local card database) and whether failures are logged anywhere for debugging.

FULL CHAT:


Claude finished the response
Reviewing a shared screenshot to verify a draft pick.
Reviewing a shared screenshot to verify a draft pick.
You're right, and thanks for the screenshot — that confirms it. Huatli, Poet of Unity was indeed in that pack, along with three other cards I couldn't previously identify: Council of Echoes, Colossadactyl, and River Herald Guide. Those four were exactly the unresolved grpIds from the log that I mentioned I couldn't name.

For the record, here's the complete Pack 1, Pick 1 now:

Card	Color	Note
Abrade	R	(what you picked)
Huatli, Poet of Unity	G	Legendary, tutors a land, has a late-game flip ability
Council of Echoes	U	Flying, Descend 4 return ability
Colossadactyl	GG	4/5 reach/trample
Spelunking	G	Enchantment, card advantage on lands
Thousand Moons Crackshot	R	Land ramp on attack
Song of Stupefaction	U	Aura, mill for value
Ray of Ruin	B	Removal
Hotfoot Gnome	R	Artifact, haste
Idol of the Deep King	R	Flash artifact, pings
Sunshot Militia	R	Reach/finisher
River Herald Guide	G	Explores on ETB
Seeker of Sunlight	G	Explores, activated
Buried Treasure	Colorless	Fixing artifact
Promising Vein	Colorless	Fixing land
Abrade was still the correct pick for a UR deck — Huatli is a strong card but green, off your colors. Good catch flagging the gap, and useful confirmation that the unresolved-card issue in the MCP is real and affects specific cards consistently (all four of these apparently failed to resolve, not just random noise).

i need a log of all the grpids that diddnt resolve and which picks they were. 17lands is easily able to grab all this data.

Matching newly identified cards to their unresolved pack slots.
Good catch — this also reveals a second, more subtle bug pattern: some cards (Sunfire Torch, Plundering Pirate) resolved fine when first seen in a pack but then came back null later when the full pick history was re-queried at the end. That's worth flagging separately from "never resolved at all." Here's the full breakdown:

Never resolved, at any point (true failures):

grpId	Pack/Pick	Status
87453	P1P15, P3P15 (same ID both times)	Still unidentified
87215	P2P14	Still unidentified
87148	P2P15	Still unidentified
87186	P3P5	Still unidentified
Resolved on first view, but came back null on a later full-history re-query (inconsistent resolution):

grpId	Pack/Pick	Card (identified live at the time)
87321	P3P3	Sunfire Torch
87313	P3P4	Plundering Pirate
Resolved retroactively via your screenshot (previously unresolved at P1P1):

Pack/Pick	Card	Note
P1P1	Huatli, Poet of Unity	grpId unconfirmed — one of 87368/87334/87188/87344
P1P1	Council of Echoes	grpId unconfirmed — one of the same set
P1P1	Colossadactyl	grpId unconfirmed — one of the same set
P1P1	River Herald Guide	grpId unconfirmed — one of the same set
I don't have a reliable way to map which of those four grpIds corresponds to which of those four card names — the tool never returned that pairing since resolution failed at the time. If you can pull the grpId-to-name mapping from 17lands' own dataset for LCI, that'd close the gap; otherwise the pack composition is confirmed but not the exact ID-to-name pairing for those four.

Want me to add this as a section to the markdown file from before, or produce it as a standalone log?

does it show the card names in the player logs, or only grpid

Recalling how MTG Arena logs its match data.
Recalling how MTG Arena logs its match data.
From what I've seen through the MCP tool's output — I don't have direct raw access to the log file itself, only what the tool passes back to me — it's returning grpId only, never card names directly from the log. That's consistent with how MTG Arena's Player.log generally works: it logs internal numeric grpId values as the canonical card identifier, not human-readable names. Name resolution is a separate step that requires mapping grpId → card name via a database (Scryfall's Arena ID field, MTGA's own card database files, or 17lands' own mapping tables).

So the "unresolved" cards aren't missing from the log — the log has the grpId just fine (that's why the tool still shows the pick happened, just with card: null). The failure is happening in your tool's lookup/resolution step, where it's failing to match that grpId to a card in whatever data source it's querying (presumably Scryfall's Arena ID field or a local card database).

A few things worth checking on the resolution side:

Is the lookup matching on Scryfall's arena_id field specifically, and could some newer/reprinted LCI cards have a missing or mismatched arena_id in Scryfall's data?
Since 17lands clearly has a full and correct grpId mapping (as you noted), it might be worth cross-referencing your resolution table against 17lands' arena card ID data as a fallback source when the primary lookup misses.
Worth logging why resolution failed (404, no match found, malformed ID) rather than just returning null — right now there's no way to tell if it's "card not in database" vs "lookup errored out" vs "ID mismatch."
Want me to add this line of investigation to the markdown log as well?

