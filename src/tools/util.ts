import bigInt from "big-integer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { NotLoggedInError } from "../telegram.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const text = (value: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

export function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; errorMessage?: string; seconds?: number; code?: number };
  if (e?.name === "FloodWaitError" || (e?.errorMessage ?? "").startsWith("FLOOD_WAIT")) {
    return `Telegram rate limit: wait ${e.seconds ?? "a few"} seconds before retrying (${e.errorMessage}).`;
  }
  if (err instanceof NotLoggedInError) return err.message;
  if (e?.errorMessage) return `Telegram error ${e.errorMessage}${e.code ? ` (${e.code})` : ""}: ${e.message}`;
  return e?.message ?? String(err);
}

/**
 * Registers a tool whose handler may throw. Errors become MCP error results
 * with a message the agent can act on instead of a bare stack trace.
 */
export function tool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: Shape; destructive?: boolean },
  handler: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  server.registerTool(
    `telegram_${name}`,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: meta.inputSchema,
      annotations: {
        destructiveHint: meta.destructive ?? false,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    (async (args: Record<string, unknown>) => {
      try {
        return text(await handler(args));
      } catch (err) {
        return { ...text(describeError(err)), isError: true };
      }
    }) as never,
  );
}

/**
 * Chat references arrive as strings. Numeric strings become big integers so the
 * library treats them as ids rather than usernames; everything else passes
 * through ("@name", "+4479...", "me", "https://t.me/...").
 */
export function peer(chat: string): string | bigInt.BigInteger {
  const trimmed = chat.trim();
  return /^-?\d+$/.test(trimmed) ? bigInt(trimmed) : trimmed;
}

export function requireConfirm(confirm: boolean | undefined, action: string): void {
  if (!confirm) {
    throw new Error(`${action} is irreversible. Call again with confirm: true once the user has agreed.`);
  }
}
