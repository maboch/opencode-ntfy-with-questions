import { describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPluginHandlers, type Logger, type SessionLookupResult } from "../src/notification-handlers.js"
import { createNtfyClient, type NtfyClient, type NtfyMessage } from "../src/ntfy-client.js"
import { SessionRegistry } from "../src/session-registry.js"
import type { NtfySettings, PluginConfig } from "../src/types.js"

function config(
  overrides: {
    enabled?: boolean
    events?: Record<string, boolean>
    suppressSubagents?: { "session.idle"?: boolean; "session.error"?: boolean }
    ntfy?: Partial<NtfySettings>
  } = {},
): PluginConfig {
  return normalizeConfig({
    permissionNotificationDelayMs: 0,
    enabled: overrides.enabled ?? true,
    events: overrides.events,
    suppressSubagents: overrides.suppressSubagents,
    ntfy: { topic: "demo-topic", ...overrides.ntfy },
  })
}

function harness(
  overrides: {
    config?: PluginConfig
    registry?: SessionRegistry
    publish?: (message: NtfyMessage) => Promise<void> | void
    get?: (sessionID: string) => Promise<SessionLookupResult>
    log?: Logger
  } = {},
) {
  const sent: NtfyMessage[] = []
  const publish =
    overrides.publish ??
    (async (message: NtfyMessage) => {
      sent.push(message)
    })
  // A sync-throwing publish must still reach the handler untouched, so the
  // publish is cast instead of wrapped in an async adapter.
  const ntfy = { publish } as unknown as NtfyClient
  const logMessages: string[] = []
  const logger: Logger = overrides.log ?? ((message: string) => logMessages.push(message))
  const getMock = vi.fn(async (sessionID: string) => (overrides.get ? overrides.get(sessionID) : {}))
  const registry = overrides.registry ?? new SessionRegistry()
  const handlers = createPluginHandlers({
    config: overrides.config ?? config(),
    projectName: "demo-project",
    getSession: getMock,
    ntfy,
    registry,
    log: logger,
  })
  return { handlers, sent, logMessages, getMock, registry }
}

const idle = (sessionID: string) => ({
  event: { id: "evt_idle", type: "session.status", created: 1, data: { sessionID, status: { type: "idle" } } },
})
const sessionError = (sessionID: string | undefined, error?: unknown) => ({
  event: {
    id: "evt_err",
    type: "session.execution.failed",
    created: 1,
    data: { ...(sessionID ? { sessionID } : {}), error: error ?? { type: "UnknownError", message: "provider boom" } },
  },
})
const created = (sessionID: string, parentID?: string) => ({
  event: { id: "evt_created", type: "session.created", created: 1, data: { sessionID, ...(parentID ? { parentID } : {}) } },
})
const deleted = (sessionID: string) => ({
  event: { id: "evt_deleted", type: "session.deleted", created: 1, data: { sessionID } },
})
const permissionAsked = (sessionID: string | undefined) => ({
  event: {
    id: "evt_perm",
    type: "permission.asked",
    created: 1,
    data: { id: "per_1", ...(sessionID ? { sessionID } : {}), action: "edit", resources: ["**/*.ts"] },
  },
})

