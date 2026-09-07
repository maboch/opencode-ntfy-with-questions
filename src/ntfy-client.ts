/**
 * Minimal ntfy publishing client used by the plugin.
 *
 * Publishing uses a JSON POST to the normalized base URL (the topic travels in
 * the JSON body), which keeps an optional reverse-proxy path prefix working.
 * Only `fetch` and no third-party dependencies are used.
 */

import {
  MAX_MESSAGE_BYTES,
  MAX_TITLE_BYTES,
  type NotificationKind,
  type NtfyPriority,
  type NtfySettings,
} from "./types.js"

export interface NtfyMessage {
  title: string
  message: string
  tags: string[]
  priority?: NtfyPriority
  kind?: NotificationKind
}

export type FetchLike = typeof fetch

export interface NtfyClientDeps {
  fetch?: FetchLike
}

export interface NtfyClient {
  publish(message: NtfyMessage): Promise<void>
}

/** Base class for publish failures; messages never contain tokens or payloads. */
export class NtfyPublishError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class NtfyTimeoutError extends NtfyPublishError {}
export class NtfyTransportError extends NtfyPublishError {}
export class NtfyHttpError extends NtfyPublishError {
  readonly status: number

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options)
    this.status = status
  }
}

/**
 * Creates a publish client bound to one config's ntfy settings. `fetch` is
 * injectable so tests can observe requests and simulate failures.
 */
export function createNtfyClient(settings: NtfySettings, deps: NtfyClientDeps = {}): NtfyClient {
  const fetchFn = deps.fetch ?? fetch
  const publish = async (message: NtfyMessage): Promise<void> => {
    // Bound here, at the send boundary, so every caller is safe by default.
    const title = truncateUtf8(sanitizeTitle(message.title), MAX_TITLE_BYTES)
    const body = JSON.stringify({
      topic: settings.topic,
      title,
      message: truncateUtf8(message.message, MAX_MESSAGE_BYTES),
      priority: message.priority ?? settings.priority,
      tags: message.tags,
    })

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (settings.token !== undefined) {
      headers.authorization = `Bearer ${settings.token}`
    }

    // Explicit deadline: a fetchFn that never settles (or ignores its signal)
    // must not hang the hook. The deadline aborts the real request when it
    // wins, and the timer is cleared on every settled path.
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject first so the typed deadline wins the race; aborting first
          // could let a signal-observing fetch rejection beat the deadline.
          reject(new NtfyTimeoutError(`ntfy publish timed out after ${settings.timeoutMs}ms`))
          controller.abort()
        }, settings.timeoutMs)
      })

      let response: Response
      try {
        response = await Promise.race([
          fetchFn(settings.server, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }),
          deadline,
        ])
      } catch (error) {
        // The deadline rejects with NtfyTimeoutError; everything else is a
        // fixed transport failure. Foreign error names/messages/strings are
        // never inspected or interpolated, and Promise.race consumes any late
        // rejection so it cannot become an unhandled rejection.
        if (error instanceof NtfyTimeoutError) throw error
        throw new NtfyTransportError("ntfy publish failed before a response was received", { cause: error })
      }

      if (!response.ok) {
        throw new NtfyHttpError(`ntfy server responded with HTTP status ${response.status}`, response.status)
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return { publish }
}

/**
 * Produces a log-safe description of a publish failure. The result never
 * includes the token, headers, or the notification payload.
 */
export function describeNtfyError(error: unknown): string {
  if (error instanceof NtfyHttpError) return `ntfy server responded with HTTP status ${error.status}`
  if (error instanceof NtfyTimeoutError) return error.message
  if (error instanceof NtfyTransportError) return error.message
  // Never surface a foreign Error.message: it could embed request payloads.
  return "unexpected ntfy publish failure"
}

/**
 * Removes control characters (C0, DEL, C1) from a title. Newlines and tabs in
 * a title are replaced with a space because ntfy renders titles on one line.
 */
export function sanitizeTitle(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
}

/**
 * Deterministic UTF-8-safe truncation to at most `maxBytes` bytes: the string
 * is cut on a UTF-8 character boundary and never emits an invalid sequence.
 * Non-truncated input is returned unchanged (identity for short strings).
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return text
  // Walk back over UTF-8 continuation bytes (0b10xxxxxx) so we stop exactly
  // before the first multi-byte character that would be split.
  let end = maxBytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(encoded.subarray(0, end))
}
