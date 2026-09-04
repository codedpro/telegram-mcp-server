#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { disconnect } from "./telegram.js";

const server = new McpServer({
  name: "telegram-mcp-server",
  version: "0.2.0",
});

registerTools(server);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await disconnect();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
