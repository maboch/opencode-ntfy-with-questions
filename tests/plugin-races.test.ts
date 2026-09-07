import { describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPluginHandlers, type Logger, type OpenCodeClientLike, type SessionGetResult } from "../src/index.js"
import type { NtfyClient, NtfyMessage } from "../src/ntfy-client.js"
import { SessionRegistry } from "../src/session-registry.js"
import type { PluginConfig } from "../src/types.js"

function makeConfig(): PluginConfig {
  return normalizeConfig({ ntfy: { topic: "demo-topic" } })
}

function harness(overrides: {
  sessionLookupTimeoutMs?: number
  get?: (sessionID: string) => Promise<SessionGetResult>
} = {}) {
  const sent: NtfyMessage[] = []
  const ntfy: NtfyClient = {
    publish: async (message) => {
      sent.push(message)
    },
  }
  const logMessages: string[] = []
  const logger: Logger = (message: string) => logMessages.push(message)
  const getMock = vi.fn(
    async (input: { path: { id: string } }) => (overrides.get ? overrides.get(input.path.id) : { data: {} }),
  )
  const client = { session: { get: getMock } } as unknown as OpenCodeClientLike
  const registry = new SessionRegistry()
  const handlers = createPluginHandlers({
    config: makeConfig(),
    projectName: "demo-project",
    client,
    ntfy,
    registry,
    log: logger,
    sessionLookupTimeoutMs: overrides.sessionLookupTimeoutMs,
  })
  return { handlers, sent, logMessages, getMock, registry }
}

const idle = (sessionID: string) => ({ event: { type: "session.idle", properties: { sessionID } } })
const sessionError = (sessionID: string) => ({
  event: { type: "session.error", properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } } },
})
const deleted = (sessionID: string) => ({
  event: { type: "session.deleted", properties: { sessionID, info: { id: sessionID } } },
})
const created = (sessionID: string, parentID?: string) => ({
  event: {
    type: "session.created",
    properties: { sessionID, info: { id: sessionID, ...(parentID ? { parentID } : {}) } },
  },
})

function pendingLookup(): {
  promise: Promise<SessionGetResult>
  resolve: (result: SessionGetResult) => void
} {
  let resolveLookup!: (result: SessionGetResult) => void
  const promise = new Promise<SessionGetResult>((resolve) => {
    resolveLookup = resolve
  })
  return { promise, resolve: resolveLookup }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("lookup races with lifecycle events", () => {
  it("discards a stale child lookup after session.deleted and fails open for idle", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const idlePromise = h.handlers.event(idle("sess_gone_mid"))
    // session.deleted lands while the fallback lookup is still in flight.
    await h.handlers.event(deleted("sess_gone_mid"))
    pending.resolve({ data: { parentID: "sess_parent" } })
    await idlePromise

    // Fail open: the notification is sent despite the stale "child" response.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("sess_gone_mid")
    // The stale parent must never be cached or restored.
    expect(h.registry.parentOf("sess_gone_mid")).toBeUndefined()
    // Fixed sanitized warning naming only the internal session ID.
    const warnings = h.logMessages.filter((message) => message.includes("could not classify session"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("sess_gone_mid")
    expect(warnings[0]).not.toContain("sess_parent")
  })

  it("treats a later idle after the deleted race as a fresh, cacheable lookup", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const idlePromise = h.handlers.event(idle("sess_gone_twice"))
    await h.handlers.event(deleted("sess_gone_twice"))
    pending.resolve({ data: { parentID: "sess_parent" } })
    await idlePromise
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_gone_twice")).toBeUndefined()

    // A second idle performs a fresh lookup (the stale response was discarded).
    h.getMock.mockImplementation(async () => ({ data: { parentID: "sess_parent" } }))
    await h.handlers.event(idle("sess_gone_twice"))
    expect(h.registry.parentOf("sess_gone_twice")).toBe("sess_parent")
    expect(h.sent).toHaveLength(1)
    expect(h.getMock).toHaveBeenCalledTimes(2)
  })

  it("discards a stale child lookup after session.deleted and fails open for session.error", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const errorPromise = h.handlers.event(sessionError("sess_err_mid"))
    await h.handlers.event(deleted("sess_err_mid"))
    pending.resolve({ data: { parentID: "sess_parent" } })
    await errorPromise

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["warning"])
    expect(h.registry.parentOf("sess_err_mid")).toBeUndefined()
    const warnings = h.logMessages.filter((message) => message.includes("could not classify session"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("sess_err_mid")
  })
})

describe("lookup deadline and coalescing", () => {
  it("fails open after the lookup deadline when session.get never settles", async () => {
    const never = new Promise<SessionGetResult>(() => {})
    const h = harness({ sessionLookupTimeoutMs: 30, get: () => never })

    const started = Date.now()
    await h.handlers.event(idle("sess_hang"))
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("could not classify session"))).toBe(true)
    // Nothing was cached and tracking was released: a later idle retries.
    expect(h.registry.parentOf("sess_hang")).toBeUndefined()
    h.getMock.mockImplementation(async () => ({ data: { parentID: "sess_parent" } }))
    await h.handlers.event(idle("sess_hang"))
    expect(h.registry.parentOf("sess_hang")).toBe("sess_parent")
    expect(h.sent).toHaveLength(1)
    expect(h.getMock).toHaveBeenCalledTimes(2)
  })

  it("never caches a child result that resolves after the lookup deadline", async () => {
    const pending = pendingLookup()
    const h = harness({ sessionLookupTimeoutMs: 25, get: () => pending.promise })

    await h.handlers.event(idle("sess_late"))
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_late")).toBeUndefined()
    // The late child response must have no effect on the registry.
    pending.resolve({ data: { parentID: "sess_parent" } })
    await tick()
    expect(h.registry.parentOf("sess_late")).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it("coalesces concurrent cache misses for one session into a single lookup", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const first = h.handlers.event(idle("sess_both"))
    const second = h.handlers.event(sessionError("sess_both"))
    pending.resolve({ data: { parentID: "sess_parent" } })
    await Promise.all([first, second])

    expect(h.getMock).toHaveBeenCalledTimes(1)
    // Both events resolved as a known child: suppressed.
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_both")).toBe("sess_parent")
  })

  it("coalesces a root classification shared by concurrent misses", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const first = h.handlers.event(idle("sess_root_both"))
    const second = h.handlers.event(idle("sess_root_both"))
    pending.resolve({ data: {} })
    await Promise.all([first, second])

    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.sent).toHaveLength(2)
    expect(h.registry.parentOf("sess_root_both")).toBeNull()
  })

  it("lets a lifecycle update during a shared lookup stay authoritative", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const first = h.handlers.event(idle("sess_shared"))
    const second = h.handlers.event(idle("sess_shared"))
    // A lifecycle event classifies the session as a child while shared lookups
    // are pending; the stale root-like response must not override it.
    await h.handlers.event(created("sess_shared", "sess_parent"))
    pending.resolve({ data: {} })
    await Promise.all([first, second])

    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.registry.parentOf("sess_shared")).toBe("sess_parent")
    expect(h.sent).toHaveLength(0)
  })
})
