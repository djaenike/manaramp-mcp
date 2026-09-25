/**
 * tools/shared/remote-proxy.ts
 *
 * Wraps a Mongo-backed primary ToolDefinition (currently only manage_deck -- the 3 internal-only
 * tools in tools/internal-tools.ts are never proxied, see tools/index.ts's header) into a LOCAL one
 * with the exact same name/description/inputSchema, but a handler that calls
 * manaramp.com/mcp over HTTP (via remote-client.ts) instead of running the real ctx-based handler
 * against a Db. local/index.ts registers these proxies alongside the two genuinely local Arena
 * tools (2026-09-17) so the .mcpb is a complete, self-sufficient MCP server on its own -- a Claude
 * Desktop user gets deck building AND Arena assistance from one install, without also needing to add
 * manaramp.com/mcp as a separate remote connector. That remote endpoint still exists and still
 * matters for every OTHER client (ChatGPT, Grok, Gemini, ...) that has no desktop-extension
 * mechanism at all -- this doesn't replace it, it's a second way to reach the SAME tool logic.
 *
 * Same MANARAMP_API_KEY as the Arena tools' own remote calls (manifest.json's user_config) -- if
 * it's not configured, every proxied tool call fails with remote-client.ts's own clear message
 * rather than silently doing nothing.
 */

import type { z, ZodRawShape } from "zod";
import { callRemoteTool } from "./remote-client.js";
import type { ToolDefinition } from "../types.js";

function toRemoteProxy<Shape extends ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args: z.infer<z.ZodObject<Shape>>) => {
      try {
        const result = await callRemoteTool(tool.name, args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `${tool.name} failed: ${e.message}` }] };
      }
    },
  };
}

export { toRemoteProxy };
