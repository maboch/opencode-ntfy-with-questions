/**
 * opencode-ntfy-with-questions entry point.
 *
 * The default export is an opencode 1.x server plugin (Plugin from
 * @opencode-ai/plugin). Hooks never reject: ntfy outages, config-independent
 * runtime problems and session lookup failures are all contained so a failing
 * notification can never abort a session or block the built-in question tool.
 */

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { basename } from "node:path"

import { loadConfigFile } from "./config.js"
import {
  formatErrorDraft,
  formatIdleDraft,
  formatPermissionDraft,
  formatQuestionDraft,
  parseRuntimeEvent,
} from "./event-adapter.js"
import { createNtfyClient, describeNtfyError, type NtfyClient } from "./ntfy-client.js"
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
 * Narrow structural view of the opencode client. The full client exposes far
 * more surface; plugins only need session lookup for subagent classification.
 */
export interface SessionGetResult {
  data?: { parentID?: string | null } | null
  error?: unknown
}

export interface OpenCodeClientLike {
  session: {
    get(input: { path: { id: string } }): Promise<SessionGetResult>
  }
}

export interface HandlerDeps {
  config: PluginConfig
  /** Display name for notifications: the basename of the project directory. */
  projectName: string
  client: OpenCodeClientLike
  ntfy: NtfyClient
  registry?: SessionRegistry
  log?: Logger
  /**
   * Deadline for one fallback session.get classification. Defaults to
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
  "tool.execute.before"(input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }): Promise<void>
  /** Cancels every pending delayed permission notification. */
  dispose(): Promise<void>
}

/**
 * Upper bound on the recently-replied request ID memory. It only needs to
 * cover the narrow race where a reply is observed before its ask event.
 */
const MAX_RECENTLY_REPLIED_REQUEST_IDS = 512

/**
 * Builds the two hooks used by the plugin from explicit dependencies so tests
 * can drive every notification route with fakes.
 */
