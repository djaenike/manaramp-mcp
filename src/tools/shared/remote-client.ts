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

const MANARAMP_MCP_URL = process.env.MANARAMP_MCP_URL || "https://manaramp.com/mcp";

class RemoteToolError extends Error {}

async function callRemoteTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.MANARAMP_API_KEY;
  if (!apiKey) {
    throw new RemoteToolError(
      "No Manaramp API key configured -- open this extension's settings in Claude Desktop and paste " +
      "in the key from your manaramp.com profile page (MCP API key section)."
    );
  }

  let res: Response;
  try {
    res = await fetch(MANARAMP_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
  } catch (e: any) {
    throw new RemoteToolError(`Couldn't reach manaramp.com: ${e.message}`);
  }

  if (res.status === 401) {
    throw new RemoteToolError(
      "manaramp.com rejected this API key (invalid or revoked) -- regenerate it from your profile " +
      "page and update this extension's settings in Claude Desktop."
    );
  }
  if (!res.ok) {
    throw new RemoteToolError(`manaramp.com/mcp request failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as any;
  if (body.error) {
    throw new RemoteToolError(`${toolName} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }

  // MCP tool results wrap the actual payload as content: [{ type: "text", text: "<json>" }] --
  // every remote tool here returns JSON.stringify'd text (see manage-deck.ts/search-cards.ts/
  // push-game-log.ts), so unwrap and parse it back into a real object rather than handing callers a
  // raw string.
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new RemoteToolError(`${toolName} returned an unexpected shape: ${JSON.stringify(body.result)}`);
  }
  return JSON.parse(text) as T;
}

export { callRemoteTool, RemoteToolError };
