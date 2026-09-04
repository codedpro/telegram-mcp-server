import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeMethod, invokeRaw, searchMethods } from "../raw.js";
import { getAuthorizedClient } from "../telegram.js";
import { tool } from "./util.js";

export function register(server: McpServer): void {
  tool(
    server,
    "search_methods",
    {
      title: "Search MTProto methods",
      description:
        "Finds raw MTProto methods by name substring (e.g. 'GetHistory', 'channels.', 'stories'). Use with telegram_describe_method and telegram_raw_request for anything the curated tools do not cover.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, limit }) => searchMethods(query as string, limit as number),
  );

  tool(
    server,
    "describe_method",
    {
      title: "Describe MTProto method",
      description: "Returns the parameters (name, TL type, optional) and result type of a raw MTProto method.",
      inputSchema: { method: z.string().min(1).describe("e.g. messages.GetHistory") },
    },
    async ({ method }) => describeMethod(method as string),
  );

  tool(
    server,
    "raw_request",
    {
      title: "Raw MTProto request",
      description:
        "Calls any MTProto method directly. params is a JSON object keyed by parameter name. Peer parameters (InputPeer/InputUser/InputChannel) accept '@username', a numeric id, or 'me'. long values accept numbers or numeric strings. bytes accept base64. Nested TL objects are objects with a \"_\" key naming the constructor. Check telegram_describe_method first. This can do anything the account can do, including irreversible actions.",
      inputSchema: {
        method: z.string().min(1).describe("e.g. messages.GetHistory"),
        params: z.record(z.unknown()).default({}),
      },
      destructive: true,
    },
    async ({ method, params }) =>
      invokeRaw(await getAuthorizedClient(), method as string, (params ?? {}) as Record<string, unknown>),
  );
}
