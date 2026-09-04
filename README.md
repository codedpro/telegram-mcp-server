# Telegram MCP Server

**Give any AI agent full access to your Telegram account.** An MCP (Model Context Protocol) server that lets Claude Code, Claude Desktop, Cursor, Codex, Windsurf, or any MCP-compatible agent log in as you, read every chat, and act on your behalf: send, edit, delete, forward, react, download and upload media, manage contacts and members, and call any MTProto method directly.

Built on MTProto via [teleproto](https://www.npmjs.com/package/teleproto) (the maintained GramJS fork), so it works with your **real account** - every chat, group, and channel you are in - not just a bot.

## Why

Bot API bots only see chats you explicitly add them to. This server signs in as *you*, so an agent can answer "what did the team decide in the design channel yesterday?", triage your unread DMs, or post a build result to the chat you actually use - without you leaving your editor.

## Quick start

```bash
git clone https://github.com/codedpro/telegram-mcp-server
cd telegram-mcp-server
npm install
cp .env.example .env
npm run build
```

Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from <https://my.telegram.org> → *API development tools* and put them in `.env`. Those identify the app, not your account.

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

### Log in through the agent

Tell the agent "log in to my Telegram". It walks you through it step by step:

1. It asks for your phone number and calls `telegram_login_start`.
2. Telegram sends you a code (to the app on another device, or by SMS). You give it to the agent, which calls `telegram_login_code`.
3. If you use two-step verification, the agent asks for that password and calls `telegram_login_password`. It gets your hint.

That is it. The session is saved to `~/.telegram-mcp-server/session` (owner-only permissions) and reused on every start. `telegram_login_status` tells the agent where things stand at any time.

Prefer not to type the code and password into an agent conversation? Run `npm run login` in a terminal instead. It saves to the same file.

## Tools

All tools are prefixed `telegram_`.

| Group | Tools |
| --- | --- |
| Login | `login_status`, `login_start`, `login_code`, `login_password`, `logout` |
| Accounts | `list_accounts`, `switch_account` |
| Account | `whoami`, `list_sessions`, `update_profile` |
| Chats | `list_chats` (filter by dm/group/channel/bot, unread, archive), `get_chat`, `resolve_peer`, `get_members`, `search_chats`, `join_chat`, `leave_chat`, `create_group`, `create_channel`, `mark_read`, `pin_message`, `delete_history` |
| Messages | `get_messages` (paging, media filters), `get_message`, `get_message_by_link`, `get_replies`, `search_messages`, `send_message` (reply, markdown/HTML, silent, schedule), `edit_message`, `delete_messages`, `forward_messages`, `react` |
| Media | `download_media`, `send_file` |
| Contacts | `list_contacts`, `add_contact`, `block_user`, `unblock_user`, `get_common_chats` |
| Folders & scans | `list_folders`, `scan_folder`, `list_scans`, `read_scan` |
| Raw MTProto | `search_methods`, `describe_method`, `raw_request` |

Chats are referenced by numeric id (e.g. `-1001234567890`), `@username`, phone number, or `me`.

## Saved accounts

Every login is saved by name under `~/.telegram-mcp-server/sessions/`, so you log in once per account and never again. `telegram_list_accounts` shows what is stored and which is active. `telegram_switch_account` changes accounts with no login code.

To add a second account, pass a name when you start the login:

```jsonc
// telegram_login_start
{ "phone": "+447700900123", "account": "work" }
```

A session saved by an older version is migrated to the name `default` automatically.

## Folder scans

Telegram chat folders (the tabs above your chat list) are the natural unit for "watch these channels". `telegram_scan_folder` reads every chat in one, over a window of days, and classifies each post as SEO, AI, Web, or Software. It also marks whether a post is an employer opening, someone advertising their own services, or already taken.

```jsonc
// telegram_scan_folder
{ "folder": "freelance", "days": 3 }
```

The result is written to `data/scans/<timestamp>-<folder>.json`. A later session reads it back with `telegram_list_scans` and `telegram_read_scan` without touching Telegram, and `onlyNew: true` returns just what has appeared since the previous scan of that folder.

Scans hold real message text, so `data/` is gitignored. Override the location with `TELEGRAM_SCAN_DIR`.

### Anything else: raw MTProto

If a curated tool does not cover it, the agent can call any of the 800+ MTProto methods:

```jsonc
// telegram_raw_request
{
  "method": "messages.GetHistory",
  "params": { "peer": "@durov", "limit": 5 }
}
```

- Peer parameters accept `@username`, a numeric id, or `me`.
- `long` values accept numbers or numeric strings, `bytes` accept base64.
- Nested TL objects are JSON objects with a `"_"` key naming the constructor, e.g. `{"_": "ReactionEmoji", "emoticon": "👍"}`.
- `telegram_describe_method` returns every parameter with its type, and `telegram_search_methods` finds methods by name.

## Safety

**Once logged in, the agent can do anything you can.** That is the point, and it is also the risk. Three things are in place:

- **Destructive tools require `confirm: true`.** Delete messages, delete history, leave chat, block user, and logout refuse to run unless the agent passes it, so it has to state intent explicitly.
- **Optional write allowlist.** Set `TELEGRAM_WRITE_ALLOWLIST=me,@my_test_group` to restrict sending, editing, deleting, forwarding, and reacting to those chats. Unset means unrestricted. It does not gate `telegram_raw_request`.
- **The session files are your accounts.** Anyone holding one is logged in as you, with no second factor. They are stored outside the repo with owner-only permissions. Revoke it from Telegram → Settings → Devices if it ever leaks, or ask the agent to run `telegram_logout`.

Also worth knowing:

- **Your login code and 2FA password pass through the agent's context** when you log in through it. Use `npm run login` if you would rather they did not.
- **Automating a personal account is against Telegram's ToS if you spam with it.** Personal, low-volume, human-paced use is what userbots have always been used for and is broadly fine; blasting messages will get the account limited or banned. If you only need a bot identity, use the Bot API instead.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | yes | App credentials from my.telegram.org |
| `TELEGRAM_SESSION` | no | Session string; overrides the session file |
| `TELEGRAM_SESSION_FILE` | no | Base path for the session store (sessions live in a `sessions/` folder beside it) |
| `TELEGRAM_ACCOUNT` | no | Account name to start with, overriding the saved active one |
| `TELEGRAM_SCAN_DIR` | no | Where folder scans are written (default `data/scans`) |
| `TELEGRAM_DOWNLOAD_DIR` | no | Where `download_media` saves files (default `~/.telegram-mcp-server/downloads`) |
| `TELEGRAM_WRITE_ALLOWLIST` | no | Comma-separated chats the agent may write to; unset = all |

## Roadmap

- [ ] Real-time updates: let the agent subscribe to new messages
- [ ] Forum topics and folders as curated tools
- [ ] `npx` install without cloning
