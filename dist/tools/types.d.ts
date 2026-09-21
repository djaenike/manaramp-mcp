import { ZodRawShape, z } from 'zod';
import { Db } from 'mongodb';

/**
 * tools/types.ts
 * Shared shape for every registered tool definition under tools/. Each tools/*.ts file exports one
 * or more plain objects matching this shape -- name, description, a zod raw shape (the same object
 * literal server.tool(...) previously took as its third argument), and an async handler -- rather
 * than calling server.tool(...) itself. local/index.ts and the remote manaramp `/mcp` endpoint are
 * the only two places that actually register a tool against a transport, each looping over
 * tools/index.ts's exported definitions.
 *
 * McpContext: added when every Mongo-backed tool (all but the two Arena tools) switched from
 * hitting live Scryfall/EDHREC/Commander Spellbook/Card Kingdom/Forge APIs to querying manaramp's
 * own already-ingested MongoDB data directly (2026-09-17) -- see CLAUDE.md's "Remote MCP + Mongo"
 * section. A tool handler never opens its own MongoClient: Mongo credentials only ever live inside
 * manaramp's Cloudflare Worker (see manaramp's src/lib/server/queries/db.ts), never distributed to
 * an end user's machine -- this package only ever receives an already-connected `Db` handed to it
 * per-request. readDb is the MONGODB_READONLY_URI-backed connection (cards/sets/commander_synergies/
 * combos -- anything just being read, genuinely enforced read-only by Atlas's built-in "Read Only"
 * role); writeDb is the MONGODB_READWRITE_URI-backed connection (`readWriteAnyDatabase` -- broad,
 * NOT scoped to decks/game_logs/draft_results at the database level despite what earlier comments
 * here claimed, corrected 2026-09-17 after checking Atlas directly -- that separation is an
 * application-code convention, not an Atlas-enforced one). Both are required on every call (not
 * optional) because manage_deck's single tool call both reads (card data, for the report) and
 * writes (persisting the deck) in one invocation.
 *
 * The two Arena tools (arena_draft_assistance/arena_draft_game_advice) are local-stdio-only and
 * never receive a real ctx -- local/index.ts passes a stub (db access from a user's own machine was
 * deliberately never wired up; see tools/shared/arena-local-state.ts's header). Their handlers never
 * read ctx.
 */

interface McpToolResponse {
    content: Array<{
        type: "text";
        text: string;
    }>;
}
/** 'cardkingdom' | 'manapool' -- which market a price normalizes to. Mirrors manaramp's own
 *  PriceSource type (src/lib/server/mcp-keys/index.ts) exactly; kept as a separate local literal
 *  union rather than importing it, same repo-boundary call as everything else in this file (manaramp
 *  doesn't depend on manaramp-mcp, and this package has no dependency back on manaramp either). */
type PriceSource = "cardkingdom" | "manapool";
interface McpContext {
    /** MONGODB_READONLY_URI-backed -- cards/sets/commander_synergies/combos. Read-only at the
     *  database level regardless of what a handler tries to do with it. */
    readDb: Db;
    /** MONGODB_READWRITE_URI-backed -- `readWriteAnyDatabase`, broad access; decks/game_logs/
     *  draft_results is an application-code convention, not an Atlas-level restriction. */
    writeDb: Db;
    /** The calling account's real users._id, resolved by manaramp's /mcp route from the request's
     *  Authorization: Bearer <api key> header before any tool handler runs. Every remote call is
     *  authenticated (API keys are mandatory at account creation) -- there is no anonymous/unowned
     *  path anymore, unlike the pre-2026-09-17 local-stdio-only design. */
    ownerUserId: string;
    /** Lazily resolves this account's saved player_log_path (2026-09-19, for get_account_settings
     *  over remote). mcp_keys is account/security-adjacent data under the full MONGODB_URI -- the
     *  same trust tier as Better Auth's own collections, deliberately NOT exposed via readDb/writeDb
     *  to every tool handler (see schema/mcp_keys.ts's header in the `manaramp` repo). manaramp's
     *  /mcp route resolves ownerUserId via that same full-access connection during auth already, so
     *  it hands this down as a narrow, single-purpose getter instead of widening readDb/writeDb's
     *  scope -- keeps the boundary at "the route can touch mcp_keys," not "every tool handler can."
     *  A getter (not the value itself) so a Worker request that never calls get_account_settings
     *  never pays for the extra mcp_keys round trip. Optional: local/index.ts's stdio bootstrap
     *  passes the SDK's own `extra` object in ctx's place (see that file's header) and has no such
     *  field -- get_account_settings falls back to its own local resolution when it's absent. */
    getPlayerLogPath?: () => Promise<string | null>;
    /** Lazily resolves this account's saved price-normalization preference (2026-09-21, for
     *  optimize_deck/publish_deck's deck-total pricing -- see functions/query/cards.ts's toSummary and
     *  tools/shared/deck-analysis.ts's analyzeDecklist). Same trust tier / same reasoning as
     *  getPlayerLogPath directly above -- read that comment for why this is a getter under mcp_keys
     *  rather than something exposed via readDb/writeDb. Optional for the identical reason too: absent
     *  under local/index.ts's stdio bootstrap, AND absent for any account that predates this
     *  preference existing (price_source: null in Mongo) -- every caller treats a missing/undefined
     *  result the same way, falling back to 'cardkingdom' (this app's price displays already preferred
     *  Card Kingdom before this preference existed, so that's not a behavior change for anyone who
     *  hasn't touched the /settings toggle). */
    getPriceSourcePreference?: () => Promise<PriceSource>;
}
interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
    name: string;
    description: string;
    inputSchema: Shape;
    handler: (args: z.infer<z.ZodObject<Shape>>, ctx: McpContext) => Promise<McpToolResponse>;
}

export type { McpContext, McpToolResponse, PriceSource, ToolDefinition };
