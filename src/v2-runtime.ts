/**
 * Native opencode v2 event-stream consumer.
 *
 * The public v2 stream is GLOBAL across server locations and volatile (no
 * missed-event replay). This runtime subscribes once, keeps only recognized
 * native events whose `location.directory` matches the plugin location, and
 * dispatches each accepted event immediately without awaiting the next frame -
 * so a slow session lookup or ntfy publish can never delay lifecycle updates
 * or a permission reply. On subscription failure or normal EOF it re-subscribes
 * through one cancellable backoff timer instead of tight-looping; only a
 * recognized local native event (or a stable 30s connection) resets it.
 *
 * Idle/error notifications are bounded to MAX_IN_FLIGHT_IDLE_ERROR concurrent
 * operations; excess idle/error frames are skipped (never queued). Lifecycle
 * and permission frames bypass that cap and are always dispatched.
 */

import { parseRuntimeEvent } from "./event-adapter.js"
import type { Logger } from "./notification-handlers.js"

export interface RuntimeEventSource {
  subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>
}

export interface V2RuntimeDeps {
  events: RuntimeEventSource
  /** Canonical plugin location directory; events are matched by exact equality. */
  directory: string
  dispatch: (event: unknown) => Promise<void>
  log?: Logger
  /** Injectable clock so backoff tests do not depend on wall time. */
  now?: () => number
}

export interface V2Runtime {
  /** Starts the detached subscription loop (idempotent). */
  start(): void
  /** Stops the loop, aborts the stream and cancels the backoff timer. */
  dispose(): Promise<void>
}

/** Concurrent idle/error notification operations allowed by the runtime. */
export const MAX_IN_FLIGHT_IDLE_ERROR = 64

/** Fixed reconnect backoff progression, capped at 30s. */
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/** A connection that stayed up this long is treated as healthy. */
const STABLE_CONNECTION_MS = 30000

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Extracts the canonical directory from an event's `location`, if present.
 * Missing or malformed locations return undefined and are ignored by callers.
 */
export function eventLocationDirectory(event: unknown): string | undefined {
  const record = asRecord(event)
  const location = asRecord(record?.["location"])
  const directory = location?.["directory"]
  return typeof directory === "string" && directory !== "" ? directory : undefined
}

/**
 * True only when the event carries the exact plugin directory. Locations are
 * canonical in the API, so no normalization is applied (and no session lookup
 * fallback is performed, which would add ordering/deadline hazards).
 */
export function isLocalEvent(event: unknown, directory: string): boolean {
  return eventLocationDirectory(event) === directory
}

/**
 * Creates the stream runtime. `dispatch` receives raw accepted envelopes and
 * is expected to be internally failure-contained; this runtime still attaches
 * rejection handlers to every detached dispatch promise.
 */
export function createV2Runtime(deps: V2RuntimeDeps): V2Runtime {
  const log = deps.log ?? ((): void => {})
  const now = deps.now ?? Date.now
  const directory = deps.directory

  let disposed = false
  let started = false
  let loopDone: Promise<void> | undefined
  const controller = new AbortController()

  let inFlight = 0
  let idleErrorOverflowWarned = false
  let backoffIndex = 0
  let backoffTimer: ReturnType<typeof setTimeout> | undefined
  let backoffResolve: (() => void) | undefined

  const safeLog = (message: string): void => {
    // # Reason: a logger must never crash the detached loop or cleanup.
    try {
      log(message)
    } catch {
      // Swallow logger failures deliberately.
    }
  }

  const releaseSlot = (): void => {
    inFlight -= 1
    if (inFlight < MAX_IN_FLIGHT_IDLE_ERROR) idleErrorOverflowWarned = false
  }

  const dispatchDetached = (event: unknown, throttled: boolean): void => {
    if (throttled) {
      if (inFlight >= MAX_IN_FLIGHT_IDLE_ERROR) {
        if (!idleErrorOverflowWarned) {
          idleErrorOverflowWarned = true
          safeLog("idle/error notification skipped: too many concurrent notifications")
        }
        return
      }
      inFlight += 1
      const promise = deps.dispatch(event)
      promise.then(releaseSlot, releaseSlot)
      return
    }
    // Lifecycle and permission frames are never capped: dispatch immediately.
    const promise = deps.dispatch(event)
    promise.then(undefined, () => {
      safeLog("event dispatch failed")
    })
  }

  const waitBackoff = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (disposed) {
        resolve()
        return
      }
      const delay = BACKOFF_DELAYS_MS[Math.min(backoffIndex, BACKOFF_DELAYS_MS.length - 1)]!
      backoffIndex += 1
      backoffResolve = resolve
      backoffTimer = setTimeout(() => {
        backoffTimer = undefined
        backoffResolve = undefined
        resolve()
      }, delay)
      // Never keep the process alive just for a reconnect.
      backoffTimer.unref?.()
    })

  const runLoop = async (): Promise<void> => {
    while (!disposed) {
      const connectedAt = now()
      let subscribed = false
      try {
        const stream = deps.events.subscribe({ signal: controller.signal })
        subscribed = true
        for await (const event of stream) {
          if (disposed) break
          // # Reason: the v2 stream is global; a foreign or missing location is
          // dropped without a lookup fallback to avoid ordering/deadline races.
          if (!isLocalEvent(event, directory)) continue
          // # Reason: validate against the native adapter FIRST. Only a
          // recognized native event proves the stream is healthy; unknown or
          // malformed frames are ignored entirely and must not reset the
          // reconnect backoff or be dispatched.
          const parsed = parseRuntimeEvent(event)
          if (!parsed) continue
          backoffIndex = 0
          // Dispatch without awaiting: the loop must keep draining frames.
          const throttled = parsed.kind === "session.idle" || parsed.kind === "session.error"
          dispatchDetached(event, throttled)
        }
      } catch {
        // Subscription failure and iterator errors both fall through to backoff.
      }
      if (disposed) break
      // A connection that stayed up for a while is considered healthy even if
      // it produced no matching event.
      if (now() - connectedAt >= STABLE_CONNECTION_MS) backoffIndex = 0
      safeLog(subscribed ? "event stream closed; reconnecting" : "event subscription failed; reconnecting")
      await waitBackoff()
    }
  }

  const start = (): void => {
    if (started || disposed) return
    started = true
    // The loop is detached but always carries a rejection handler.
    loopDone = runLoop().catch(() => {
      safeLog("event stream loop stopped unexpectedly")
    })
  }

  const dispose = async (): Promise<void> => {
    if (!disposed) {
      disposed = true
      controller.abort()
      if (backoffTimer !== undefined) {
        clearTimeout(backoffTimer)
        backoffTimer = undefined
      }
      // Wake a sleeping loop so it observes `disposed` and exits promptly.
      if (backoffResolve !== undefined) {
        const resolve = backoffResolve
        backoffResolve = undefined
        resolve()
      }
    }
    if (loopDone !== undefined) await loopDone
  }

  return { start, dispose }
}
