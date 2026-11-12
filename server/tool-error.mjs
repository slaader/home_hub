// For a plugin tool's run(): an error whose message goes back to the agent as the tool result (isError: true;
// server/mcp.mjs). Anything else a tool throws is reported as an internal error. No imports: the plugin API
// re-exports it (server/plugin-api.mjs).
export const toolError=message=>Object.assign(new Error(message),{toolError:true});
