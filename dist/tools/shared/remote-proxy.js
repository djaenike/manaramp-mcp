import { callRemoteTool } from "./remote-client.js";
function toRemoteProxy(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args) => {
      try {
        const result = await callRemoteTool(tool.name, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `${tool.name} failed: ${e.message}` }] };
      }
    }
  };
}
export {
  toRemoteProxy
};
