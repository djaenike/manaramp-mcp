/**
 * local/index.ts
 * The stdio bootstrap -- imports `localTools` from ../tools/index.js (the 2 genuinely local-only
 * Arena tools, get_account_settings, plus every Mongo-backed conversational tool wrapped as a
 * remote-HTTP proxy -- see that file's header for the full breakdown) and registers each with
 * server.tool(...), then connects the stdio transport. This file is the package's "./local" export
 * (see package.json) and is what npm start / the .mcpb manifest actually run.
 *
 * None of localTools' handlers read their second (ctx) argument -- the Arena tools and
 * get_account_settings genuinely don't need it, and the remote-proxied tools ignore it too (their
 * real ctx gets built server-side, per-request, by manaramp's own /mcp route instead) -- so the
 * SDK's own per-call `extra` object is passed through in its place here, harmless either way.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { localTools } from "../tools/index.js";

// Create the MCP server instance
const server = new McpServer({
  name: "manaramp-mcp",
  version: "3.0.0",
});

for (const tool of localTools) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler as any);
}

// --- Start the server over stdio ---
// Guarded so this file only connects a real transport when it's the actual entry point (not just
// imported as a module elsewhere). MUST use pathToFileURL, not a plain
// `file://${process.argv[1]}` string concat -- on Windows process.argv[1] is a backslash path
// ('C:\Users\...') while import.meta.url is a proper file:// URL ('file:///C:/Users/...'); string
// concat never matches, which silently skips server.connect() entirely -- the server starts and
// accepts the stdio pipe but never responds to anything, hanging until the client times out and
// cancels.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
