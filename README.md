# opencode-ntfy-with-questions

OpenCode 1.x plugin that publishes notifications to [ntfy](https://ntfy.sh)
(ntfy.sh or a self-hosted instance) when:

- a session finishes its run and becomes idle (`session.idle`),
- a session reports an error (`session.error`),
- opencode asks you to approve a permission (`permission.asked`),
- the agent invokes the built-in `question` tool to ask you something
  (`question.asked`).

Subagent (child session) idle/error chatter is suppressed by default so only
notifications that need a human land on your phone. Zero runtime dependencies;
it only uses the platform `fetch` and Node/Bun built-ins.

## Requirements

- OpenCode >= 1.18.25
- Node.js >= 20 or Bun (for development tooling only)

## Installation

Add the plugin to your opencode configuration (`opencode.json` or
`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-ntfy-with-questions"]
}
```

Create the plugin config file described below, then **restart opencode**.
OpenCode only loads plugins and their configuration at startup - config or
plugin changes are not picked up until the next restart.

### Remove the old opencode-ntfy.sh plugin

If a previous `opencode-ntfy.sh` plugin is still listed, remove or disable it in
the OpenCode `plugin` array (`opencode.json`). Keeping both this plugin and the
old `opencode-ntfy.sh` plugin entry produces duplicate notifications.

## Configuration

The plugin reads a separate config file that is intentionally NOT
backward-compatible with any older `notification-ntfy.json`:

- `$XDG_CONFIG_HOME/opencode/notification-ntfy-with-questions.json`
- when `XDG_CONFIG_HOME` is not set: `~/.config/opencode/notification-ntfy-with-questions.json`

The JSON Schema for editor validation is packaged with the plugin at
`notification-ntfy-with-questions.schema.json` (also exported as
`opencode-ntfy-with-questions/notification-ntfy-with-questions.schema.json`).

### Minimal example (ntfy.sh)

```json
{
  "ntfy": {
    "topic": "my-opencode-alerts"
  }
}
```

### Complete example (hosted)

```json
{
  "$schema": "https://raw.githubusercontent.com/maboch/opencode-ntfy-with-questions/main/notification-ntfy-with-questions.schema.json",
  "enabled": true,
  "events": {
    "session.idle": true,
    "session.error": true,
    "permission.asked": true,
    "question.asked": true
  },
  "suppressSubagents": {
    "session.idle": true,
    "session.error": true
  },
  "ntfy": {
    "server": "https://ntfy.sh",
    "topic": "my-opencode-alerts",
    "token": "tk_my_access_token",
    "priority": "default",
    "timeoutMs": 5000
  }
}
```

### Self-hosted example (with auth via environment variable)

```json
{
  "ntfy": {
    "server": "https://ntfy.example.com",
    "topic": "opencode",
    "token": "{env:NTFY_TOKEN}"
  }
}
```

### Secrets from files

```json
{
  "ntfy": {
    "topic": "opencode",
    "token": "{file:~/secrets/ntfy-token.txt}"
  }
}
```

`{file:...}` paths may be absolute, start with `~/`, or be relative to the
directory containing the config file. Referenced file content is trimmed and
capped at 16 KiB; the config file itself is capped at 64 KiB.

Substitutions are full-value only: a valid `{env:NAME}` or `{file:path}`
reference must be the entire JSON string value. Interpolation such as
`"prefix-{env:NAME}"`, multiple references in one string, or empty/malformed
references are rejected at startup with a fixed, secret-safe error; ordinary
strings that merely contain unrelated braces are left untouched.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to keep the plugin loaded but send nothing. |
| `events` | all `true` | Toggles per notification kind: `session.idle`, `session.error`, `permission.asked`, `question.asked`. |
| `suppressSubagents` | both `true` | Suppress `session.idle` / `session.error` notifications for known subagent sessions. |
| `ntfy.server` | `https://ntfy.sh` | Base URL, http(s), DNS/IPv4/localhost/bracketed-IPv6 host, optional canonical port, optional reverse-proxy path prefix. Credentials, whitespace, query strings and fragments are rejected. May instead be one full-value `{env:...}`/`{file:...}` reference. |
| `ntfy.topic` | (required) | 1-64 characters from `A-Z a-z 0-9 - _`, or one full-value reference. |
| `ntfy.token` | none | Sent as `Authorization: Bearer ...`. Never logged. A plain literal without reference markers, or one full-value reference. |
| `ntfy.priority` | `default` | One of `min`, `low`, `default`, `high`, `max`. |
| `ntfy.timeoutMs` | `5000` | Per-publish deadline, 1-60000 ms. Only bounds ntfy publishing, not session lookups. |

Unknown properties anywhere in the file are rejected at startup, both by the
runtime validator and by the JSON Schema. A missing config file, invalid JSON,
an unresolved `{env:...}` / `{file:...}` reference, or invalid required fields
fail plugin initialization with an actionable error message. Error messages
never print substituted values, secrets or file contents - only key names,
variable names and paths.

## Event and suppression behavior

- `session.created` / `session.updated` / `session.deleted` events maintain an
  in-memory `sessionID -> parentID` cache. `session.deleted` removes the entry;
  a later event for the same session is unknown again and may start a fresh
  fallback lookup.
- On `session.idle` / `session.error` the cache is consulted first. On a cache
  miss the plugin calls `session.get` on the opencode client as a fallback and
  records the result. Suppression only happens when a parent session is known
  to exist.
- Fallback lookups are bounded: each lookup races `session.get` against a fixed
  5000 ms deadline, and concurrent misses for the same session share one
  lookup. A timeout is treated like any lookup failure.
- If the fallback lookup fails (API error, unknown session, transport failure,
  deadline), the plugin fails open: it sends the notification and logs a
  sanitized warning that names only the session.
- An error event without a `sessionID` always notifies.
- `permission.asked` and question notifications are always sent, including
  from subagents.
- Question notifications come from the `tool.execute.before` hook filtered by
  the exact tool name `question`. Runtime `question.asked` events are ignored,
  so one question produces exactly one notification. Publishing the
  notification is awaited, so a question notification can delay the
  `tool.execute.before` hook by at most `ntfy.timeoutMs`; publish failures are
  logged and swallowed and can never prevent the question tool from running.
- OpenCode emits `session.idle` only after the full run finishes, never while
  a question is waiting for an answer, so idle and question notifications do
  not duplicate each other.

Notification titles contain the project basename (the directory the opencode
instance runs in). Tags are fixed: idle `hourglass_done`, error `warning`,
permission `lock`, question `question`.

## What data is transmitted

ntfy requests are JSON POSTs to the configured base URL with the topic in the
body (never in the URL), `Content-Type: application/json`, optional
`Authorization: Bearer ...`, and body fields `topic`, `title`, `message`,
`priority`, `tags`.

- Idle: the project name, the session ID, and a completion/waiting message.
- Error: the project name, the session ID (when present), and the error name
  plus its message (`data.message` when available). Stacks, response bodies,
  headers and provider IDs are never included.
- Permission: the project name, the session ID (when present), the permission
  type and the requested patterns.
- Question: the project name plus every question with its header, its options
  (labels and descriptions) and whether multiple answers are allowed. If the
  question payload is malformed, a generic "open the conversation" message is
  sent instead of failing the tool call.

The title is bounded to 1024 bytes and the message to 4096 UTF-8 bytes with
deterministic UTF-8-safe truncation; unsafe control characters are removed
from the title. Message content is never placed in HTTP headers.

## Reverse-proxy prefix caveat

If your self-hosted ntfy sits behind a reverse proxy under a path (for example
`https://ntfy.example.com/notify/`), set `ntfy.server` to that full base URL
including the prefix. The prefix is preserved and every publish is a JSON POST
to that exact base URL with the topic in the body. The proxy must route that
path to ntfy and must not strip the JSON body. Do not append the topic to the
URL yourself.

## Troubleshooting

- **No notifications**: restart opencode after changing config or installing
  the plugin. Verify the file name and location (see above). Check opencode's
  log output - plugin and notification problems are logged with the prefix
  `[opencode-ntfy-with-questions]` and never contain your token.
- **Notifications are duplicated**: you still have the old `opencode-ntfy.sh`
  (or another notification plugin) active. Remove it.
- **Duplicate question notifications**: only the `tool.execute.before` route
  is used. If you see two, another plugin is also watching the `question` tool.
- **Subagent notifications still arrive**: the session was never seen by a
  `session.created` event and the fallback lookup could not classify it, or
  `suppressSubagents` is disabled. The plugin logs a classification warning in
  that case.
- **Plugin fails to load**: the config file is missing, not valid JSON,
  references an unset environment variable or unreadable file, or contains an
  invalid field. The error message tells you exactly which key, variable or
  path is at fault; fix it and restart opencode.
- **Config not validated by the editor**: point `$schema` at the packaged
  `notification-ntfy-with-questions.schema.json` (see the complete example).
- **Requests time out**: ntfy is unreachable from your machine or the
  `timeoutMs` budget is too small. Notification failures never crash a
  session and never block the question tool.

## Development

```sh
bun install            # install dev dependencies (frozen lockfile in CI)
bun run lint           # ESLint over src/ and tests/
bun run typecheck      # tsc --noEmit
bun run test           # vitest (config, schema parity, client, registry, plugin)
bun run build          # emit dist/ (ESM + declarations)
npm pack --dry-run     # inspect the published package contents
```

The package publishes `dist/`, the JSON Schema, `README.md` and `LICENSE`.
Source files import `@opencode-ai/plugin` types only - the runtime has zero
dependencies.

## License

MIT - see [LICENSE](LICENSE).
