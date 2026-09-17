/**
 * tools/shared/remote-client.ts
 *
 * Authenticated HTTP client for the two Arena tools (local-stdio-only) to reach manaramp's remote
 * `/mcp` endpoint for the two things that only live in manaramp's own database: pushing a finished
 * draft/match log (push_game_log) and pulling 17Lands format_stats-enriched card data
 * (query_cards) -- see CLAUDE.md's "Remote MCP + Mongo" section. Uses MANARAMP_API_KEY, injected
 * via manifest.json's user_config -- Claude Desktop prompts for it once at install/setup and stores
 * it in the OS keychain, NEVER baked into this distributed .mcpb itself (a shared file every
 * installer downloads identically -- see .mcpbignore's own header for the related packaging-safety
 * note). Every user configures their own key from their manaramp.com profile page.
 *
 * Plain JSON-RPC 2.0 `tools/call` requests against manaramp/src/routes/mcp/+server.ts's own
 * transport (WebStandardStreamableHTTPServerTransport, enableJsonResponse: true) -- one request, one
 * JSON response, no session/SSE needed for a single tool call.
 */
declare class RemoteToolError extends Error {
}
declare function callRemoteTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T>;

export { RemoteToolError, callRemoteTool };
