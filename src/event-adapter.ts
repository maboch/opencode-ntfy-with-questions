/**
 * Runtime event parsing and notification formatting.
 *
 * The plugin consumes the native opencode v2 event stream, whose envelopes are
 * shaped `{ id, type, data, location?, created?, durable? }`. The stream is
 * global across server locations and decoded as `unknown`, so every frame is
 * narrowed manually here before it reaches the notification handlers.
 */

import { kindTags, type NotificationDraft } from "./types.js"

/** Native lifecycle actions the plugin tracks. There is no `updated` in v2. */
export type LifecycleAction = "created" | "deleted"

export type ParsedEvent =
  | { kind: "lifecycle"; action: LifecycleAction; sessionID: string; parentID: string | null }
  | { kind: "session.idle"; sessionID: string }
  | { kind: "session.error"; sessionID: string | undefined; errorMessage: string }
  | {
      kind: "permission.asked"
      sessionID: string | undefined
      requestID?: string
      permission: string
      patterns: string[]
    }
  | { kind: "permission.replied"; requestID: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Parses one native v2 event envelope into a narrowed internal event.
 *
 * Returns `null` for unknown event types. The following native routes are
 * deliberately ignored:
 * - `question.*` / `question.v2.*` / `form.*`: question notifications come
 *   exclusively from the `tool.execute.before` hook filtered by the exact tool
 *   name `question`, so a question is never notified twice.
 * - the deprecated `session.idle`: `session.status` with `status.type === "idle"`
 *   is the single source of idle notifications (avoids a duplicate per run).
 * - the legacy `session.error` (native errors arrive as
 *   `session.execution.failed`) and transient `session.step.failed` /
 *   `session.retry.scheduled` frames.
 */
export function parseRuntimeEvent(envelope: unknown): ParsedEvent | null {
  const record = asRecord(envelope)
  if (!record) return null
  const type = typeof record["type"] === "string" ? (record["type"] as string) : null
  if (!type) return null
  if (type.startsWith("question.") || type.startsWith("form.")) return null

  const data = asRecord(record["data"])

  switch (type) {
    case "session.created": {
      // Native `session.created` carries a FLAT payload: the session ID and an
      // optional `parentID` live directly on `data`, not in a nested `info`.
      const sessionID = nonEmptyString(data?.sessionID)
      if (!sessionID) return null
      const parentID = nonEmptyString(data?.parentID) ?? null
      return { kind: "lifecycle", action: "created", sessionID, parentID }
    }
    case "session.deleted": {
      const sessionID = nonEmptyString(data?.sessionID)
      if (!sessionID) return null
      return { kind: "lifecycle", action: "deleted", sessionID, parentID: null }
    }
    case "session.status": {
      const sessionID = nonEmptyString(data?.sessionID)
      if (!sessionID) return null
      const status = asRecord(data?.status)
      // Only the terminal `idle` status notifies; `busy` and `retry` are
      // transient and are ignored.
      if (nonEmptyString(status?.type) !== "idle") return null
      return { kind: "session.idle", sessionID }
    }
    case "session.execution.failed": {
      const sessionID = nonEmptyString(data?.sessionID)
      return { kind: "session.error", sessionID, errorMessage: extractErrorMessage(data?.error) }
    }
    case "permission.asked": {
      // Native permission payload: `action` is the permission name, `resources`
      // the affected patterns and `id` the request identifier.
      const sessionID = nonEmptyString(data?.sessionID)
      const requestID = nonEmptyString(data?.id)
      const permission = nonEmptyString(data?.action) ?? "unknown"
      const rawResources = data?.resources
      const patterns = Array.isArray(rawResources)
        ? rawResources.filter((resource): resource is string => typeof resource === "string")
        : []
      return { kind: "permission.asked", sessionID, requestID, permission, patterns }
    }
    case "permission.replied": {
      // Only the native `requestID` correlates; there is no legacy fallback.
      const requestID = nonEmptyString(data?.requestID)
      if (!requestID) return null
      return { kind: "permission.replied", requestID }
    }
    default:
      return null
  }
}

/**
 * Extracts a safe, human readable message from a native structured error
 * `{ type, message, status?, response? }` or from the older
 * `{ name, data: { message } }` shape. Only the error type/name and the first
 * message-like field are used - never a stack trace, HTTP response body or
 * other potentially large or sensitive fields.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim() !== "") return error
  const record = asRecord(error)
  if (!record) return "unknown error"
  const type = nonEmptyString(record["type"])
  const name = nonEmptyString(record["name"])
  const label = type ?? name ?? "error"
  const data = asRecord(record["data"])
  const message =
    nonEmptyString(record["message"]) ??
    (data ? nonEmptyString(data["message"]) : undefined) ??
    "no additional details"
  return `${label}: ${message}`
}

function draft(kind: NotificationDraft["kind"], title: string, message: string): NotificationDraft {
  return { kind, title, message, tags: [kindTags[kind]] }
}

export function formatIdleDraft(sessionID: string, projectName: string): NotificationDraft {
  const message = `Session ${sessionID} has finished its run and is idle.\nIt is waiting for your next instruction.`
  return draft("session.idle", `${projectName} - session idle`, message)
}

export function formatErrorDraft(
  sessionID: string | undefined,
  errorMessage: string,
  projectName: string,
): NotificationDraft {
  const prefix = sessionID ? `Session ${sessionID} reported an error:` : "A session reported an error:"
  return draft("session.error", `${projectName} - session error`, `${prefix}\n${errorMessage}`)
}

export function formatPermissionDraft(
  permission: string,
  patterns: string[],
  sessionID: string | undefined,
  projectName: string,
): NotificationDraft {
  const lines = [`Permission "${permission}" is requested.`]
  if (sessionID) lines.push(`Session: ${sessionID}`)
  if (patterns.length > 0) lines.push(`Patterns: ${patterns.join(", ")}`)
  return draft("permission.asked", `${projectName} - permission requested`, lines.join("\n"))
}

/**
 * The exact shape produced by the built-in `question` tool. The tool schema
 * requires string `question`, string `header`, array `options` with string
 * `label`/`description` per option, and optional boolean `multiple`. Empty
 * strings and an empty options array are still valid, so they are accepted.
 */
interface ParsedQuestionOption {
  label: string
  description: string
}

interface ParsedQuestion {
  question: string
  header: string
  options: ParsedQuestionOption[]
  multiple: boolean
}

interface ParsedQuestions {
  questions: ParsedQuestion[]
}

/**
 * Parses `question` tool args in an all-or-nothing fashion: if any required
 * field is missing, mistyped or malformed, the whole payload is rejected and
 * the caller falls back to the generic notification.
 */
function parseQuestionArgs(args: unknown): ParsedQuestions | null {
  const record = asRecord(args)
  const rawQuestions = record?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const questions: ParsedQuestion[] = []
  for (const rawQuestion of rawQuestions) {
    const q = asRecord(rawQuestion)
    if (!q) return null
    if (typeof q["question"] !== "string" || typeof q["header"] !== "string") return null
    const multiple = q["multiple"]
    if (multiple !== undefined && typeof multiple !== "boolean") return null
    const rawOptions = q["options"]
    if (!Array.isArray(rawOptions)) return null

    const options: ParsedQuestionOption[] = []
    for (const rawOption of rawOptions) {
      const option = asRecord(rawOption)
      if (!option) return null
      if (typeof option["label"] !== "string" || typeof option["description"] !== "string") return null
      options.push({ label: option["label"], description: option["description"] })
    }
    questions.push({ question: q["question"], header: q["header"], options, multiple: multiple === true })
  }
  return { questions }
}

/**
 * Formats the args of the built-in `question` tool into a notification that
 * includes every header, question, option and the multiple-answer flag.
 * Malformed payloads produce one generic notification instead of throwing.
 */
export function formatQuestionDraft(args: unknown, projectName: string): NotificationDraft {
  const genericMessage =
    "The assistant is asking for your input but sent an unreadable question payload.\nOpen the conversation in opencode to answer."
  const parsed = parseQuestionArgs(args)
  if (!parsed) {
    return draft("question.asked", `${projectName} - question`, genericMessage)
  }

  const lines: string[] = []
  parsed.questions.forEach((q, index) => {
    const header = q.header !== "" ? q.header : undefined
    const heading = header ? `[${index + 1}] ${header}: ${q.question}` : `[${index + 1}] ${q.question}`
    lines.push(heading.trim())
    lines.push(`    Multiple answers: ${q.multiple ? "allowed" : "not allowed"}`)
    for (const option of q.options) {
      const labelPart = option.label !== "" ? option.label : "(unnamed option)"
      lines.push(option.description !== "" ? `    - ${labelPart} (${option.description})` : `    - ${labelPart}`)
    }
  })

  return draft("question.asked", `${projectName} - question`, lines.join("\n"))
}
