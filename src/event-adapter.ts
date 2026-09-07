/**
 * Runtime event parsing and notification formatting.
 *
 * The plugin `event` hook receives envelopes shaped `{ id, type, properties }`,
 * but the compiled `Event` type from @opencode-ai/plugin is a closed union that
 * omits several runtime variants (for example `permission.asked`). Everything
 * is therefore accepted as `unknown` and narrowed manually here.
 */

import { kindTags, type NotificationDraft } from "./types.js"

export type LifecycleAction = "created" | "updated" | "deleted"

export type ParsedEvent =
  | { kind: "lifecycle"; action: LifecycleAction; sessionID: string; parentID: string | null }
  | { kind: "session.idle"; sessionID: string }
  | { kind: "session.error"; sessionID: string | undefined; errorMessage: string }
  | { kind: "permission.asked"; sessionID: string | undefined; permission: string; patterns: string[] }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Parses one runtime event envelope into a narrowed internal event.
 *
 * Returns `null` for unknown event types and for `question.asked`: question
 * notifications are produced exclusively from the `tool.execute.before` hook
 * filtered by the exact tool name `question` so a single question is never
 * notified twice.
 */
export function parseRuntimeEvent(envelope: unknown): ParsedEvent | null {
  const record = asRecord(envelope)
  if (!record) return null
  const type = typeof record["type"] === "string" ? (record["type"] as string) : null
  if (!type) return null
  if (type === "question.asked") return null

  const props = asRecord(record["properties"])

  switch (type) {
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const info = asRecord(props?.info)
      const sessionID = nonEmptyString(props?.sessionID) ?? nonEmptyString(info?.id)
      if (!sessionID) return null
      const rawParent = info?.parentID
      const parentID = typeof rawParent === "string" && rawParent !== "" ? rawParent : null
      const action: LifecycleAction =
        type === "session.created" ? "created" : type === "session.updated" ? "updated" : "deleted"
      return { kind: "lifecycle", action, sessionID, parentID }
    }
    case "session.idle": {
      const sessionID = nonEmptyString(props?.sessionID)
      if (!sessionID) return null
      return { kind: "session.idle", sessionID }
    }
    case "session.error": {
      const sessionID = nonEmptyString(props?.sessionID)
      return { kind: "session.error", sessionID, errorMessage: extractErrorMessage(props?.error) }
    }
    case "permission.asked": {
      const sessionID = nonEmptyString(props?.sessionID)
      const permission =
        typeof props?.permission === "string" && props.permission !== "" ? (props.permission as string) : "unknown"
      const rawPatterns = props?.patterns
      const patterns = Array.isArray(rawPatterns) ? rawPatterns.filter((p): p is string => typeof p === "string") : []
      return { kind: "permission.asked", sessionID, permission, patterns }
    }
    default:
      return null
  }
}

/**
 * Extracts a safe, human readable message from an opencode error object such
 * as `{ name: "ProviderAuthError", data: { message: "..." } }`. Only the error
 * name and the first message-like field are used - never a stack trace, HTTP
 * response body or other potentially large or sensitive fields.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim() !== "") return error
  const record = asRecord(error)
  if (!record) return "unknown error"
  const name = typeof record["name"] === "string" && record["name"] !== "" ? (record["name"] as string) : "error"
  const data = asRecord(record["data"])
  const message =
    (data && typeof data["message"] === "string" && data["message"] !== "" && data["message"]) ||
    (typeof record["message"] === "string" && record["message"] !== "" && record["message"]) ||
    "no additional details"
  return `${name}: ${message}`
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