export function createPluginHandlers(deps: HandlerDeps): PluginHandlers {
  const registry = deps.registry ?? new SessionRegistry()
  const log = deps.log ?? defaultLogger
  const config = deps.config
  const projectName = deps.projectName
  const lookupTimeoutMs = resolveSessionLookupTimeout(deps.sessionLookupTimeoutMs)
  // Shared in-flight classifications: concurrent cache misses for the same
  // session coalesce into one session.get call.
  const pendingClassifications = new Map<string, Promise<boolean>>()

  const send = async (draft: NotificationDraft): Promise<void> => {
    try {
      await deps.ntfy.publish({ title: draft.title, message: draft.message, tags: draft.tags, kind: draft.kind })
    } catch (error) {
      log(`notification "${draft.kind}" was not sent: ${describeNtfyError(error)}`)
    }
  }

  const permissionNotificationDelayMs = config.permissionNotificationDelayMs
  // Once disposed, no permission hook may schedule or publish, and every
  // pending timer has already been cleared.
  let disposed = false
  // Pending delayed permission notifications, keyed by request ID. Requests
  // without a usable ID are tracked separately only so dispose can clear them.
  const permissionRequestTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const anonymousPermissionTimers = new Set<ReturnType<typeof setTimeout>>()
  // Bounded FIFO of request IDs answered recently, so a permission.replied that
  // is observed before its permission.asked still suppresses the notification.
  const recentlyRepliedRequestIDs = new Set<string>()

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
   * that ID is still in the bounded recently-replied set; outside those windows
   * the same request can be scheduled again.
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
    const timer = setTimeout(() => {
      if (disposed) return
      if (requestID !== undefined) permissionRequestTimers.delete(requestID)
      else anonymousPermissionTimers.delete(timer)
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
  }

  /**
   * Races one session.get lookup against the lookup deadline. A timeout is
   * treated exactly like a lookup failure (undefined result); the underlying
   * SDK promise is never cancelled and may settle later, which Promise.race
   * absorbs so it can have no effect and no unhandled rejection.
   */
  const raceSessionLookup = async (sessionID: string): Promise<SessionGetResult | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session lookup deadline exceeded")), lookupTimeoutMs)
    })
    try {
      try {
        return await Promise.race([deps.client.session.get({ path: { id: sessionID } }), deadline])
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
    let result: SessionGetResult | undefined
    try {
      result = await raceSessionLookup(sessionID)

      // A lifecycle classification recorded while the lookup was in flight is
      // fresher than the response and always wins.
      const refreshed = registry.parentOf(sessionID)
      if (refreshed !== undefined) return refreshed !== null

      // The lookup was invalidated (session deleted/cleared): the response
      // describes a stale session, so it is discarded and never cached.
      if (!registry.lookupIsCurrent(sessionID, revision)) {
        log(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return false
      }

      // No usable response (transport failure, timeout, error or no data
      // object): fail open without guessing a classification.
      if (!result || result.error || typeof result.data !== "object" || result.data === null) {
        log(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return false
      }

      const rawParent = result.data.parentID
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
    try {
      const parsed = parseRuntimeEvent(input?.event)
      if (!parsed) return
      switch (parsed.kind) {
        case "lifecycle":
          // Keep the parent cache in sync with session create/update/delete.
          if (parsed.action === "deleted") registry.remove(parsed.sessionID)
          else registry.record(parsed.sessionID, parsed.parentID)
          return
        case "session.idle": {
          if (!config.events["session.idle"]) return
          if (config.suppressSubagents["session.idle"] && (await isChild(parsed.sessionID))) return
          await send(formatIdleDraft(parsed.sessionID, projectName))
          return
        }
        case "session.error": {
          if (!config.events["session.error"]) return
          // An error without a sessionID cannot be classified and always notifies.
          if (parsed.sessionID && config.suppressSubagents["session.error"] && (await isChild(parsed.sessionID))) return
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
          handlePermissionReplied(parsed.requestID)
          return
        }
      }
    } catch (error) {
      log(`event handling failed: ${describeNtfyError(error)}`)
    }
  }

  const onToolExecuteBefore = async (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ): Promise<void> => {
    try {
      if (!config.events["question.asked"]) return
      // Notify only for the exact built-in tool name; the runtime question.asked
      // event is deliberately ignored by parseRuntimeEvent to avoid duplicates.
      if (!input || typeof input.tool !== "string" || input.tool !== QUESTION_TOOL_NAME) return
      await send(formatQuestionDraft(output?.args, projectName))
    } catch (error) {
      log(`question notification failed: ${describeNtfyError(error)}`)
    }
  }

  return { event: onEvent, "tool.execute.before": onToolExecuteBefore, dispose }
}

/** Human-readable project label used in notification titles. */
export function projectLabel(directory: string): string {
  if (typeof directory === "string" && directory !== "") {
    const base = basename(directory)
    if (base !== "") return base
  }
  return "opencode"
}

export interface CreatePluginDeps {
  /** Overrides config loading (default: read from the opencode config dir). */
  loadConfig?: () => Promise<PluginConfig>
  /** Overrides the global fetch used for ntfy HTTP requests. */
  fetch?: typeof fetch
  log?: Logger
}

/**
 * Plugin factory. Configuration errors reject the returned plugin function so
 * opencode reports an actionable message during plugin initialization.
 */
export function createPlugin(deps: CreatePluginDeps = {}): Plugin {
  const plugin: Plugin = async (input) => {
    const loader = deps.loadConfig ?? loadConfigFile
    const config = await loader()
    if (!config.enabled) return {}

    // The SDK client type is a superset of the lookup surface used here.
    const client = input.client as unknown as OpenCodeClientLike
    const ntfy = createNtfyClient(config.ntfy, { fetch: deps.fetch })
    const handlers = createPluginHandlers({
      config,
      projectName: projectLabel(input.directory),
      client,
      ntfy,
      log: deps.log ?? defaultLogger,
    })

    // The compiled Event type omits runtime variants such as permission.asked,
    // so handlers accept `unknown` envelopes and are adapted for the hooks
    // object.
    const hooks: Hooks = {
      event: handlers.event as unknown as Hooks["event"],
      "tool.execute.before": handlers["tool.execute.before"] as unknown as NonNullable<Hooks["tool.execute.before"]>,
      dispose: handlers.dispose,
    }
    return hooks
  }
  return plugin
}

const defaultPlugin = {
  id: "opencode-ntfy-with-questions",
  server: createPlugin(),
} satisfies PluginModule

export default defaultPlugin
