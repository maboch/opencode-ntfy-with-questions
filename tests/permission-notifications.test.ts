import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPluginHandlers, type Logger } from "../src/notification-handlers.js"
import type { NtfyClient, NtfyMessage } from "../src/ntfy-client.js"
import { SessionRegistry } from "../src/session-registry.js"
import {
  DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS,
  type NtfySettings,
  type PluginConfig,
} from "../src/types.js"

function config(
  overrides: {
    delay?: number
    events?: Record<string, boolean>
    ntfy?: Partial<NtfySettings>
  } = {},
): PluginConfig {
  return normalizeConfig({
    permissionNotificationDelayMs: overrides.delay ?? DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS,
    events: overrides.events,
    ntfy: { topic: "demo-topic", ...overrides.ntfy },
  })
}

function harness(
  overrides: {
    config?: PluginConfig
    registry?: SessionRegistry
    publish?: (message: NtfyMessage) => Promise<void> | void
    log?: Logger
  } = {},
) {
  const sent: NtfyMessage[] = []
  const publish =
    overrides.publish ??
    (async (message: NtfyMessage) => {
      sent.push(message)
    })
  const ntfy = { publish } as unknown as NtfyClient
  const logMessages: string[] = []
  const logger: Logger = overrides.log ?? ((message: string) => logMessages.push(message))
  const registry = overrides.registry ?? new SessionRegistry()
  const handlers = createPluginHandlers({
    config: overrides.config ?? config(),
    projectName: "demo-project",
    getSession: async () => ({}),
    ntfy,
    registry,
    log: logger,
  })
  return { handlers, sent, logMessages, registry }
}

const permissionAsked = (id: unknown, sessionID = "sess_root") => ({
  event: {
    id: "evt_perm",
    type: "permission.asked",
    created: 1,
    data: {
      ...(id === undefined ? {} : { id }),
      sessionID,
      action: "edit",
      resources: ["**/*.ts"],
    },
  },
})

const permissionReplied = (requestID: unknown, reply = "once") => ({
  event: {
    id: "evt_reply",
    type: "permission.replied",
    created: 1,
    data: { sessionID: "sess_root", ...(requestID === undefined ? {} : { requestID }), reply },
  },
})

