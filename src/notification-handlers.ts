/**
 * Notification handlers shared by the opencode v2 plugin adapter.
 *
 * The core is deliberately runtime-agnostic: it takes a neutral `getSession`
 * lookup and exposes stable method names (`event`, `question`, `dispose`), so
 * the notification behavior can be tested without the SDK. Every path fails
 * open - an ntfy, formatter or logger failure must never reject a hook or block
 * the built-in question tool.
 */

import {
  formatErrorDraft,
  formatIdleDraft,
  formatPermissionDraft,
  formatQuestionDraft,
  parseRuntimeEvent,
} from "./event-adapter.js"
import { describeNtfyError, type NtfyClient } from "./ntfy-client.js"
import { SessionRegistry } from "./session-registry.js"
import {
  DEFAULT_SESSION_LOOKUP_TIMEOUT_MS,
  QUESTION_TOOL_NAME,
  type NotificationDraft,
  type PluginConfig,
} from "./types.js"

export type Logger = (message: string) => void

export function defaultLogger(message: string): void {
  console.warn(`[opencode-ntfy-with-questions] ${message}`)
}

/**
 * Neutral session lookup result: only the parent classification is needed.
 * `parentID` absent or empty means the session is a root.
 */
export interface SessionLookupResult {
  parentID?: string | null
}

export interface HandlerDeps {
  config: PluginConfig
  /** Display name for notifications: the basename of the project directory. */
  projectName: string
  /** Resolves one session directly; rejects on transport failure. */
  getSession: (sessionID: string) => Promise<SessionLookupResult>
  ntfy: NtfyClient
  registry?: SessionRegistry
  log?: Logger
  /**
   * Deadline for one fallback session lookup classification. Defaults to
   * DEFAULT_SESSION_LOOKUP_TIMEOUT_MS; tests inject small values.
   */
  sessionLookupTimeoutMs?: number
}

/**
 * Normalizes the session lookup deadline: any positive finite integer is
 * accepted, anything else falls back to the production default.
 */
export function resolveSessionLookupTimeout(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return DEFAULT_SESSION_LOOKUP_TIMEOUT_MS
}

export interface PluginHandlers {
  event(input: { event: unknown }): Promise<void>
  question(tool: string, args: unknown): Promise<void>
  /** Cancels every pending delayed permission notification. */
  dispose(): Promise<void>
}

/**
 * Upper bound on the recently-replied request ID memory. It only needs to
 * cover the narrow race where a reply is observed before its ask event.
 */
const MAX_RECENTLY_REPLIED_REQUEST_IDS = 512

/**
 * Concurrent ntfy publishes. Timer, question and event paths share this gate;
 * excess work is skipped instead of queued so a flood cannot grow unbounded.
 */
const MAX_CONCURRENT_PUBLISHES = 64

/** Pending permission timers (identified + anonymous) held at once. */
const MAX_PENDING_PERMISSION_TIMERS = 512

function asLookupResult(value: unknown): SessionLookupResult | undefined {
  return typeof value === "object" && value !== null ? (value as SessionLookupResult) : undefined
}

/**
 * Builds the notification handlers from explicit dependencies so tests can
 * drive every notification route with fakes.
 */
