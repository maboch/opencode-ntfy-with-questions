import { describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPluginHandlers, type Logger, type SessionLookupResult } from "../src/notification-handlers.js"
import type { NtfyClient, NtfyMessage } from "../src/ntfy-client.js"
import { SessionRegistry } from "../src/session-registry.js"
import type { PluginConfig } from "../src/types.js"

function makeConfig(overrides: { delay?: number } = {}): PluginConfig {
  return normalizeConfig({ permissionNotificationDelayMs: overrides.delay ?? 0, ntfy: { topic: "demo-topic" } })
}

function harness(
  overrides: {
    sessionLookupTimeoutMs?: number
    get?: (sessionID: string) => Promise<SessionLookupResult>
    config?: PluginConfig
  } = {},
) {
  const sent: NtfyMessage[] = []
  const ntfy: NtfyClient = {
    publish: async (message) => {
      sent.push(message)
    },
  }
  const logMessages: string[] = []
  const logger: Logger = (message: string) => logMessages.push(message)
  const getMock = vi.fn(async (sessionID: string) => (overrides.get ? overrides.get(sessionID) : {}))
  const registry = new SessionRegistry()
  const handlers = createPluginHandlers({
    config: overrides.config ?? makeConfig(),
    projectName: "demo-project",
    getSession: getMock,
    ntfy,
    registry,
    log: logger,
    sessionLookupTimeoutMs: overrides.sessionLookupTimeoutMs,
  })
  return { handlers, sent, logMessages, getMock, registry }
}

const idle = (sessionID: string) => ({
  event: { id: "evt_idle", type: "session.status", created: 1, data: { sessionID, status: { type: "idle" } } },
})
const sessionError = (sessionID: string) => ({
  event: {
    id: "evt_err",
    type: "session.execution.failed",
    created: 1,
    data: { sessionID, error: { type: "UnknownError", message: "boom" } },
  },
})
const deleted = (sessionID: string) => ({
  event: { id: "evt_deleted", type: "session.deleted", created: 1, data: { sessionID } },
})
const created = (sessionID: string, parentID?: string) => ({
  event: { id: "evt_created", type: "session.created", created: 1, data: { sessionID, ...(parentID ? { parentID } : {}) } },
})

function pendingLookup(): {
  promise: Promise<SessionLookupResult>
  resolve: (result: SessionLookupResult) => void
} {
  let resolveLookup!: (result: SessionLookupResult) => void
  const promise = new Promise<SessionLookupResult>((resolve) => {
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
    pending.resolve({ parentID: "sess_parent" })
    await idlePromise

    // Fail open: the notification is sent despite the stale "child" response.
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_gone_mid")).toBeUndefined()
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
    pending.resolve({ parentID: "sess_parent" })
    await idlePromise
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_gone_twice")).toBeUndefined()

    h.getMock.mockImplementation(async () => ({ parentID: "sess_parent" }))
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
    pending.resolve({ parentID: "sess_parent" })
    await errorPromise

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["warning"])
    expect(h.registry.parentOf("sess_err_mid")).toBeUndefined()
  })
})

describe("lookup deadline and coalescing", () => {
  it("fails open after the lookup deadline when the lookup never settles", async () => {
    const never = new Promise<SessionLookupResult>(() => {})
    const h = harness({ sessionLookupTimeoutMs: 30, get: () => never })

    const started = Date.now()
    await h.handlers.event(idle("sess_hang"))
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("could not classify session"))).toBe(true)
    expect(h.registry.parentOf("sess_hang")).toBeUndefined()
  })

  it("never caches a child result that resolves after the lookup deadline", async () => {
    const pending = pendingLookup()
    const h = harness({ sessionLookupTimeoutMs: 25, get: () => pending.promise })

    await h.handlers.event(idle("sess_late"))
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_late")).toBeUndefined()
    // The late child response must have no effect on the registry.
    pending.resolve({ parentID: "sess_parent" })
    await tick()
    expect(h.registry.parentOf("sess_late")).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it("coalesces concurrent cache misses for one session into a single lookup", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const first = h.handlers.event(idle("sess_both"))
    const second = h.handlers.event(sessionError("sess_both"))
    pending.resolve({ parentID: "sess_parent" })
    await Promise.all([first, second])

    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_both")).toBe("sess_parent")
  })

  it("coalesces a root classification shared by concurrent misses", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })

    const first = h.handlers.event(idle("sess_root_both"))
    const second = h.handlers.event(idle("sess_root_both"))
    pending.resolve({})
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
    await h.handlers.event(created("sess_shared", "sess_parent"))
    pending.resolve({})
    await Promise.all([first, second])

    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.registry.parentOf("sess_shared")).toBe("sess_parent")
    expect(h.sent).toHaveLength(0)
  })
})

describe("slow work does not block lifecycle or permission replies", () => {
  it("cancels a pending permission notification while a session lookup is stuck", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise, config: makeConfig({ delay: 10000 }) })
    // A slow idle classification is now in flight and unresolved.
    const idlePromise = h.handlers.event(idle("sess_slow"))
    // A permission ask and reply arrive while that lookup is still pending.
    await h.handlers.event({
      event: {
        id: "evt_perm",
        type: "permission.asked",
        created: 1,
        data: { id: "per_1", sessionID: "sess_root", action: "edit", resources: ["a"] },
      },
    })
    await h.handlers.event({
      event: { id: "evt_reply", type: "permission.replied", created: 1, data: { sessionID: "sess_root", requestID: "per_1", reply: "once" } },
    })
    // The reply was processed synchronously; resolving the lookup and advancing
    // real time must not publish the cancelled permission notification.
    pending.resolve({})
    await idlePromise
    await tick()
    expect(h.sent.some((message) => message.kind === "permission.asked")).toBe(false)
  })

  it("applies a lifecycle update before a slow idle classification resolves", async () => {
    const pending = pendingLookup()
    const h = harness({ get: () => pending.promise })
    const idlePromise = h.handlers.event(idle("sess_lifecycle_race"))
    // The lifecycle child classification lands before the lookup resolves.
    await h.handlers.event(created("sess_lifecycle_race", "sess_parent"))
    expect(h.registry.parentOf("sess_lifecycle_race")).toBe("sess_parent")
    pending.resolve({})
    await idlePromise
    expect(h.sent).toHaveLength(0)
  })
})
