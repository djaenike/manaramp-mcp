const MANARAMP_MCP_URL = process.env.MANARAMP_MCP_URL || "https://manaramp.com/mcp";
class RemoteToolError extends Error {
}
async function callRemoteTool(toolName, args) {
  const apiKey = process.env.MANARAMP_API_KEY;
  if (!apiKey) {
    throw new RemoteToolError(
      "No Manaramp API key configured -- open this extension's settings in Claude Desktop and paste in the key from your manaramp.com profile page (MCP API key section)."
    );
  }
  let res;
  try {
    res = await fetch(MANARAMP_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // MUST list BOTH application/json and text/event-stream, or manaramp's own
        // WebStandardStreamableHTTPServerTransport (see manaramp's src/routes/mcp/+server.ts)
        // rejects the request outright with 406 "Not Acceptable: Client must accept both
        // application/json and text/event-stream" -- confirmed live 2026-09-19 via a real drafting
        // session: arena_draft_assistance's grpId resolution 406'd on every single card while the
        // exact same grpIds resolved fine through query_cards called directly by the chat client
        // (whose official MCP client already sends this correctly) -- isolating the bug to this
        // hand-rolled fetch client specifically, not the data or the remote endpoint. This is the
        // SDK's own mandatory Accept-header check for every POST to a Streamable HTTP server,
        // regardless of whether the response actually comes back as JSON or SSE -- a plain
        // "application/json" alone was never sufficient. Every caller of callRemoteTool was affected,
        // not just query_cards: push_draft_result and push_game_log use this exact same client, so
        // draft/match results have likely been silently failing to reach manaramp's database too.
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: args }
      })
    });
  } catch (e) {
    throw new RemoteToolError(`Couldn't reach manaramp.com: ${e.message}`);
  }
  if (res.status === 401) {
    throw new RemoteToolError(
      "manaramp.com rejected this API key (invalid or revoked) -- regenerate it from your profile page and update this extension's settings in Claude Desktop."
    );
  }
  if (!res.ok) {
    throw new RemoteToolError(`manaramp.com/mcp request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new RemoteToolError(`${toolName} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new RemoteToolError(`${toolName} returned an unexpected shape: ${JSON.stringify(body.result)}`);
  }
  return JSON.parse(text);
}
export {
  RemoteToolError,
  callRemoteTool
};