describe("idle and error routing", () => {
  it("notifies on session.status idle for a known root session", async () => {
    const h = harness()
    h.registry.record("sess_root", null)
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("demo-project")
    expect(h.sent[0]?.message).toContain("sess_root")
    expect(h.sent[0]?.tags).toEqual(["hourglass_done"])
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("suppresses idle for a known child session", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(idle("sess_child"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("suppresses error for a known child session", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(sessionError("sess_child"))
    expect(h.sent).toHaveLength(0)
  })

  it("notifies on a terminal failure even without a sessionID", async () => {
    const h = harness()
    await h.handlers.event(sessionError(undefined))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["warning"])
    expect(h.sent[0]?.message).toContain("provider boom")
  })

  it("respects the session.error and session.idle event toggles", async () => {
    const h = harness({ config: config({ events: { "session.error": false } }) })
    await h.handlers.event(sessionError(undefined))
    expect(h.sent).toHaveLength(0)
    h.registry.record("sess_root", null)
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
  })

  it("notifies child idle/error when suppressSubagents is disabled", async () => {
    const h = harness({ config: config({ suppressSubagents: { "session.idle": false, "session.error": false } }) })
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(idle("sess_child"))
    await h.handlers.event(sessionError("sess_child"))
    expect(h.sent).toHaveLength(2)
  })
})

describe("subagent classification", () => {
  it("classifies an unknown session via the direct lookup and suppresses when it has a parent", async () => {
    const h = harness({ get: async () => ({ parentID: "sess_parent" }) })
    await h.handlers.event(idle("sess_mystery"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.registry.parentOf("sess_mystery")).toBe("sess_parent")
    // Second event hits the cache and skips the lookup.
    await h.handlers.event(idle("sess_mystery"))
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("fails open when the lookup reports a root session", async () => {
    const h = harness()
    await h.handlers.event(idle("sess_root_unknown"))
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_root_unknown")).toBeNull()
    expect(h.logMessages).toHaveLength(0)
  })

  it("fails open with a warning when the lookup rejects", async () => {
    const h = harness({
      get: async () => {
        throw new Error("client down")
      },
    })
    await h.handlers.event(idle("sess_err"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_err"))).toBe(true)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
  })

  it("fails open with a warning when the lookup throws synchronously", async () => {
    const h = harness()
    h.getMock.mockImplementationOnce(() => {
      throw new Error("sync boom")
    })
    await h.handlers.event(idle("sess_sync"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_sync"))).toBe(true)
  })

  it("fails open with a warning when the lookup returns an invalid result", async () => {
    const h = harness({ get: async () => null as unknown as SessionLookupResult })
    await h.handlers.event(idle("sess_no_data"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
    // The failed lookup must not poison the cache with a guessed classification.
    expect(h.registry.parentOf("sess_no_data")).toBeUndefined()
  })

  it("lets a lifecycle cache update supersede an in-flight lookup result", async () => {
    let resolveLookup!: (result: SessionLookupResult) => void
    const pendingLookup = new Promise<SessionLookupResult>((resolve) => {
      resolveLookup = resolve
    })
    const h = harness({ get: () => pendingLookup })
    const idlePromise = h.handlers.event(idle("sess_race"))
    // While the lookup is still pending, a lifecycle event refreshes the cache.
    await h.handlers.event(created("sess_race", "sess_parent"))
    resolveLookup({})
    await idlePromise
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_race")).toBe("sess_parent")
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("suppresses a child error found only via the fallback lookup", async () => {
    const h = harness({ get: async () => ({ parentID: "sess_parent" }) })
    await h.handlers.event(sessionError("sess_hidden_child"))
    expect(h.sent).toHaveLength(0)
  })
})

describe("session lifecycle cache", () => {
  it("learns about children and root sessions from session.created", async () => {
    const h = harness()
    await h.handlers.event(created("sess_child", "sess_parent"))
    await h.handlers.event(created("sess_root"))
    await h.handlers.event(idle("sess_child"))
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("cleans the cache on session.deleted and falls back to the lookup again", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(deleted("sess_child"))
    expect(h.registry.parentOf("sess_child")).toBeUndefined()
    await h.handlers.event(idle("sess_child"))
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.sent).toHaveLength(1)
  })
})

describe("permission routing", () => {
  it("notifies on permission.asked with action and resources", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["lock"])
    expect(h.sent[0]?.message).toContain('"edit"')
    expect(h.sent[0]?.message).toContain("**/*.ts")
    expect(h.sent[0]?.message).toContain("sess_root")
  })

  it("always notifies for permissions from child sessions", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(permissionAsked("sess_child"))
    expect(h.sent).toHaveLength(1)
  })

  it("respects the permission.asked toggle and tolerates a missing sessionID", async () => {
    const off = harness({ config: config({ events: { "permission.asked": false } }) })
    await off.handlers.event(permissionAsked("sess_root"))
    expect(off.sent).toHaveLength(0)
    const on = harness()
    await on.handlers.event(permissionAsked(undefined))
    expect(on.sent).toHaveLength(1)
  })
})

describe("question routing", () => {
  const questionArgs = {
    questions: [
      {
        question: "Which option do you prefer?",
        header: "Pick one",
        options: [
          { label: "Option A", description: "First choice" },
          { label: "Option B", description: "Second choice" },
        ],
      },
      { question: "Pick any number?", header: "Multi", multiple: true, options: [{ label: "One", description: "" }] },
    ],
  }

  it("notifies from the question hook with the full formatted content", async () => {
    const h = harness()
    await h.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]?.message ?? ""
    expect(h.sent[0]?.tags).toEqual(["question"])
    expect(message).toContain("Which option do you prefer?")
    expect(message).toContain("Option A")
    expect(message).toContain("Multiple answers: allowed")
    expect(message).toContain("Multiple answers: not allowed")
  })

  it("does not notify for other tools or when the question toggle is off", async () => {
    const h = harness()
    await h.handlers.question("bash", questionArgs)
    const off = harness({ config: config({ events: { "question.asked": false } }) })
    await off.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(0)
    expect(off.sent).toHaveLength(0)
  })

  it("notifies when a child session asks a question", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(1)
  })

  it("sends one generic notification for malformed args instead of throwing", async () => {
    for (const args of [null, undefined, "text", {}, { questions: [] }]) {
      const h = harness()
      await expect(h.handlers.question("question", args)).resolves.toBeUndefined()
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]?.message).toContain("unreadable question payload")
    }
  })
})

describe("failure containment", () => {
  it("contains an async and a synchronous publish failure", async () => {
    const asyncFailure = harness({
      publish: async () => {
        throw new Error("ntfy is down")
      },
    })
    asyncFailure.registry.record("sess_root", null)
    await expect(asyncFailure.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    expect(asyncFailure.logMessages.length).toBeGreaterThan(0)

    const syncFailure = harness({
      publish: () => {
        throw new Error("sync publish failure")
      },
    })
    syncFailure.registry.record("sess_root", null)
    await expect(syncFailure.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
  })

  it("never blocks the question tool when publishing fails", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("down")
      },
    })
    await expect(h.handlers.question("question", { questions: [{ question: "Go?", header: "H", options: [] }] })).resolves.toBeUndefined()
  })

  it("survives a throwing logger during a publish failure", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("down")
      },
      log: () => {
        throw new Error("logger boom")
      },
    })
    h.registry.record("sess_root", null)
    await expect(h.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    await expect(h.handlers.question("question", { questions: [] })).resolves.toBeUndefined()
  })
})

describe("log redaction", () => {
  it("never logs the token, topic or notification payload", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network exploded")
    })
    const ntfySettings: NtfySettings = {
      server: "https://ntfy.example.com/",
      topic: "demo-topic",
      token: "super-secret-token-xyz",
      priority: "default",
      timeoutMs: 5000,
    }
    const logMessages: string[] = []
    const handlers = createPluginHandlers({
      config: config({ ntfy: ntfySettings }),
      projectName: "demo-project",
      getSession: async () => ({}),
      ntfy: createNtfyClient(ntfySettings, { fetch: fetchMock as unknown as typeof fetch }),
      registry: new SessionRegistry(),
      log: (message) => logMessages.push(message),
    })
    await handlers.event(idle("sess_root"))
    expect(fetchMock).toHaveBeenCalled()
    const joined = logMessages.join("\n")
    expect(joined).not.toContain("super-secret-token-xyz")
    expect(joined).not.toContain("demo-topic")
    expect(joined).not.toContain("sess_root")
  })
})
