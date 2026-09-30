import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MAX_IN_FLIGHT_IDLE_ERROR, createV2Runtime, isLocalEvent, type RuntimeEventSource } from "../src/v2-runtime.js"

const directory = "/home/tester/proj"

function iterableOf(events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) yield event
  })()
}

function scriptedSource(batches: unknown[][]): { source: RuntimeEventSource; calls: () => number } {
  let calls = 0
  const source: RuntimeEventSource = {
    subscribe: () => {
      const batch = batches[Math.min(calls, batches.length - 1)] ?? []
      calls += 1
      return iterableOf(batch)
    },
  }
  return { source, calls: () => calls }
}

function blockingSource(): {
  source: RuntimeEventSource
  calls: () => number
  aborted: () => boolean
} {
  let calls = 0
  let aborted = false
  const source: RuntimeEventSource = {
    subscribe: ({ signal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (signal.aborted) {
              aborted = true
              return Promise.resolve({ done: true, value: undefined })
            }
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true
                  resolve({ done: true, value: undefined })
                },
                { once: true },
              )
            })
          },
        }
      },
    }),
  }
  return {
    source: {
      subscribe: (options) => {
        calls += 1
        return source.subscribe(options)
      },
    },
    calls: () => calls,
    aborted: () => aborted,
  }
}

const local = (sessionID: string) => ({
  id: `evt_${sessionID}`,
  type: "session.created",
  created: 1,
  location: { directory },
  data: { sessionID },
})

const foreign = (sessionID: string) => ({
  id: `evt_${sessionID}`,
  type: "session.created",
  created: 1,
  location: { directory: "/somewhere/else" },
  data: { sessionID },
})

const missingLocation = (sessionID: string) => ({
  id: `evt_${sessionID}`,
  type: "session.created",
  created: 1,
  data: { sessionID },
})

const localIdle = (sessionID: string) => ({
  id: `evt_idle_${sessionID}`,
  type: "session.status",
  created: 1,
  location: { directory },
  data: { sessionID, status: { type: "idle" } },
})

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

describe("location filtering", () => {
  it("dispatches only events whose location directory matches exactly", async () => {
    const dispatch = vi.fn(async () => {})
    const events = [
      local("sess_local"),
      foreign("sess_foreign"),
      missingLocation("sess_missing"),
      { id: "evt_bad", type: "session.created", created: 1, location: "/not-an-object", data: { sessionID: "sess_bad" } },
    ]
    const { source } = scriptedSource([events])
    const runtime = createV2Runtime({ events: source, directory, dispatch })
    runtime.start()
    await flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(events[0])
    await runtime.dispose()
  })

  it("exposes a strict location helper", () => {
    expect(isLocalEvent(local("a"), directory)).toBe(true)
    expect(isLocalEvent(foreign("a"), directory)).toBe(false)
    expect(isLocalEvent(missingLocation("a"), directory)).toBe(false)
    expect(isLocalEvent(null, directory)).toBe(false)
  })
})

