import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPlugin, createPluginHandlers, type Logger, type OpenCodeClientLike } from "../src/index.js"
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
  const client = { session: { get: async () => ({ data: {} }) } } as unknown as OpenCodeClientLike
  const handlers = createPluginHandlers({
    config: overrides.config ?? config(),
    projectName: "demo-project",
    client,
    ntfy,
    registry,
    log: logger,
  })
  return { handlers, sent, logMessages, registry }
}

const permissionAsked = (id: unknown, sessionID = "sess_root") => ({
  event: {
    type: "permission.asked",
    properties: {
      ...(id === undefined ? {} : { id }),
      sessionID,
      permission: "edit",
      patterns: ["**/*.ts"],
    },
  },
})

const permissionReplied = (requestID: unknown, reply = "once") => ({
  event: {
    type: "permission.replied",
    properties: {
      ...(requestID === undefined ? {} : { requestID }),
      sessionID: "sess_root",
      permission: "edit",
      reply,
    },
  },
})

// Legacy shape kept only to prove the older `response`/`permissionID` event is
// still parsed; the current fixtures use the v2 `reply` field.
const legacyPermissionReplied = (permissionID: unknown) => ({
  event: {
    type: "permission.replied",
    properties: { permissionID, sessionID: "sess_root", response: "always" },
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

  it("publishes immediately and does not resolve until the publisher settles when the delay is 0", async () => {
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
    // The handler must have reached the awaited publish but still be pending.
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
    // Nothing is published until fake time advances, so the hook did not wait.
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
    // Only the uncorrelated request per_2 is published.
    expect(h.sent).toHaveLength(1)
  })

  it("ignores a reply for an unknown request ID", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionReplied("per_other"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })

  it("ignores a reply without a usable request ID", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionReplied(undefined))
    await h.handlers.event(permissionReplied(""))
    await h.handlers.event(permissionReplied(123))
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

  it("accepts the legacy permissionID field on permission.replied", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("per_legacy"))
    await h.handlers.event(legacyPermissionReplied("per_legacy"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
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
    expect(h.sent[0]?.message).toContain("sess_child")
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

  it("does not schedule a delayed notification from a hook invoked after dispose", async () => {
    const h = harness()
    await h.handlers.dispose()
    await h.handlers.event(permissionAsked("per_1"))
    await h.handlers.event(permissionAsked(undefined))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(0)
  })

  it("does not publish an immediate (delay 0) notification from a hook invoked after dispose", async () => {
    const h = harness({ config: config({ delay: 0 }) })
    await h.handlers.dispose()
    await h.handlers.event(permissionAsked("per_1"))
    expect(h.sent).toHaveLength(0)
  })

  it("is exposed through the plugin factory and cancels pending timers", async () => {
    const requests: string[] = []
    const fetchMock = vi.fn(async () => {
      requests.push("sent")
      return new Response("{}", { status: 200 })
    })
    const plugin = createPlugin({
      loadConfig: async () => config({ delay: DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS }),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const hooks = await plugin({
      directory: "/home/tester/awesome-project",
      client: { session: { get: async () => ({ data: {} }) } },
    } as never)
    expect(typeof hooks.dispose).toBe("function")
    const eventHook = hooks.event as (input: { event: unknown }) => Promise<void>
    await eventHook(permissionAsked("per_1"))
    await hooks.dispose?.()
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(requests).toHaveLength(0)
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
    expect(h.sent).toHaveLength(0)
    expect(h.logMessages.some((message) => message.includes('"permission.asked"'))).toBe(true)
  })

  it("contains a synchronously throwing publish during the delayed send", async () => {
    const h = harness({
      publish: () => {
        throw new Error("sync boom")
      },
    })
    await h.handlers.event(permissionAsked("per_1"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.logMessages.some((message) => message.includes("was not sent"))).toBe(true)
  })

  it("survives a failing publish together with a throwing logger at the timer boundary", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = harness({
        publish: async () => {
          throw new Error("ntfy is down")
        },
        log: () => {
          throw new Error("logger boom")
        },
      })
      await h.handlers.event(permissionAsked("per_1"))
      // The timer callback swallows both the publish rejection and the logger
      // throw, so advancing time resolves instead of surfacing either failure.
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
    for (let i = 0; i < 512; i += 1) {
      await h.handlers.event(permissionReplied(`per_${i}`))
    }
    // The 513th reply evicts the oldest remembered ID (per_0).
    await h.handlers.event(permissionReplied("per_512"))
    await h.handlers.event(permissionAsked("per_0"))
    await h.handlers.event(permissionAsked("per_511"))
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(h.sent).toHaveLength(1)
  })
})
