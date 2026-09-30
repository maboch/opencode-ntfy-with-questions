import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import pluginModuleDefault, { createPlugin, projectLabel } from "../src/index.js"
import type { NtfySettings, PluginConfig } from "../src/types.js"

function config(
  overrides: { enabled?: boolean; ntfy?: Partial<NtfySettings> } = {},
): PluginConfig {
  return normalizeConfig({
    enabled: overrides.enabled ?? true,
    ntfy: { topic: "demo-topic", ...overrides.ntfy },
  })
}

function recorder() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response("{}", { status: 200 })
  })
  return { requests, fetchMock }
}

type ToolCallback = (event: { tool: string; input: unknown }) => Promise<void> | void

function makeContext(options: {
  directory?: string
  events?: unknown[]
  getSession?: () => Promise<unknown>
  toolDispose?: () => Promise<void> | void
  hookRegistration?: (name: string, callback: ToolCallback) => Promise<{ dispose: () => Promise<void> | void }>
} = {}) {
  const directory = options.directory ?? "/home/tester/awesome-project"
  const events = options.events ?? []
  const registrations: Array<{ name: string; callback: ToolCallback; dispose: ReturnType<typeof vi.fn> }> = []
  const subscribeState = { count: 0, signal: undefined as AbortSignal | undefined }
  const subscribe = ({ signal }: { signal: AbortSignal }): AsyncIterable<unknown> => {
    subscribeState.count += 1
    subscribeState.signal = signal
    return {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (index < events.length) {
              const value = events[index]
              index += 1
              return Promise.resolve({ done: false, value })
            }
            return new Promise((resolve) => {
              if (signal.aborted) {
                resolve({ done: true, value: undefined })
                return
              }
              signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true })
            })
          },
        }
      },
    }
  }
  const defaultHookRegistration = async (name: string, callback: ToolCallback) => {
    const dispose = vi.fn(async (): Promise<void> => {
      await options.toolDispose?.()
    })
    registrations.push({ name, callback, dispose })
    return { dispose }
  }
  const ctx = {
    location: { directory },
    session: { get: options.getSession ?? (async () => ({})) },
    tool: { hook: options.hookRegistration ?? defaultHookRegistration },
    event: { subscribe },
  }
  return { ctx, registrations, subscribeState }
}

describe("native v2 plugin shape", () => {
  it("exports a Plugin.define shape without any legacy server export", () => {
    expect(pluginModuleDefault.id).toBe("opencode-ntfy-with-questions")
    expect(typeof pluginModuleDefault.setup).toBe("function")
    expect("server" in pluginModuleDefault).toBe(false)
  })

  it("createPlugin returns a plugin value with id and setup", () => {
    const plugin = createPlugin()
    expect(plugin.id).toBe("opencode-ntfy-with-questions")
    expect(typeof plugin.setup).toBe("function")
  })

  it("derives the project label from the location directory", () => {
    expect(projectLabel("/home/tester/awesome-project")).toBe("awesome-project")
    expect(projectLabel("")).toBe("opencode")
  })
})

