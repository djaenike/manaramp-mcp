/**
 * tools/types.ts
 * Shared shape for every registered tool definition under tools/. Each tools/*.ts file exports one
 * or more plain objects matching this shape -- name, description, a zod raw shape (the same object
 * literal server.tool(...) previously took as its third argument), and an async handler -- rather
 * than calling server.tool(...) itself. local/index.ts is the only place that actually calls
 * server.tool(...), looping over every definition from tools/index.ts's `tools` array.
 */

import type { z, ZodRawShape } from "zod";

interface McpToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<McpToolResponse>;
}

export type { ToolDefinition, McpToolResponse };