export function createPluginHandlers(deps: HandlerDeps): PluginHandlers {
  const registry = deps.registry ?? new SessionRegistry()
  const log = deps.log ?? defaultLogger
  const config = deps.config
  const projectName = deps.projectName
  const lookupTimeoutMs = resolveSessionLookupTimeout(deps.sessionLookupTimeoutMs)
  // Shared in-flight classifications: concurrent cache misses for the same
  // session coalesce into one session lookup.
  const pendingClassifications = new Map<string, Promise<boolean>>()

  const safeLog = (message: string): void => {
    // # Reason: an injected logger may throw; logging must never crash a timer,
    // a detached event dispatch or cleanup.
    try {
      log(message)
    } catch {
      // Swallow logger failures deliberately.
    }
  }

  // Once disposed, no hook may schedule, publish or start anything new.
  let disposed = false

  // Publish concurrency gate. Excess work is skipped with one fixed warning
  // until capacity frees up again.
  let inFlightPublishes = 0
  let publishOverflowWarned = false

  const send = async (draft: NotificationDraft): Promise<void> => {
    if (disposed) return
    if (inFlightPublishes >= MAX_CONCURRENT_PUBLISHES) {
      if (!publishOverflowWarned) {
        publishOverflowWarned = true
        safeLog(`notification "${draft.kind}" skipped: too many concurrent notifications`)
      }
      return
    }
    inFlightPublishes += 1
    try {
      // # Reason: disposed can flip during a preceding await (for example a
      // session classification); re-check immediately before the irreversible
      // HTTP publish so no new publish starts after cleanup.
      if (disposed) return
      await deps.ntfy.publish({ title: draft.title, message: draft.message, tags: draft.tags, kind: draft.kind })
    } catch (error) {
      safeLog(`notification "${draft.kind}" was not sent: ${describeNtfyError(error)}`)
    } finally {
      inFlightPublishes -= 1
      if (inFlightPublishes < MAX_CONCURRENT_PUBLISHES) publishOverflowWarned = false
    }
  }

  const permissionNotificationDelayMs = config.permissionNotificationDelayMs
  // Pending delayed permission notifications, keyed by request ID. Requests
  // without a usable ID are tracked separately only so dispose can clear them.
  const permissionRequestTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const anonymousPermissionTimers = new Set<ReturnType<typeof setTimeout>>()
  // Bounded FIFO of request IDs answered recently, so a permission.replied that
  // is observed before its permission.asked still suppresses the notification.
  const recentlyRepliedRequestIDs = new Set<string>()
  let permissionOverflowWarned = false

  const pendingPermissionTimerCount = (): number =>
    permissionRequestTimers.size + anonymousPermissionTimers.size

  /** Allows the overflow warning to fire again once capacity has room. */
  const notePermissionCapacityFreed = (): void => {
    if (pendingPermissionTimerCount() < MAX_PENDING_PERMISSION_TIMERS) permissionOverflowWarned = false
  }

  const rememberRepliedRequestID = (requestID: string): void => {
    // Re-insertion moves the ID to the most-recent position of the Set.
    if (recentlyRepliedRequestIDs.has(requestID)) recentlyRepliedRequestIDs.delete(requestID)
    recentlyRepliedRequestIDs.add(requestID)
    if (recentlyRepliedRequestIDs.size > MAX_RECENTLY_REPLIED_REQUEST_IDS) {
      const oldest = recentlyRepliedRequestIDs.values().next().value
      if (oldest !== undefined) recentlyRepliedRequestIDs.delete(oldest)
    }
  }

  /**
   * Schedules one delayed permission notification. A duplicate ask is ignored
   * while a notification for the same request ID is still pending, and while
   * that ID is still in the bounded recently-replied set. New pending requests
   * are dropped safely once the pending-timer cap is reached; replies are
   * always handled regardless.
   */
  const schedulePermissionNotification = (
    requestID: string | undefined,
    permission: string,
    patterns: string[],
    sessionID: string | undefined,
  ): void => {
    if (disposed) return
    if (requestID !== undefined && (permissionRequestTimers.has(requestID) || recentlyRepliedRequestIDs.has(requestID))) {
      return
    }
    if (pendingPermissionTimerCount() >= MAX_PENDING_PERMISSION_TIMERS) {
      if (!permissionOverflowWarned) {
        permissionOverflowWarned = true
        safeLog("permission notification skipped: too many pending permission notifications")
      }
      return
    }
    const timer = setTimeout(() => {
      if (requestID !== undefined) permissionRequestTimers.delete(requestID)
      else anonymousPermissionTimers.delete(timer)
      notePermissionCapacityFreed()
      if (disposed) return
      // The timer boundary must never surface an unhandled rejection or throw,
      // even if publish rejects and the injected logger throws while reporting
      // it. Formatting failures are swallowed for the same reason.
      try {
        void send(formatPermissionDraft(permission, patterns, sessionID, projectName)).catch(() => {})
      } catch {
        // A formatting failure must not become an uncaught timer exception.
      }
    }, permissionNotificationDelayMs)
    // Never keep the process alive just for a pending notification.
    timer.unref?.()
    if (requestID !== undefined) permissionRequestTimers.set(requestID, timer)
    else anonymousPermissionTimers.add(timer)
  }

  /** Cancels a pending notification for an answered request and remembers the reply. */
  const handlePermissionReplied = (requestID: string): void => {
    const timer = permissionRequestTimers.get(requestID)
    if (timer !== undefined) {
      clearTimeout(timer)
      permissionRequestTimers.delete(requestID)
      notePermissionCapacityFreed()
    }
    rememberRepliedRequestID(requestID)
  }

  const dispose = async (): Promise<void> => {
    // Mark first so a hook invoked during or after disposal cannot reschedule.
    disposed = true
    for (const timer of permissionRequestTimers.values()) clearTimeout(timer)
    permissionRequestTimers.clear()
    for (const timer of anonymousPermissionTimers) clearTimeout(timer)
    anonymousPermissionTimers.clear()
    recentlyRepliedRequestIDs.clear()
    pendingClassifications.clear()
    registry.clear()
  }

  /**
   * Races one session lookup against the lookup deadline. A timeout is treated
   * exactly like a lookup failure (undefined result); the underlying SDK
   * promise is never cancelled and may settle later, which Promise.race
   * absorbs so it can have no effect and no unhandled rejection.
   */
  const raceSessionLookup = async (sessionID: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session lookup deadline exceeded")), lookupTimeoutMs)
    })
    try {
      try {
        return await Promise.race([deps.getSession(sessionID), deadline])
      } catch {
        return undefined
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Performs one tracked fallback classification for a session. The lookup is
   * revision-tracked so a lifecycle event (for example session.deleted) that
   * lands while the request is in flight invalidates the stale response.
   */
  const classifySession = async (sessionID: string): Promise<boolean> => {
    const revision = registry.beginLookup(sessionID)
    try {
      const result = await raceSessionLookup(sessionID)

      // A lifecycle classification recorded while the lookup was in flight is
      // fresher than the response and always wins.
      const refreshed = registry.parentOf(sessionID)
      if (refreshed !== undefined) return refreshed !== null

      // The lookup was invalidated (session deleted/cleared): the response
      // describes a stale session, so it is discarded and never cached.
      if (!registry.lookupIsCurrent(sessionID, revision)) {
        safeLog(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return false
      }

      // No usable response (transport failure, timeout or invalid result):
      // fail open without guessing a classification.
      const usable = asLookupResult(result)
      if (!usable) {
        safeLog(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return false
      }

      // Native `session.get` resolves directly to the session info, so the
      // parent ID is read straight off the response.
      const rawParent = usable.parentID
      const parent = typeof rawParent === "string" && rawParent !== "" ? rawParent : null
      registry.record(sessionID, parent)
      return parent !== null
    } finally {
      registry.endLookup(sessionID)
    }
  }

  /**
   * Decides whether a session is a known subagent. The cache is consulted
   * first; concurrent cache misses for the same session share one tracked
   * classification. Any failure fails open: the caller notifies and this
   * helper logs a sanitized warning that only names the session.
   */
  const isChild = async (sessionID: string): Promise<boolean> => {
    const cached = registry.parentOf(sessionID)
    if (cached !== undefined) return cached !== null

    const pending = pendingClassifications.get(sessionID)
    if (pending !== undefined) return pending

    const classification = classifySession(sessionID)
    pendingClassifications.set(sessionID, classification)
    // Release the shared entry once it settles, but only while it is still the
    // entry for this session (a newer classification may have replaced it).
    const release = (): void => {
      if (pendingClassifications.get(sessionID) === classification) pendingClassifications.delete(sessionID)
    }
    void classification.then(release, release)
    return classification
  }

  const onEvent = async (input: { event: unknown }): Promise<void> => {
    if (disposed) return
    try {
      const parsed = parseRuntimeEvent(input?.event)
      if (!parsed) return
      switch (parsed.kind) {
        case "lifecycle":
          // # Reason: lifecycle mutations run synchronously, before any await,
          // so a slow idle/error classification can never delay them.
          if (parsed.action === "deleted") registry.remove(parsed.sessionID)
          else registry.record(parsed.sessionID, parsed.parentID)
          return
        case "session.idle": {
          if (!config.events["session.idle"]) return
          if (config.suppressSubagents["session.idle"] && (await isChild(parsed.sessionID))) return
          // Cleanup may have happened while the classification was in flight.
          if (disposed) return
          await send(formatIdleDraft(parsed.sessionID, projectName))
          return
        }
        case "session.error": {
          if (!config.events["session.error"]) return
          // An error without a sessionID cannot be classified and always notifies.
          if (parsed.sessionID && config.suppressSubagents["session.error"] && (await isChild(parsed.sessionID))) return
          if (disposed) return
          await send(formatErrorDraft(parsed.sessionID, parsed.errorMessage, projectName))
          return
        }
        case "permission.asked": {
          // Permission notifications cover root and child sessions alike, but a
          // disposed handler must not schedule or publish anything.
          if (disposed) return
          if (!config.events["permission.asked"]) return
          if (permissionNotificationDelayMs > 0) {
            // Positive grace period: schedule and return without waiting for ntfy.
            schedulePermissionNotification(parsed.requestID, parsed.permission, parsed.patterns, parsed.sessionID)
            return
          }
          // Delay 0 keeps the original behavior: publish before returning.
          await send(formatPermissionDraft(parsed.permission, parsed.patterns, parsed.sessionID, projectName))
          return
        }
        case "permission.replied": {
          // With no grace period there is never a pending notification to cancel.
          if (permissionNotificationDelayMs <= 0) return
          // # Reason: cancellation is synchronous so a pending permission
          // notification is retracted immediately, before any other await.
          handlePermissionReplied(parsed.requestID)
          return
        }
      }
    } catch (error) {
      safeLog(`event handling failed: ${describeNtfyError(error)}`)
    }
  }

  const onQuestion = async (tool: string, args: unknown): Promise<void> => {
    if (disposed) return
    try {
      if (!config.events["question.asked"]) return
      // Notify only for the exact built-in tool name. The runtime question/form
      // events are deliberately ignored by parseRuntimeEvent to avoid duplicates.
      if (typeof tool !== "string" || tool !== QUESTION_TOOL_NAME) return
      await send(formatQuestionDraft(args, projectName))
    } catch (error) {
      // A question notification must never prevent the tool from executing, even
      // if formatting or the logger fails.
      safeLog(`question notification failed: ${describeNtfyError(error)}`)
    }
  }

  return { event: onEvent, question: onQuestion, dispose }
}