// Legacy shape kept only to prove the native adapter ignores the old
// `permissionID` field (there is no fallback in v2).
const legacyPermissionReplied = (permissionID: unknown) => ({
  event: {
    id: "evt_legacy",
    type: "permission.replied",
    created: 1,
    data: { sessionID: "sess_root", permissionID, response: "always" },
  },
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("permission notification grace period", () => {
  it("does not publish before the default 15s grace period and publishes after it", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    expect(h.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS - 1)
    expect(h.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain('"edit"')
    expect(h.sent[0]?.tags).toEqual(["lock"])
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("honors a custom grace period", async () => {
    const h = harness({ config: config({ delay: 5000 }) })
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(4999)
    expect(h.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(1)
  })

  it("publishes immediately and awaits the publisher when the delay is 0", async () => {
    const gate = deferred()
    let publishCalled = false
    const h = harness({
      config: config({ delay: 0 }),
      publish: () => {
        publishCalled = true
        return gate.promise
      },
    })
    let settled = false
    const eventPromise = h.handlers.event(permissionAsked("per_1")).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(publishCalled).toBe(true)
    expect(settled).toBe(false)
    gate.resolve()
    await eventPromise
    expect(settled).toBe(true)
  })

  it("returns from the event hook promptly with a positive delay", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    expect(h.sent).toHaveLength(0)
  })
})

describe("permission replies", () => {
  for (const reply of ["once", "always", "reject"]) {
    it(`suppresses a pending notification when the reply is "${reply}" in time`, async () => {
      const h = harness()
      await h.handlers.event(permissionAsked("per_1"))
      await h.handlers.event(permissionReplied("per_1", reply))
      await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
      expect(h.sent).toHaveLength(0)
    })
  }

  it("cannot retract a notification sent after the grace period (late reply)", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
    await h.handlers.event(permissionReplied("per_1"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("correlates concurrent requests by request ID, not by session", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1", "sess_same"))
    await h.handlers.event(permissionAsked("per_2", "sess_same"))
    await h.handlers.event(permissionReplied("per_1"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("ignores a reply for an unknown request ID and a reply without an ID", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionReplied("per_other"))
    await h.handlers.event(permissionReplied(undefined))
    await h.handlers.event(permissionReplied(""))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("suppresses a request when the reply arrives before the ask", async () => {
    const h = harness()
    await h.handlers.event(permissionReplied("per_early"))
    await h.handlers.event(permissionAsked("per_early"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
  })

  it("ignores the legacy permissionID field on permission.replied", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_legacy"))
    await h.handlers.event(legacyPermissionReplied("per_legacy"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("does not reschedule or duplicate a notification for a duplicate ask", async () => {
    const h = harness({ config: config({ delay: 10000 }) })
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(5000)
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20000)
    expect(h.sent).toHaveLength(1)
  })
})

describe("requests without a usable ID", () => {
  const idCases: Array<[string, unknown]> = [
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 42],
  ]
  for (const [name, id] of idCases) {
    it(`still notifies after the grace period when the ID is ${name}`, async () => {
      const h = harness()
      await h.handlers.event(permissionAsked(id))
      expect(h.sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
      expect(h.sent).toHaveLength(1)
    })
  }
})

describe("toggle and session handling", () => {
  it("respects the permission.asked toggle with a positive delay", async () => {
    const h = harness({ config: config({ events: { "permission.asked": false } }) })
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
  })

  it("still notifies permission requests from child sessions after the delay", async () => {
    const registry = new SessionRegistry()
    registry.record("sess_child", "sess_parent")
    const h = harness({ registry })
    await h.handlers.event(permissionAsked("per_1", "sess_child"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })
})

describe("bounded pending permission timers", () => {
  it("drops new pending requests past the cap but still handles replies", async () => {
    const h = harness()
    for (let i = 0; i < 512; i += 1) await h.handlers.event(permissionAsked(`per_${i}`))
    // The 513th distinct pending request is dropped safely with one warning.
    await h.handlers.event(permissionAsked("per_overflow"))
    expect(h.logMessages.some((message) => message.includes("too many pending permission notifications"))).toBe(true)
    // Replies are always honored: cancelling one frees capacity.
    await h.handlers.event(permissionReplied("per_0"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(511)
  })
})

describe("dispose", () => {
  it("cancels pending notifications with and without a request ID", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionAsked(undefined))
    await h.handlers.dispose()
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
  })

  it("is idempotent and safe when nothing is pending", async () => {
    const h = harness()
    await expect(h.handlers.dispose()).resolves.toBeUndefined()
    await expect(h.handlers.dispose()).resolves.toBeUndefined()
  })

  it("does not schedule from a hook invoked after dispose", async () => {
    const h = harness()
    await h.handlers.dispose()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionAsked(undefined))
    await h.handlers.question("question", { questions: [] })
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
  })

  it("does not publish an immediate (delay 0) notification from a hook invoked after dispose", async () => {
    const h = harness({ config: config({ delay: 0 }) })
    await h.handlers.dispose()
    await h.handlers.event(permissionAsked("per_1"))
    expect(h.sent).toHaveLength(0)
  })
})

describe("publish failure containment with a positive delay", () => {
  it("logs and contains a rejected publish without an unhandled rejection", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("ntfy is down")
      },
    })
    await expect(h.handlers.event(permissionAsked("per_1"))).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.logMessages.some((message) => message.includes('"permission.asked"'))).toBe(true)
  })

  it("contains a synchronously throwing publish and a throwing logger at the timer boundary", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = harness({
        publish: () => {
          throw new Error("sync boom")
        },
        log: () => {
          throw new Error("logger boom")
        },
      })
      await h.handlers.event(permissionAsked("per_1"))
      await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("bounded recently-replied memory", () => {
  it("forgets the oldest replied ID beyond the bounded set", async () => {
    const h = harness()
    for (let i = 0; i < 512; i += 1) await h.handlers.event(permissionReplied(`per_${i}`))
    // The 513th reply evicts the oldest remembered ID (per_0).
    await h.handlers.event(permissionReplied("per_512"))
    await h.handlers.event(permissionAsked("per_0"))
    await h.handlers.event(permissionAsked("per_511"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })
})
