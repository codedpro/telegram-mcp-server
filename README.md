# Telegram MCP Server

**Give any AI agent access to your Telegram account.** An MCP (Model Context Protocol) server that lets Claude Code, Claude Desktop, Cursor, Codex, Windsurf, or any MCP-compatible agent read, search, and send Telegram messages on your behalf.

Built on MTProto via [teleproto](https://www.npmjs.com/package/teleproto) (the maintained GramJS fork), so it works with your **real account** — every chat, group, and channel you are in — not just a bot.

<!-- TODO: drop a 15-second demo GIF here. It is the single highest-leverage thing in this README. -->

## Why

Bot API bots only see chats you explicitly add them to. This server signs in as *you*, so an agent can answer "what did the team decide in the design channel yesterday?", triage your unread DMs, or post a build result to the chat you actually use — without you leaving your editor.

## Quick start

```bash
git clone https://github.com/codedpro/telegram-mcp-server
cd telegram-mcp-server
npm install
cp .env.example .env
```

1. Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from <https://my.telegram.org> → *API development tools*, and put them in `.env`.
2. Log in once and copy the printed session string into `.env`:

   ```bash
   npm run login
   ```

3. Build it:

   ```bash
   npm run build
   ```

### Connect it to Claude Code

```bash
claude mcp add telegram -- node /absolute/path/to/telegram-mcp-server/dist/index.js
```

### Connect it to Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp-server/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `telegram_whoami` | Which account is signed in, and what it is allowed to do |
| `telegram_list_chats` | Recent dialogs with ids, kind, and unread counts |
| `telegram_get_messages` | Recent messages from one chat |
| `telegram_search_messages` | Full-text search in one chat or across all of them |
| `telegram_send_message` | Send a message (allowlisted chats only) |

## Safety

**Writes are off by default.** `telegram_send_message` refuses every chat that is not in `TELEGRAM_WRITE_ALLOWLIST`, so the default install is read-only. Start narrow:

```env
TELEGRAM_WRITE_ALLOWLIST=me,@my_test_group
```

Two things worth knowing before you run this:

- **The session string is your account.** Anyone holding it is logged in as you, with no second factor. It is gitignored here — keep it that way, and revoke it from Telegram → Settings → Devices if it ever leaks.
- **Automating a personal account is against Telegram's ToS if you spam with it.** Personal, low-volume, human-paced use is what userbots have always been used for and is broadly fine; blasting messages will get the account limited or banned. If you only need a bot identity, use the Bot API instead — it is the supported path.

## Roadmap

- [ ] Read/unread state and mark-as-read
- [ ] Media: download and send files, photos, voice notes
- [ ] Streaming: push new messages to the agent as they arrive
- [ ] `npx telegram-mcp-server` with zero-config setup
- [ ] Optional Bot API mode for people who do not want a userbot

## License

MIT
