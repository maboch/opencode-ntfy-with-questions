/**
 * opencode-ntfy-with-questions entry point (native opencode v2 plugin).
 *
 * The default export is a `Plugin.define`d v2 plugin. Setup loads the external
 * config, registers the question tool hook and starts the global event-stream
 * runtime. Notifications never reject a hook: ntfy outages, runtime problems
 * and session lookup failures are all contained so a failing notification can
 * never abort a session or block the built-in question tool.
 */

import { Plugin } from "@opencode/plugin"
import { basename } from "node:path"

import { loadConfigFile } from "./config.js"
import {
  createPluginHandlers,
  defaultLogger,
  type Logger,
} from "./notification-handlers.js"
import { createNtfyClient } from "./ntfy-client.js"
import { SessionRegistry } from "./session-registry.js"
import { createV2Runtime } from "./v2-runtime.js"
import type { PluginConfig } from "./types.js"

/** Human-readable project label used in notification titles. */
export function projectLabel(directory: string): string {
  if (typeof directory === "string" && directory !== "") {
    const base = basename(directory)
    if (base !== "") return base
  }
  return "opencode"
}

/**
 * Best-effort extraction of the last assistant output of a session for the
 * idle notification body. `session.context` returns the session's message
 * list; the assistant's final text parts are joined and truncated so the push
 * shows what was actually done instead of an opaque session ID. Returns null
 * when the session has no assistant output or the call fails.
 */
export async function lastAssistantOutput(
  ctx: { session: { context(input: { sessionID: string }): Promise<unknown> } },
  sessionID: string,
): Promise<string | null> {
  try {
    const result = await ctx.session.context({ sessionID })
    const messages = Array.isArray(result) ? result : []
    // Walk back from the newest message to the last assistant text.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (typeof message !== "object" || message === null) continue
      const text = assistantTextOf(message)
      if (text !== null) return text
    }
    return null
  } catch {
    return null
  }
}

function assistantTextOf(message: Record<string, unknown>): string | null {
  if (message["type"] !== "assistant") return null
  const content = message["content"]
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === "object" && part !== null && part["type"] === "text") {
        const text = part["text"]
        if (typeof text === "string") parts.push(text)
      }
    }
    if (parts.length > 0) return truncate(parts.join("\n"))
  }
  const flat = message["text"]
  if (typeof flat === "string" && flat !== "") return truncate(flat)
  return null
}

const MAX_MESSAGE_CHARS = 500

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_CHARS)}…`
}

export interface CreatePluginDeps {
  /** Overrides config loading (default: read from the opencode config dir). */
  loadConfig?: () => Promise<PluginConfig>
  /** Overrides the global fetch used for ntfy HTTP requests. */
  fetch?: typeof fetch
  log?: Logger
}

/**
 * Plugin factory. Configuration errors reject `setup` so opencode reports an
 * actionable message during plugin initialization. A disabled config registers
 * no hook and no event stream.
 */
export function createPlugin(deps: CreatePluginDeps = {}): Plugin.Plugin {
  return Plugin.define({
    id: "opencode-ntfy-with-questions",
    async setup(ctx) {
      const loader = deps.loadConfig ?? loadConfigFile
      const config = await loader()
      if (!config.enabled) return

      const log = deps.log ?? defaultLogger
      const safeLog = (message: string): void => {
        // # Reason: a logger must never turn a contained cleanup failure into a
        // rejected plugin disposal.
        try {
          log(message)
        } catch {
          // Swallow logger failures deliberately.
        }
      }
      const ntfy = createNtfyClient(config.ntfy, { fetch: deps.fetch })
      const handlers = createPluginHandlers({
        config,
        projectName: projectLabel(ctx.location.directory),
        directory: ctx.location.directory,
        // # Reason: native `session.get` resolves directly to the session info,
        // so the core reads `parentID` and `location.directory` off the result
        // with no data/error wrapper.
        getSession: (sessionID) => ctx.session.get({ sessionID }),
        getLastMessage: (sessionID) => lastAssistantOutput(ctx, sessionID),
        ntfy,
        registry: new SessionRegistry(),
        log,
      })

      let toolRegistration: { dispose: () => Promise<void> | void }
      try {
        toolRegistration = await ctx.tool.hook("execute.before", async (event) => {
          await handlers.question(event.tool, event.input)
          await handlers.notify(event.tool, event.input)
        })
      } catch (error) {
        // # Reason: the event stream was not started yet, so the handlers hold
        // no external resources; dispose them before the original registration
        // error propagates so no timer or cache survives a failed activation.
        try {
          await handlers.dispose()
        } catch {
          // Contained: the original registration error is what matters.
        }
        throw error
      }

      const runtime = createV2Runtime({
        events: { subscribe: (options) => ctx.event.subscribe(options) },
        directory: ctx.location.directory,
        dispatch: (event) => handlers.event({ event }),
        log,
      })
      runtime.start()

      // One memoized cleanup promise: repeated calls await the same in-progress
      // disposal and can never re-register anything.
      let cleanupPromise: Promise<void> | undefined
      const runCleanup = (): Promise<void> => {
        // # Reason: dispose the handlers synchronously, before any external
        // await, so the disposed guard is set, pending permission timers are
        // cleared and the parent cache is invalidated even if runtime or hook
        // disposal stalls or rejects. allSettled guarantees every step is
        // attempted and that cleanup itself never rejects.
        const attempts = [
          attempt(() => handlers.dispose()),
          attempt(() => runtime.dispose()),
          attempt(() => toolRegistration.dispose()),
        ]
        return Promise.allSettled(attempts).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") safeLog("plugin cleanup step failed")
          }
        })
      }
      return () => {
        if (cleanupPromise === undefined) cleanupPromise = runCleanup()
        return cleanupPromise
      }
    },
  })
}

/**
 * Runs one cleanup step, converting a synchronous throw into a rejection so a
 * single failing step cannot skip the others.
 */
function attempt(step: () => Promise<void> | void): Promise<void> {
  try {
    return Promise.resolve(step())
  } catch {
    return Promise.reject(new Error("cleanup step threw"))
  }
}

export default createPlugin()
