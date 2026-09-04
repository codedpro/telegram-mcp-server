# Agent-driven login and full-account access

Date: 2026-09-02
Status: approved

## Goal

An MCP agent must be able to log the server into a Telegram account by asking the
human for the phone number, the login code, and the 2FA password one step at a
time, and afterwards do anything the account can do: read every dialog, send,
edit, delete, forward, react, download and upload media, manage contacts and
members, and call any MTProto method the curated tools do not cover.

## Decisions

- **Full access by default.** After login there is no write allowlist.
  `TELEGRAM_WRITE_ALLOWLIST` remains as an optional restriction. Unset means
  unrestricted.
- **Destructive tools take `confirm: true`.** Delete messages, delete history,
  leave chat, block user, and logout refuse to run without it.
- **Session persists to a file.** `~/.telegram-mcp-server/session` (override with
  `TELEGRAM_SESSION_FILE`), directory mode 0700, file mode 0600. The
  `TELEGRAM_SESSION` env var still works and takes precedence when set.
- **App credentials stay in env.** `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`
  identify the application, not the account, and are read from `.env`.
- **Login secrets pass through the agent.** The code and the 2FA password are
  tool arguments, so they enter the agent's context. The README states this.

## Login state machine (`src/auth.ts`)

```
logged_out --login_start(phone)--> code_sent
code_sent  --login_code(code)----> logged_in | password_needed
password_needed --login_password(pw)--> logged_in
any        --logout(confirm)-----> logged_out
```

- `login_start` calls `sendCode`, stores `phoneCodeHash`, reports whether the
  code went to the Telegram app or SMS. If already authorized, it says so.
- `login_code` calls `auth.SignIn`. `SESSION_PASSWORD_NEEDED` moves to
  `password_needed` and returns the password hint. Invalid or expired code keeps
  the stage at `code_sent` with a clear error. Sign-up required is an error.
- `login_password` runs SRP via `computeCheck` and `auth.CheckPassword`.
- On success the session string is saved to the session file.
- `login_status` reports the stage, the signed-in user if any, and where the
  session came from (env, file, none).
- `logout` invalidates the session on Telegram, deletes the file, and resets the
  client.

## Client lifecycle (`src/telegram.ts`, `src/session.ts`)

- `getClient()` connects lazily with the loaded session and never requires
  authorization. Login tools use it.
- `getAuthorizedClient()` additionally requires `isUserAuthorized()`, cached
  after the first true result. Every other tool uses it. When not authorized it
  throws an error telling the agent to call `telegram_login_start`.
- `resetClient()` disconnects and drops the cached client (used by logout).

## Tools

Grouped one file per group under `src/tools/`. Each file exports a
`register(server)` function; `src/tools/index.ts` calls them all.

| Group | Tools |
| --- | --- |
| auth | login_status, login_start, login_code, login_password, logout |
| account | whoami, list_sessions, update_profile |
| chats | list_chats, get_chat, resolve_peer, get_members, search_chats, join_chat, leave_chat, create_group, create_channel, mark_read, pin_message, delete_history |
| messages | get_messages, get_message, search_messages, get_message_by_link, get_replies, send_message, edit_message, delete_messages, forward_messages, react |
| media | download_media, send_file |
| contacts | list_contacts, add_contact, block_user, unblock_user, get_common_chats |
| raw | raw_request, describe_method, search_methods |

All tool names carry the `telegram_` prefix.

Chat arguments are strings: numeric id (including negative supergroup ids),
`@username`, phone number, `me`, or an invite link where noted. Numeric strings
are converted to big integers before being handed to the library.

## Result formatting (`src/format.ts`)

Tools never return raw TL objects. `formatUser`, `formatChat`, `formatDialog`,
and `formatMessage` produce small JSON objects: ids as strings, dates as ISO
8601, media summarized as type plus file name, mime, and size. `toPlain`
converts any TL object for the raw tool: big integers to strings, buffers to
base64, class name under the `_` key, internal fields dropped.

## Raw MTProto access (`src/raw.ts`)

`telegram_raw_request(method, params)`:

1. Look up `method` (for example `messages.GetHistory`, case-insensitive on the
   first letter) in the library's TL definitions, functions only.
2. Convert `params` using the definition's `argsConfig`: `long`, `int128`,
   `int256` accept number or string and become big integers; `bytes` accept
   base64 strings; vectors map element-wise; nested TL objects are JSON objects
   with a `_` key naming the constructor; unknown parameter names are an error
   that lists the valid ones.
3. Fields typed `InputPeer`, `InputUser`, `InputChannel` accept plain strings
   (`@username`, id, `me`) at the top level. The library resolves them. Nested
   objects need a full input peer, which `telegram_resolve_peer` provides.
4. Invoke and return `toPlain(result)`.

`telegram_describe_method` returns parameter names, TL types, and whether each
is optional, plus the result type. `telegram_search_methods` lists methods by
substring so the agent can self-serve.

## Error handling

A shared `run()` wrapper turns thrown errors into MCP error results. Flood
waits report the number of seconds to wait. RPC errors report Telegram's error
code string. The not-logged-in error carries the login instruction.

## Testing

- `npm run typecheck` and `npm run build` must pass.
- Live smoke test: start the server over stdio, list tools, call
  `telegram_login_status`, confirm the not-logged-in guidance, and confirm
  `telegram_describe_method` and `telegram_search_methods` work offline.
- Manual: full login through the agent, list chats, send to `me`, download a
  photo, raw request `users.GetUsers`.

## Out of scope

Real-time updates and event subscriptions, QR-code login, stories, and payments
stay uncovered by curated tools. The raw tool reaches them.

---

## Addendum, 2026-09-03: named accounts and saved scans

Approved after the first login. Two additions.

### Named accounts

Sessions move from a single file to `~/.telegram-mcp-server/sessions/<name>.session`,
with `<name>.json` holding cached identity (id, username, phone) and an `active`
file naming the current account. A session written by the previous version is
renamed to `default` on first read, so an existing login survives the upgrade.

- `telegram_login_start` takes an optional `account` name, so a second account is
  added without disturbing the first.
- `telegram_list_accounts` reports what is stored and which is active.
- `telegram_switch_account` changes the active account and reconnects, with no
  login code, because the session is already saved.
- `telegram_logout` takes an optional `account` and defaults to the active one.
- `TELEGRAM_ACCOUNT` overrides the active account at startup.
- Account metadata is backfilled on the next `telegram_login_status` when a
  migrated session has none.

### Saved folder scans

`telegram_scan_folder` reads every chat in a Telegram chat folder over a window
of days and classifies each post against four regex category sets (SEO, AI, Web,
Software). It additionally flags each post as:

- `isJob`: employer language (needed, hiring, salary, budget, contract)
- `isProvider`: self-promotion language (portfolio, at your service, my services)
- `isClosed`: taken or expired (assigned, solved, expired)

An "open job" is `isJob && !isProvider && !isClosed`. The full record, including
message text and deep links, is written to `data/scans/<timestamp>-<folder>.json`.

- `telegram_list_scans` lists prior scans newest first.
- `telegram_read_scan` filters a saved scan by category and open-job status
  without any network call.
- `onlyNew: true` on a scan diffs against the previous scan of the same folder
  and returns only unseen posts.
- `telegram_list_folders` exposes the folder list that these depend on.

`data/` is gitignored: scans contain real message text. `TELEGRAM_SCAN_DIR`
overrides the location.
