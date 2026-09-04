import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loginCode, loginPassword, loginStart, loginStatus, logout } from "../auth.js";
import { requireConfirm, tool } from "./util.js";

export function register(server: McpServer): void {
  tool(
    server,
    "login_status",
    {
      title: "Login status",
      description:
        "Reports whether the server is logged in to Telegram and, if not, which login step comes next. Call this first.",
      inputSchema: {},
    },
    () => loginStatus(),
  );

  tool(
    server,
    "login_start",
    {
      title: "Login step 1: send code",
      description:
        "Starts logging in to a Telegram account. Ask the user for their phone number with country code (e.g. +447700900123), then call this. Telegram sends a login code to their app or by SMS.",
      inputSchema: {
        phone: z.string().min(5).describe("Phone number with country code"),
        forceSms: z.boolean().optional().describe("Ask Telegram to send the code by SMS instead of to the app"),
        account: z.string().optional().describe("Name to save this account under (e.g. work). Defaults to the active account slot."),
      },
    },
    ({ phone, forceSms, account }) =>
      loginStart(phone as string, forceSms as boolean | undefined, account as string | undefined),
  );

  tool(
    server,
    "login_code",
    {
      title: "Login step 2: submit code",
      description:
        "Submits the login code the user received. Either completes login or reports that a two-step verification password is required.",
      inputSchema: { code: z.string().min(3).describe("The login code the user received") },
    },
    ({ code }) => loginCode(code as string),
  );

  tool(
    server,
    "login_password",
    {
      title: "Login step 3: 2FA password",
      description:
        "Submits the user's two-step verification (cloud) password. Only needed when telegram_login_code reported password_needed.",
      inputSchema: { password: z.string().min(1) },
    },
    ({ password }) => loginPassword(password as string),
  );

  tool(
    server,
    "logout",
    {
      title: "Log out",
      description: "Terminates a session on Telegram and deletes its saved session file. Defaults to the active account. Requires confirm: true.",
      inputSchema: { confirm: z.boolean().optional(), account: z.string().optional() },
      destructive: true,
    },
    ({ confirm, account }) => {
      requireConfirm(confirm as boolean | undefined, "Logging out");
      return logout(account as string | undefined);
    },
  );
}