describe("reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("never tight-loops on an empty stream and backs off 1s, 2s, 4s, 8s, 16s, 30s", async () => {
    const { source, calls } = scriptedSource([[]])
    const runtime = createV2Runtime({ events: source, directory, dispatch: async () => {} })
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls()).toBe(4)
    await vi.advanceTimersByTimeAsync(8000)
    expect(calls()).toBe(5)
    await vi.advanceTimersByTimeAsync(16000)
    expect(calls()).toBe(6)
    await vi.advanceTimersByTimeAsync(30000)
    expect(calls()).toBe(7)
    await vi.advanceTimersByTimeAsync(30000)
    expect(calls()).toBe(8)
    await runtime.dispose()
  })

  it("does not reset the backoff on local unknown or malformed frames", async () => {
    const unknownFrame = { id: "u", type: "unknown.route", created: 1, location: { directory }, data: {} }
    const malformedKnown = { id: "m", type: "session.created", created: 1, location: { directory }, data: null }
    const foreignValid = {
      id: "f",
      type: "session.created",
      created: 1,
      location: { directory: "/somewhere/else" },
      data: { sessionID: "sess_foreign" },
    }
    const { source, calls } = scriptedSource([[unknownFrame, malformedKnown, foreignValid]])
    const dispatch = vi.fn(async () => {})
    const runtime = createV2Runtime({ events: source, directory, dispatch })
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)
    // No frame is recognized native and local, so nothing is dispatched.
    expect(dispatch).not.toHaveBeenCalled()
    // Backoff still progresses 1s, 2s, 4s - the invalid frames did not reset it.
    await vi.advanceTimersByTimeAsync(999)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(3999)
    expect(calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(4)
    await runtime.dispose()
  })

  it("resets the backoff to 1s after an accepted local native event", async () => {
    const { source, calls } = scriptedSource([[], [], [local("sess_reset")]])
    const dispatch = vi.fn(async () => {})
    const runtime = createV2Runtime({ events: source, directory, dispatch })
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls()).toBe(2)
    // Third connection delivers a real local native event, resetting the backoff.
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls()).toBe(3)
    expect(dispatch).toHaveBeenCalledTimes(1)
    // The next reconnect waits 1s again, not 4s.
    await vi.advanceTimersByTimeAsync(999)
    expect(calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls()).toBe(4)
    await runtime.dispose()
  })

  it("resets the backoff after a stable 30s connection", async () => {
    const { source, calls } = scriptedSource([[]])
    // The loop reads the clock twice per iteration (start, then after EOF).
    const times = [0, 0, 1000, 31000, 31000, 62000]
    let index = 0
    const now = (): number => times[Math.min(index, times.length - 1)] ?? 0
    const runtime = createV2Runtime({
      events: source,
      directory,
      dispatch: async () => {},
      now: () => {
        const value = now()
        index += 1
        return value
      },
    })
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)
    // Connection 2 stayed up 30s, so the next wait is 1s, not 2s.
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls()).toBe(3)
    await runtime.dispose()
  })
})

describe("concurrency bound for idle/error notifications", () => {
  it("caps idle/error dispatches at 64 while still delivering lifecycle events", async () => {
    const never = (): Promise<void> => new Promise<void>(() => {})
    const dispatch = vi.fn(never)
    const logMessages: string[] = []
    const events = [...Array.from({ length: 70 }, (_unused, i) => localIdle(`sess_${i}`)), local("sess_lifecycle")]
    const { source } = scriptedSource([events])
    const runtime = createV2Runtime({
      events: source,
      directory,
      dispatch,
      log: (message) => logMessages.push(message),
    })
    runtime.start()
    await flush()
    // 64 idle operations are in flight; the lifecycle event still dispatches.
    expect(dispatch).toHaveBeenCalledTimes(MAX_IN_FLIGHT_IDLE_ERROR + 1)
    const overflowWarnings = logMessages.filter((message) => message.includes("too many concurrent notifications"))
    expect(overflowWarnings).toHaveLength(1)
    await runtime.dispose()
  })
})

describe("cleanup and failure containment", () => {
  it("aborts the stream, prevents reconnect and is idempotent", async () => {
    const blocking = blockingSource()
    const runtime = createV2Runtime({ events: blocking.source, directory, dispatch: async () => {} })
    runtime.start()
    await flush()
    expect(blocking.calls()).toBe(1)
    await runtime.dispose()
    expect(blocking.aborted()).toBe(true)
    await runtime.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(blocking.calls()).toBe(1)
  })

  it("contains a throwing logger and a rejected dispatch without crashing", async () => {
    const { source } = scriptedSource([[local("sess_x")], []])
    const runtime = createV2Runtime({
      events: source,
      directory,
      dispatch: async () => {
        throw new Error("dispatch boom")
      },
      log: () => {
        throw new Error("logger boom")
      },
    })
    runtime.start()
    await flush()
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })
})
