import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { localTools } from "../tools/index.js";
const server = new McpServer({
  name: "manaramp-mcp",
  version: "3.0.0"
});
for (const tool of localTools) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
