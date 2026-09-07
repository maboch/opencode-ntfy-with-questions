import { describe, expect, it, vi } from "vitest"
import { normalizeConfig } from "../src/config.js"
import pluginModuleDefault, {
  createPlugin,
  createPluginHandlers,
  type Logger,
  type OpenCodeClientLike,
  type SessionGetResult,
} from "../src/index.js"
import { createNtfyClient, type NtfyClient, type NtfyMessage } from "../src/ntfy-client.js"
import { SessionRegistry } from "../src/session-registry.js"
import type { NtfySettings, PluginConfig } from "../src/types.js"
function config(overrides: {
  enabled?: boolean
  events?: Record<string, boolean>
  suppressSubagents?: { "session.idle"?: boolean; "session.error"?: boolean }
  ntfy?: Partial<NtfySettings>
} = {}): PluginConfig {
  return normalizeConfig({
    enabled: overrides.enabled ?? true,
    events: overrides.events,
    suppressSubagents: overrides.suppressSubagents,
    ntfy: { topic: "demo-topic", ...overrides.ntfy },
  })
}
function harness(overrides: {
  config?: PluginConfig
  registry?: SessionRegistry
  publish?: (message: NtfyMessage) => Promise<void> | void
  get?: (sessionID: string) => Promise<SessionGetResult>
} = {}) {
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
  const logger: Logger = (message: string) => logMessages.push(message)
  const getMock = vi.fn(
    async (input: { path: { id: string } }) => (overrides.get ? overrides.get(input.path.id) : { data: {} }),
  )
  const client = { session: { get: getMock } } as unknown as OpenCodeClientLike
  const registry = overrides.registry ?? new SessionRegistry()
  const handlers = createPluginHandlers({
    config: overrides.config ?? config(),
    projectName: "demo-project",
    client,
    ntfy,
    registry,
    log: logger,
  })
  return { handlers, sent, logMessages, getMock, registry }
}
const idle = (sessionID: string) => ({ event: { type: "session.idle", properties: { sessionID } } })
const sessionError = (sessionID: string | undefined, error?: unknown) => ({
  event: {
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: error ?? { name: "UnknownError", data: { message: "provider boom" } },
    },
  },
})
const created = (sessionID: string, parentID?: string) => ({
  event: {
    type: "session.created",
    properties: { sessionID, info: { id: sessionID, ...(parentID ? { parentID } : {}) } },
  },
})
const updated = (sessionID: string, parentID?: string) => ({
  event: {
    type: "session.updated",
    properties: { sessionID, info: { id: sessionID, ...(parentID ? { parentID } : {}) } },
  },
})
const deleted = (sessionID: string) => ({
  event: { type: "session.deleted", properties: { sessionID, info: { id: sessionID } } },
})
const permissionAsked = (sessionID: string | undefined) => ({
  event: {
    type: "permission.asked",
    properties: {
      id: "per_1",
      sessionID,
      permission: "edit",
      patterns: ["**/*.ts"],
      metadata: {},
      always: [],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  },
})
const toolInput = (sessionID = "sess_root") => ({ tool: "question", sessionID, callID: "call_42" })
describe("idle and error routing", () => {
  it("notifies on session.idle for a known root session", async () => {
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
  it("notifies on error even without a sessionID", async () => {
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
  it("classifies an unknown session via the fallback lookup and suppresses when it has a parent", async () => {
    const h = harness({ get: async () => ({ data: { parentID: "sess_parent" } }) })
    await h.handlers.event(idle("sess_mystery"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.registry.parentOf("sess_mystery")).toBe("sess_parent")
    // Second event hits the cache and skips the lookup.
    await h.handlers.event(idle("sess_mystery"))
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })
  it("fails open when the fallback lookup returns a root session", async () => {
    const h = harness()
    await h.handlers.event(idle("sess_root_unknown"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("sess_root_unknown")
    expect(h.registry.parentOf("sess_root_unknown")).toBeNull()
    expect(h.logMessages).toHaveLength(0)
  })
  it("fails open with a warning when the fallback lookup reports an error", async () => {
    const h = harness({ get: async () => ({ error: { name: "NotFound" } }) })
    await h.handlers.event(idle("sess_gone"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_gone"))).toBe(true)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
  })
  it("fails open with a warning when the fallback lookup rejects asynchronously", async () => {
    const h = harness({
      get: async () => {
        throw new Error("client down")
      },
    })
    await h.handlers.event(idle("sess_err"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_err"))).toBe(true)
  })
  it("fails open with a warning when the fallback lookup throws synchronously", async () => {
    const h = harness()
    h.getMock.mockImplementationOnce(() => {
      throw new Error("sync boom")
    })
    await h.handlers.event(idle("sess_sync"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_sync"))).toBe(true)
  })
  it("fails open with a warning when the fallback lookup returns no data object", async () => {
    const h = harness({ get: async () => ({ data: undefined }) })
    await h.handlers.event(idle("sess_no_data"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("sess_no_data")
    expect(h.logMessages.some((message) => message.includes("sess_no_data"))).toBe(true)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
    // The failed lookup must not poison the cache with a guessed classification.
    expect(h.registry.parentOf("sess_no_data")).toBeUndefined()
  })
  it("lets a lifecycle cache update supersede an in-flight lookup result", async () => {
    let resolveLookup!: (result: SessionGetResult) => void
    const pendingLookup = new Promise<SessionGetResult>((resolve) => {
      resolveLookup = resolve
    })
    const h = harness({ get: () => pendingLookup })
    const idlePromise = h.handlers.event(idle("sess_race"))
    // While the lookup is still pending, a lifecycle event refreshes the cache.
    await h.handlers.event(created("sess_race", "sess_parent"))
    resolveLookup({ data: {} })
    await idlePromise
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_race")).toBe("sess_parent")
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })
  it("suppresses a child error found only via the fallback lookup", async () => {
    const h = harness({ get: async () => ({ data: { parentID: "sess_parent" } }) })
    await h.handlers.event(sessionError("sess_hidden_child"))
    expect(h.sent).toHaveLength(0)
  })
})
describe("session lifecycle cache", () => {
  it("learns about children from session.created events", async () => {
    const h = harness()
    await h.handlers.event(created("sess_child", "sess_parent"))
    await h.handlers.event(idle("sess_child"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).not.toHaveBeenCalled()
  })
  it("learns about root sessions from session.created events", async () => {
    const h = harness()
    await h.handlers.event(created("sess_root"))
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
  })
  it("accepts lifecycle events whose session id only appears inside info", async () => {
    const h = harness()
    await h.handlers.event({
      event: { type: "session.created", properties: { info: { id: "sess_info_only", parentID: "sess_parent" } } },
    })
    await h.handlers.event(idle("sess_info_only"))
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_info_only")).toBe("sess_parent")
  })
  it("updates classification on session.updated events", async () => {
    const h = harness()
    await h.handlers.event(created("sess_x", "sess_parent"))
    await h.handlers.event(updated("sess_x"))
    await h.handlers.event(idle("sess_x"))
    expect(h.sent).toHaveLength(1)
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
  it("notifies on permission.asked with type and patterns", async () => {
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
  it("respects the permission.asked toggle", async () => {
    const h = harness({ config: config({ events: { "permission.asked": false } }) })
    await h.handlers.event(permissionAsked("sess_root"))
    expect(h.sent).toHaveLength(0)
  })
  it("notifies for permission events without a sessionID", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked(undefined))
    expect(h.sent).toHaveLength(1)
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
      {
        question: "Pick any number?",
        header: "Multi",
        multiple: true,
        options: [{ label: "One", description: "" }],
      },
    ],
  }
  it("notifies from tool.execute.before for the question tool", async () => {
    const h = harness()
    await h.handlers["tool.execute.before"](toolInput(), { args: questionArgs })
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]?.message ?? ""
    expect(h.sent[0]?.title).toContain("demo-project")
    expect(h.sent[0]?.tags).toEqual(["question"])
    expect(message).toContain("Which option do you prefer?")
    expect(message).toContain("Pick one")
    expect(message).toContain("Option A")
    expect(message).toContain("First choice")
    expect(message).toContain("Option B")
    expect(message).toContain("Second choice")
    expect(message).toContain("Multi")
    expect(message).toContain("Pick any number?")
    expect(message).toContain("Multiple answers: allowed")
    expect(message).toContain("Multiple answers: not allowed")
  })
  it("does not notify for other tools", async () => {
    const h = harness()
    await h.handlers["tool.execute.before"](
      { tool: "bash", sessionID: "sess_root", callID: "call_1" },
      { args: {} },
    )
    expect(h.sent).toHaveLength(0)
  })
  it("notifies when a child session asks a question", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers["tool.execute.before"]({ ...toolInput("sess_child") }, { args: questionArgs })
    expect(h.sent).toHaveLength(1)
  })
  it("ignores runtime question.asked events to avoid duplicates", async () => {
    const h = harness()
    await h.handlers.event({
      event: { type: "question.asked", properties: { id: "que_1", sessionID: "sess_root", questions: [], tool: {} } },
    })
    expect(h.sent).toHaveLength(0)
  })
  it("respects the question.asked toggle", async () => {
    const h = harness({ config: config({ events: { "question.asked": false } }) })
    await h.handlers["tool.execute.before"](toolInput(), { args: questionArgs })
    expect(h.sent).toHaveLength(0)
  })
  it("sends one generic notification for malformed question args instead of throwing", async () => {
    const malformed = [
      null,
      undefined,
      "text",
      42,
      {},
      { questions: "nope" },
      { questions: [] },
      { questions: [null] },
      { questions: [{}] },
      // Missing option description: the option is not a valid object.
      { questions: [{ question: "q", header: "h", options: [{ label: "only" }] }] },
      // Non-boolean multiple flag.
      { questions: [{ question: "q", header: "h", multiple: "yes", options: [{ label: "l", description: "d" }] }] },
      // Missing question / header strings.
      { questions: [{ options: [{ label: "l", description: "d" }] }] },
    ]
    for (const args of malformed) {
      const h = harness()
      await expect(h.handlers["tool.execute.before"](toolInput(), { args })).resolves.toBeUndefined()
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]?.tags).toEqual(["question"])
      expect(h.sent[0]?.message).toContain("unreadable question payload")
    }
  })
  it("accepts empty strings and an empty options array as valid questions", async () => {
    const h = harness()
    const args = {
      questions: [
        { question: "", header: "H", options: [] },
        { question: "Q?", header: "", options: [{ label: "", description: "" }] },
      ],
    }
    await h.handlers["tool.execute.before"](toolInput(), { args })
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]?.message ?? ""
    expect(message).toContain("[1] H:")
    expect(message).toContain("[2] Q?")
    expect(message).toContain("Multiple answers: not allowed")
    expect(message).toContain("(unnamed option)")
  })
})
describe("failure containment", () => {
  it("does not reject the hook when publishing rejects asynchronously", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("ntfy is down")
      },
    })
    h.registry.record("sess_root", null)
    await expect(h.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    expect(h.logMessages.length).toBeGreaterThan(0)
  })
  it("does not reject the hook when publishing throws synchronously", async () => {
    const h = harness({
      publish: () => {
        throw new Error("sync publish failure")
      },
    })
    h.registry.record("sess_root", null)
    await expect(h.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    expect(h.logMessages.length).toBeGreaterThan(0)
  })
  it("never blocks the question tool when publishing fails", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("down")
      },
    })
    await expect(
      h.handlers["tool.execute.before"](toolInput(), {
        args: { questions: [{ question: "Go?", options: [{ label: "Yes", description: "" }] }] },
      }),
    ).resolves.toBeUndefined()
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
      client: { session: { get: async () => ({ data: {} }) } } as unknown as OpenCodeClientLike,
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
describe("plugin factory", () => {
  it("exports the V1 module shape expected by the opencode loader", () => {
    expect(pluginModuleDefault.id).toBe("opencode-ntfy-with-questions")
    expect(typeof pluginModuleDefault.server).toBe("function")
  })
  it("returns empty hooks when the plugin is disabled", async () => {
    const plugin = createPlugin({ loadConfig: async () => config({ enabled: false }) })
    const hooks = await plugin({} as never)
    expect(Object.keys(hooks)).toHaveLength(0)
  })
  it("rejects when the config is invalid so initialization fails loudly", async () => {
    const plugin = createPlugin({
      loadConfig: async () => {
        throw new Error("config file not found")
      },
    })
    await expect(plugin({} as never)).rejects.toThrow(/config file not found/)
  })
  it("wires idle events end to end through the factory, publishing to ntfy", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return new Response("{}", { status: 200 })
    })
    const plugin = createPlugin({
      loadConfig: async () => config({ ntfy: { topic: "demo-topic", server: "https://ntfy.sh/" } }),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const hooks = await plugin({
      directory: "/home/tester/awesome-project",
      client: { session: { get: async () => ({ data: {} }) } },
    } as never)
    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    const eventHook = hooks.event as (input: { event: unknown }) => Promise<void>
    await eventHook(idle("sess_root"))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body["topic"]).toBe("demo-topic")
    expect(String(requests[0]?.body["title"])).toContain("awesome-project")
  })
})
