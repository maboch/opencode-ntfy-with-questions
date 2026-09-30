# opencode-ntfy-with-questions

OpenCode 2.x plugin that publishes notifications to [ntfy](https://ntfy.sh)
(ntfy.sh or a self-hosted instance) when:

- a session finishes its run and becomes idle (`session.status` with
  `status.type === "idle"`),
- a session reports an error (`session.execution.failed`),
- opencode asks you to approve a permission (`permission.asked`),
- the agent invokes the built-in `question` tool.

Subagent (child session) idle/error chatter is suppressed by default so only
notifications that need a human land on your phone. The only runtime dependency
is the OpenCode v2 plugin SDK `@opencode/plugin` (pinned to `2.0.20`); HTTP is
the platform `fetch` and the rest is Node/Bun built-ins.

## Requirements

- OpenCode >= 2.0.20 < 3.0.0 (the `engines.opencode` range)
- Node.js >= 20 or Bun (for development tooling only)

The legacy 0.1.2 line targets OpenCode >= 1.18.25 and does not need upgrading on
its own. See [Versioning and install strategy](#versioning-and-install-strategy).

## Versioning and install strategy

The package has one npm name, `opencode-ntfy-with-questions`, with two
incompatible lines:

| Line | Version | OpenCode | opencode config key |
| --- | --- | --- | --- |
| v1 | `0.1.2` | 1.x (>= 1.18.25) | `plugin` |
| v2 | `0.2.1` | 2.x (>= 2.0.20 < 3.0.0) | `plugins` |

npm dist-tags are mutable pointers, not a built-in "previous version"
mechanism. The release plan points `prev` at the immutable `0.1.2` and `latest`
at the new `0.2.1`:

| dist-tag | release plan | currently on npm |
| --- | --- | --- |
| `latest` | `0.2.1` | `0.1.2` only |
| `prev` | `0.1.2` | not created yet |

At the time of writing the npm registry still has only `latest` = `0.1.2`, no
`prev` tag, and `0.2.1` is not published. So:

- `opencode-ntfy-with-questions@0.1.2` works now (an exact, immutable pin).
- `opencode-ntfy-with-questions@0.2.1` works only after the 0.2.1 publish.
- `opencode-ntfy-with-questions@prev` works only after the `prev` tag is
  created.

There is no automatic `prev` tag; creating it is part of the release procedure.

### OpenCode 2.x (v2, `0.2.1`)

The following examples are for after the 0.2.1 publication; `@latest` resolves
to the v1 line until then. Add the plugin to the `plugins` array of your
opencode config (`opencode.json` or `~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode-ntfy-with-questions@latest"]
}
```

Pin the exact version instead for a deterministic install (available after
publish):

```json
{
  "plugins": ["opencode-ntfy-with-questions@0.2.1"]
}
```

CLI alternative:

```sh
opencode plugin add opencode-ntfy-with-questions@0.2.1
# or, after publish: opencode plugin add opencode-ntfy-with-questions@latest
```

### OpenCode 1.x (v1, `0.1.2`)

The v1 line uses the `plugin` key (singular):

```json
{
  "plugin": ["opencode-ntfy-with-questions@0.1.2"]
}
```

This exact pin works today. After the release creates the `prev` tag you can
also use:

```json
{
  "plugin": ["opencode-ntfy-with-questions@prev"]
}
```

After installing, create the plugin config file described below and **restart
opencode**. OpenCode only loads plugins and their configuration at startup -
config or plugin changes are not picked up until the next restart.

### Do not mix `plugin` and `plugins`

Never put both `plugin` and `plugins` entries in the same config, and never add
two entries for this package. Use the key that matches your OpenCode major
version with a single specifier.

### What changes after the 0.2.1 publish

A bare `opencode-ntfy-with-questions` (and the `latest` tag) currently resolves
to `0.1.2`. After 0.2.1 is published with `--tag latest`, the bare name and
`latest` resolve to the OpenCode 2.x line. A v1 user who still runs OpenCode 1.x
must therefore pin `@0.1.2` or `@prev` before upgrading the package, otherwise
OpenCode 1.x will try to load the v2 plugin. The existing `0.1.2` artifact is
never modified, unpublished or republished, and its git tag `v0.1.2` is never
moved.

## Migrating from 0.1.2 (v1) to 0.2.1 (v2)

The v2 plugin keeps the same external configuration contract. Moving from v1 to
v2 also means upgrading OpenCode from 1.x to 2.x and renaming the opencode
config key from `plugin` to `plugins`; apart from that, the configuration file
itself is unchanged:

- Same config file path:
  `$XDG_CONFIG_HOME/opencode/notification-ntfy-with-questions.json`
  (`~/.config/opencode/notification-ntfy-with-questions.json` when
  `XDG_CONFIG_HOME` is unset).
- Same JSON Schema and the same config keys (`enabled`, `events`,
  `suppressSubagents`, `permissionNotificationDelayMs`, `ntfy`). No config file
  rewrite is needed.
- The v2 plugin does not use the plugin-context `options` / `storage` fields as
  a new configuration source; configuration stays in the external JSON file.
- Switch the opencode config from the `plugin` key to `plugins` only when you
  move from OpenCode 1.x to 2.x, and set the specifier to `@latest` or
  `@0.2.1`.
- Restart opencode after the change.

API references:
[plugins](https://opencode.ai/v2/docs/plugins) and
[migrate from v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Remove the old opencode-ntfy.sh plugin

If a previous `opencode-ntfy.sh` plugin is still listed, remove or disable it in
the opencode plugin array. Keeping both this plugin and the old
`opencode-ntfy.sh` entry produces duplicate notifications.

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
  "permissionNotificationDelayMs": 15000,
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
| `permissionNotificationDelayMs` | `15000` | Grace period in ms (integer `0`-`300000`) before a `permission.asked` notification is published. A matching `permission.replied` within the window suppresses it. `0` publishes immediately. |
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

The plugin subscribes once to the global opencode v2 event stream. The stream is
shared across server locations, so the plugin keeps only events whose
`location.directory` exactly equals the plugin's own location directory
(`ctx.location.directory`); events without a matching location are ignored. The
stream is volatile: there is no replay of events missed while disconnected.

Recognized native events:

- `session.created` / `session.deleted` maintain an in-memory
  `sessionID -> parentID` cache. `session.created` carries a flat payload with
  the session ID and an optional `parentID`. `session.deleted` removes the
  entry; a later event for the same session is unknown again and may start a
  fresh fallback lookup.
- Idle: `session.status` where `status.type` is `idle`. This is the only idle
  source; the deprecated `session.idle` event is ignored so a run never produces
  two idle notifications.
- Error: `session.execution.failed`. Only the error `type` and its message are
  used; the transient `session.step.failed` / `session.retry.scheduled` frames
  and the legacy `session.error` event are ignored.
- `permission.asked` uses `action` as the permission name, `resources` as the
  affected patterns and `id` as the request identifier.
- `permission.replied` correlates on the native `requestID` (the same value as
  the `id` on the corresponding ask); there is no legacy fallback.
- `question.*` / `form.*` runtime events are ignored: question notifications
  come exclusively from the `execute.before` tool hook filtered by the exact
  tool name `question`, so one question produces exactly one notification.
- `session.updated` is not emitted in v2 and is ignored if it appears.

On idle / error the cache is consulted first. On a cache miss the plugin calls
the native session lookup (`ctx.session.get`) as a fallback and records the
result. Suppression only happens when a parent session is known to exist.

- Fallback lookups are bounded: each lookup races the native session lookup
  against a fixed 5000 ms deadline, and concurrent misses for the same session
  share one lookup. A timeout is treated like any lookup failure.
- If the fallback lookup fails (API error, unknown session, transport failure,
  deadline), the plugin fails open: it sends the notification and logs a
  sanitized warning that names only the session.
- An error event without a `sessionID` always notifies.
- `permission.asked` notifications are sent for root and child sessions alike,
  but only after a grace period (see below). Question notifications are always
  sent, including from subagents.
- The event stream dispatches each accepted frame without awaiting the publish
  or the subagent classification, so a slow session lookup or ntfy request can
  never delay lifecycle updates or a permission reply.
- Question notifications do await their bounded ntfy publish (at most
  `ntfy.timeoutMs`) because the `execute.before` tool hook awaits them; publish
  failures are logged and swallowed and can never prevent the question tool from
  running.
- OpenCode emits the terminal idle status only after the full run finishes,
  never while a question is waiting for an answer, so idle and question
  notifications do not duplicate each other.

Notification titles contain the project basename (the directory the opencode
instance runs in). Tags are fixed: idle `hourglass_done`, error `warning`,
permission `lock`, question `question`.

### Stream robustness

- On a stream EOF or subscription failure the plugin re-subscribes through one
  cancellable backoff timer with delays of 1, 2, 4, 8, 16 and then 30 seconds.
  The timer never keeps the process alive.
- Plugin cleanup aborts the stream, cancels the backoff timer and every pending
  permission timer, and prevents any future publish. An HTTP request already in
  flight cannot be retracted.
- Safety bounds: at most 64 concurrent idle/error notifications, 64 concurrent
  ntfy publishes and 512 pending permission timers. When a bound is reached, new
  notifications are dropped with a fixed secret-safe warning; lifecycle handling
  and permission replies stay responsive.

### Permission notification grace period

A `permission.asked` notification is delayed by `permissionNotificationDelayMs`
(15000 ms by default). If a matching `permission.replied` event arrives within
that window, the pending notification is cancelled and nothing is published.
OpenCode may auto-approve a request it did ask about, and the user may answer
quickly in the terminal; a `permission.replied` then arrives before the grace
period elapses and the push notification would be noise. This is distinct from
permissions already allowed by a standing rule: those never emit a
`permission.asked` event at all, so no notification is scheduled for them.

- Correlation uses the permission request ID, never the session ID, so several
  concurrent requests in the same session are tracked independently.
- A duplicate `permission.asked` for a request that is already pending is
  ignored: the notification is neither duplicated nor rescheduled.
- A reply that arrives before its ask event is remembered (up to 512 request
  IDs) and still suppresses the notification once the ask is seen.
- A request without a usable ID is still notified after the grace period, but
  it cannot be correlated with a reply. Such pending timers are tracked and
  cancelled when the plugin is disposed.
- A reply after the grace period cannot retract a notification that was already
  sent; it is too late by design.
- This is a heuristic. OpenCode does not expose its auto-approve mode to
  plugins, so the plugin cannot know in advance whether a request will be
  answered automatically and relies purely on the reply event arriving in time.
- Set `permissionNotificationDelayMs` to `0` to publish immediately without a
  grace timer. The publish starts as soon as the `permission.asked` frame is
  seen, but there is no returned v2 event hook that awaits it: the global event
  stream keeps dispatching non-blocking, so a slow publish never delays
  lifecycle updates or a permission reply. Only the `question` tool hook awaits
  its bounded publish.

## What data is transmitted

ntfy requests are JSON POSTs to the configured base URL with the topic in the
body (never in the URL), `Content-Type: application/json`, optional
`Authorization: Bearer ...`, and body fields `topic`, `title`, `message`,
`priority`, `tags`.

- Idle: the project name, the session ID, and a completion/waiting message.
- Error: the project name, the session ID (when present), and the native error
  `type` plus its `message` only. Stacks, response bodies, headers and provider
  IDs are never included.
- Permission (after the grace period): the project name, the session ID (when
  present), the permission type and the requested patterns.
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
  (or another notification plugin) active, or two entries for this package.
  Remove the extra entry.
- **Duplicate question notifications**: only the v2 `execute.before` tool hook
  (the v1 `tool.execute.before` hook) is used. If you see two, another plugin
  is also watching the `question` tool.
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
bun run test           # vitest
bun run build          # emit dist/ (ESM + declarations)
npm pack --dry-run     # inspect the published package contents
```

The package publishes `dist/`, the JSON Schema, `README.md` and `LICENSE`.
Source files import the OpenCode v2 plugin SDK `@opencode/plugin` (pinned to
`2.0.20`), the documented runtime dependency; everything else the runtime uses
is the platform `fetch` or Node/Bun built-ins. Lint, TypeScript, vitest and the
AJV-based schema checks live in `devDependencies`.

Run the commands above before every release; an installed-tarball smoke test is
also required before publishing.

## Releasing

Publish from the `main` branch and run the checks in this order. Create the
`prev` tag BEFORE publishing 0.2.1 so the legacy alias (`prev` -> `0.1.2`)
exists before `latest` moves to 0.2.1. Creating `prev` does NOT protect
`latest` or bare-name users: after the publish they resolve to the v2 line, so
every v1 user must explicitly switch to `@prev` or the exact `@0.1.2` pin
beforehand. Run:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
npm pack --dry-run
npm dist-tag add opencode-ntfy-with-questions@0.1.2 prev
npm publish --tag latest          # publishes the 0.2.1 manifest
npm dist-tag ls opencode-ntfy-with-questions
npm view opencode-ntfy-with-questions@prev version
npm view opencode-ntfy-with-questions@latest version
```

Expected after a successful publish: `prev` = `0.1.2`, `latest` = `0.2.1`.
Dist-tags are mutable pointers and are not created automatically; published
versions are immutable. Do not republish or unpublish `0.1.2`, and do not move
the `v0.1.2` git tag. To work on the legacy line, check out the `v0.1.2` tag in
a separate clone.

## License

MIT - see [LICENSE](LICENSE).
