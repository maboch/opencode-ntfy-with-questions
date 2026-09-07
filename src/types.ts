/**
 * Shared types and constants for opencode-ntfy-with-questions.
 */

export const notificationKinds = [
  "session.idle",
  "session.error",
  "permission.asked",
  "question.asked",
] as const

export type NotificationKind = (typeof notificationKinds)[number]

export const ntfyPriorities = ["min", "low", "default", "high", "max"] as const
export type NtfyPriority = (typeof ntfyPriorities)[number]

/**
 * Fixed default ntfy tags per notification kind.
 */
export const kindTags: Record<NotificationKind, string> = {
  "session.idle": "hourglass_done",
  "session.error": "warning",
  "permission.asked": "lock",
  "question.asked": "question",
}

export interface NtfySettings {
  /** Normalized base URL with exactly one trailing slash. */
  server: string
  topic: string
  token?: string
  priority: NtfyPriority
  timeoutMs: number
}

export interface SuppressSubagentSettings {
  "session.idle": boolean
  "session.error": boolean
}

export interface PluginConfig {
  enabled: boolean
  events: Record<NotificationKind, boolean>
  suppressSubagents: SuppressSubagentSettings
  ntfy: NtfySettings
}

/**
 * The event envelope opencode delivers to the plugin `event` hook at runtime.
 *
 * The compiled `Event` type from @opencode-ai/plugin is a closed union that
 * omits several runtime variants (for example `permission.asked`), so the
 * adapter in event-adapter.ts treats this shape as unknown and narrows it
 * manually instead of trusting the declared union.
 */
export interface RuntimeEventEnvelope {
  id?: unknown
  type?: unknown
  properties?: unknown
}

/**
 * Ready-to-send notification. Title and message are bounded and sanitized by
 * the ntfy client right before publishing.
 */
export interface NotificationDraft {
  kind: NotificationKind
  title: string
  message: string
  tags: string[]
}

export const CONFIG_FILE_NAME = "notification-ntfy-with-questions.json"

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh"
export const DEFAULT_NTFY_PRIORITY: NtfyPriority = "default"
export const DEFAULT_TIMEOUT_MS = 5000

export const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/

export const MAX_CONFIG_FILE_BYTES = 64 * 1024
export const MAX_REFERENCED_FILE_BYTES = 16 * 1024

export const MAX_TITLE_BYTES = 1024
export const MAX_MESSAGE_BYTES = 4096

export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 60000

/**
 * Deadline for one fallback session.get classification lookup. OpenCode's SDK
 * promise cannot be cancelled, so this bounds how long an idle/error event
 * waits before the plugin fails open.
 */
export const DEFAULT_SESSION_LOOKUP_TIMEOUT_MS = 5000

/** Exact name of the built-in tool that asks the user questions. */
export const QUESTION_TOOL_NAME = "question"
