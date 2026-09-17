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
        Accept: "application/json",
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
