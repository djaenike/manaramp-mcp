/**
 * local/index.ts
 * The stdio bootstrap (was index.js) -- imports the 8 tool definitions from ../tools/index.js and
 * registers each with server.tool(...), then connects the stdio transport. This file is the
 * package's "./local" export (see package.json) and is what npm start / the .mcpb manifest
 * actually run; it deliberately does NOT export tool logic itself -- see ../tools/index.ts for
 * that, which a future remote MCP endpoint (a separate, later phase) can import independently of
 * everything in this file.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { tools } from "../tools/index.js";
import { getOrCreateUserId, resolvePlayerLogPath } from "../tools/shared/arena-local-state.js";
import { runChecksAndDeliver } from "../tools/shared/run-checks-and-deliver.js";

// Create the MCP server instance
const server = new McpServer({
  name: "manaramp-mcp",
  version: "2.0.0",
});

for (const tool of tools) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler as any);
}

// --- Start the server over stdio ---
// Guarded so this file can also be `import`ed by tests without starting a stdio server
// (which would hang waiting on a transport that isn't there in a test context).
// MUST use pathToFileURL, not a plain `file://${process.argv[1]}` string concat --
// on Windows process.argv[1] is a backslash path ('C:\Users\...') while import.meta.url
// is a proper file:// URL ('file:///C:/Users/...'); string concat never matches, which
// silently skips server.connect() entirely -- the server starts and accepts the stdio
// pipe but never responds to anything, hanging until the client times out and cancels.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Exported for tests only -- not part of the MCP tool surface.
export { runChecksAndDeliver, getOrCreateUserId, resolvePlayerLogPath };
