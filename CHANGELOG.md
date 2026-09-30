# Changelog

All notable changes to `opencode-ntfy-with-questions` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package follows semantic versioning; the v1 and v2 lines are intentionally
incompatible (see Version and install separation below).

## [Unreleased] - 0.2.1

Not published yet.

### Changed (breaking)

- Migrated the plugin to the native OpenCode v2 plugin API:
  `Plugin.define({ id, setup })`, with the runtime dependency
  `@opencode/plugin` pinned to `2.0.20`.
- Requires `engines.opencode` `>=2.0.20 <3.0.0` (OpenCode 2.x). The legacy
  0.1.2 line keeps `engines.opencode` `>=1.18.25` and is unchanged.
- Consumes the global OpenCode v2 event stream once and keeps only events whose
  `location.directory` exactly matches the plugin location. The stream is
  volatile: missed events are not replayed.
- Idle notifications now come from `session.status` with `status.type === "idle"`
  (the sole idle source). Errors come from `session.execution.failed` using only
  the error type and message.
- Permission correlation uses the native `requestID` from `permission.replied`
  (matching the `id` on `permission.asked`), preserving request-based correlation.
- Question notifications come exclusively from the `execute.before` tool hook
  filtered by the exact tool name `question`.
- Deprecated or transient native routes are ignored: `session.idle`,
  `session.error`, `session.updated`, `session.step.failed`,
  `session.retry.scheduled` and `question.*` / `form.*`.
- Event-stream dispatch no longer awaits the publish or the subagent
  classification, so a slow lookup or ntfy request cannot delay lifecycle
  updates or a permission reply.
- Removed the "zero runtime dependencies" claim; the SDK dependency is now
  documented.

### Added

- Reconnect backoff on stream EOF or failure: 1, 2, 4, 8, 16, then 30 seconds
  through a single cancellable timer.
- Safety bounds: 64 concurrent idle/error notifications, 64 concurrent ntfy
  publishes and 512 pending permission timers. Overflow drops new notifications
  with a fixed secret-safe warning while lifecycle handling and permission
  replies stay responsive.
- Cleanup aborts the stream, cancels the backoff timer and all pending
  permission timers, and prevents any future publish. In-flight HTTP requests
  cannot be retracted.

### Documentation

- Version and install separation:
  - v1 `0.1.2` for OpenCode 1.x, configured with the `plugin` key.
  - v2 `0.2.1` for OpenCode 2.x, configured with the `plugins` key.
  - npm dist-tag release plan: `prev` -> `0.1.2`, `latest` -> `0.2.1`. Only
    `latest` = `0.1.2` exists on npm today; there is no `prev` tag and `0.2.1`
    is not published.
- Migration note: the external config file path, JSON Schema and keys are
  unchanged from 0.1.2; v1 users must pin `@0.1.2` or `@prev` before upgrading
  because the bare name and `latest` become the v2 line after the 0.2.1 publish.
- Release procedure documenting the safe order, including creating the `prev`
  tag before `npm publish --tag latest`.

## [0.1.2] - 2026-09-28

Published to npm. The immutable v1 line for OpenCode 1.x; it is not modified,
unpublished or republished by the 0.2.1 release.

### Added

- Permission notification grace period via `permissionNotificationDelayMs`
  (default `15000` ms): a `permission.asked` notification is delayed and is
  cancelled when a matching `permission.replied` arrives within the window.
- Permission correlation by request ID (independent of the session ID), a
  bounded recently-replied request ID memory (512 entries), and disposal cleanup
  of pending permission timers.

### Notes

- Description: "OpenCode 1.x plugin that publishes idle, error, permission and
  question notifications to ntfy (ntfy.sh or self-hosted)."
- Requires `engines.opencode` `>=1.18.25`; default plugin export is
  `{ id, server }` and uses the `tool.execute.before` hook. Running v1 does not
  require an upgrade.

[Unreleased]: https://github.com/maboch/opencode-ntfy-with-questions/compare/v0.1.2...HEAD