describe("setup wiring", () => {
  it("registers no hook or stream when the plugin is disabled", async () => {
    const plugin = createPlugin({ loadConfig: async () => config({ enabled: false }) })
    const { ctx, registrations, subscribeState } = makeContext()
    const cleanup = await plugin.setup(ctx as never)
    expect(cleanup).toBeUndefined()
    expect(registrations).toHaveLength(0)
    expect(subscribeState.count).toBe(0)
  })

  it("rejects setup when the config is invalid so initialization fails loudly", async () => {
    const plugin = createPlugin({
      loadConfig: async () => {
        throw new Error("config file not found")
      },
    })
    await expect(plugin.setup(makeContext().ctx as never)).rejects.toThrow(/config file not found/)
  })

  it("registers the execute.before question hook and publishes the full content", async () => {
    const { requests, fetchMock } = recorder()
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations } = makeContext()
    const cleanup = await plugin.setup(ctx as never)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.name).toBe("execute.before")

    await registrations[0]?.callback({
      tool: "question",
      input: {
        questions: [
          { question: "Which?", header: "Pick one", options: [{ label: "A", description: "first" }] },
          { question: "Many?", header: "Multi", multiple: true, options: [] },
        ],
      },
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.body["topic"]).toBe("demo-topic")
    expect(String(requests[0]?.body["title"])).toContain("awesome-project")
    const message = String(requests[0]?.body["message"])
    expect(message).toContain("Which?")
    expect(message).toContain("Multiple answers: allowed")
    await cleanup?.()
  })

  it("subscribes to the global stream, keeps only local events and publishes idle", async () => {
    const { requests, fetchMock } = recorder()
    const directory = "/home/tester/awesome-project"
    const events = [
      { id: "evt_c", type: "session.created", created: 1, location: { directory }, data: { sessionID: "s1" } },
      {
        id: "evt_i",
        type: "session.status",
        created: 1,
        location: { directory },
        data: { sessionID: "s1", status: { type: "idle" } },
      },
      {
        id: "evt_f",
        type: "session.status",
        created: 1,
        location: { directory: "/somewhere/else" },
        data: { sessionID: "s2", status: { type: "idle" } },
      },
    ]
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, subscribeState } = makeContext({ directory, events })
    const cleanup = await plugin.setup(ctx as never)

    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(subscribeState.count).toBe(1)
    const message = String(requests[0]?.body["message"])
    expect(message).toContain("s1")
    expect(message).not.toContain("s2")
    await cleanup?.()
  })

  it("cleanup aborts the stream, disposes the tool hook and is idempotent", async () => {
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations, subscribeState } = makeContext()
    const cleanup = await plugin.setup(ctx as never)
    expect(typeof cleanup).toBe("function")
    await cleanup?.()
    expect(subscribeState.signal?.aborted).toBe(true)
    expect(registrations[0]?.dispose).toHaveBeenCalledTimes(1)
    // A second disposal is a no-op.
    await cleanup?.()
    expect(registrations[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it("does not publish from the question hook after cleanup", async () => {
    const { requests, fetchMock } = recorder()
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations } = makeContext()
    const cleanup = await plugin.setup(ctx as never)
    await cleanup?.()
    await registrations[0]?.callback({
      tool: "question",
      input: { questions: [{ question: "Q?", header: "H", options: [] }] },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toHaveLength(0)
  })
})

describe("cleanup correctness with delayed or failing disposal", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stops pending lookup, grace timer and question publishes once cleanup begins", async () => {
    const { requests, fetchMock } = recorder()
    const directory = "/home/tester/awesome-project"
    let resolveLookup!: (value: unknown) => void
    const lookup = new Promise<unknown>((resolve) => {
      resolveLookup = resolve
    })
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations } = makeContext({
      directory,
      getSession: () => lookup,
      events: [
        {
          id: "idle",
          type: "session.status",
          created: 1,
          location: { directory },
          data: { sessionID: "sess_pending", status: { type: "idle" } },
        },
        {
          id: "perm",
          type: "permission.asked",
          created: 1,
          location: { directory },
          data: { id: "per_1", sessionID: "sess_pending", action: "edit", resources: ["a"] },
        },
      ],
    })
    const cleanup = await plugin.setup(ctx as never)
    await vi.advanceTimersByTimeAsync(0)

    // Cleanup starts while the parent lookup is pending and a grace timer is scheduled.
    const cleanupPromise = cleanup!()
    // A question hook invoked during cleanup must not publish.
    await registrations[0]?.callback({
      tool: "question",
      input: { questions: [{ question: "Q?", header: "H", options: [] }] },
    })
    // Deliver the pending lookup and advance well past the grace period.
    resolveLookup({})
    await vi.advanceTimersByTimeAsync(20000)
    await cleanupPromise
    expect(requests).toHaveLength(0)
  })

  it("disposes handlers before a never-resolving tool hook disposal", async () => {
    const { requests, fetchMock } = recorder()
    let releaseDispose!: () => void
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations } = makeContext({
      toolDispose: () =>
        new Promise<void>((resolve) => {
          releaseDispose = resolve
        }),
    })
    const cleanup = await plugin.setup(ctx as never)
    const cleanupPromise = cleanup!()
    // The external disposal is still pending, yet handlers were disposed first.
    await registrations[0]?.callback({
      tool: "question",
      input: { questions: [{ question: "Q?", header: "H", options: [] }] },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(0)
    expect(registrations[0]?.dispose).toHaveBeenCalledTimes(1)
    releaseDispose()
    await cleanupPromise
  })

  it("attempts every cleanup step, stays memoized and never rejects on a failing tool disposal", async () => {
    const { requests, fetchMock } = recorder()
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, registrations, subscribeState } = makeContext({
      toolDispose: () => {
        throw new Error("dispose boom")
      },
    })
    const cleanup = await plugin.setup(ctx as never)
    const first = cleanup!()
    // Repeated calls return the same in-progress cleanup, never re-registering.
    expect(cleanup!()).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(registrations[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(subscribeState.signal?.aborted).toBe(true)
    // Handlers are disposed: a question hook after cleanup cannot publish.
    await registrations[0]?.callback({
      tool: "question",
      input: { questions: [{ question: "Q?", header: "H", options: [] }] },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(0)
  })

  it("propagates the original registration error without activating an event stream", async () => {
    const { requests, fetchMock } = recorder()
    const plugin = createPlugin({
      loadConfig: async () => config(),
      fetch: fetchMock as unknown as typeof fetch,
      log: () => {},
    })
    const { ctx, subscribeState } = makeContext({
      hookRegistration: async () => {
        throw new Error("registration boom")
      },
    })
    await expect(plugin.setup(ctx as never)).rejects.toThrow(/registration boom/)
    expect(subscribeState.count).toBe(0)
    expect(requests).toHaveLength(0)
  })
})
