import { describe, expect, it, vi } from "vitest"

import {
  createNtfyClient,
  describeNtfyError,
  NtfyHttpError,
  NtfyTimeoutError,
  NtfyTransportError,
  sanitizeTitle,
  truncateUtf8,
} from "../src/ntfy-client.js"
import type { NtfySettings } from "../src/types.js"

function settings(overrides: Partial<NtfySettings> = {}): NtfySettings {
  return {
    server: "https://ntfy.sh/",
    topic: "my_topic",
    priority: "default",
    timeoutMs: 5000,
    ...overrides,
  }
}

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

type MockFetch = ReturnType<typeof vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>>

function okFetch(): MockFetch {
  return vi.fn(async () => jsonResponse(200))
}

function requestOf(fetchMock: MockFetch): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url, init }
}

describe("publish request construction", () => {
  it("POSTs JSON to the hosted default server with the topic in the body", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })

    await client.publish({ title: "Hello", message: "World", tags: ["tag1"] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://ntfy.sh/")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined()

    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      topic: "my_topic",
      title: "Hello",
      message: "World",
      priority: "default",
      tags: ["tag1"],
    })
  })

  it("keeps a self-hosted reverse-proxy path prefix and sends the bearer token", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(
      settings({ server: "https://ntfy.example.com/notify/", token: "tk_secret", priority: "high" }),
      { fetch: fetchMock as unknown as typeof fetch },
    )

    await client.publish({ title: "T", message: "M", tags: [] })

    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://ntfy.example.com/notify/")
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tk_secret")
    const body = JSON.parse(String(init.body))
    expect(body.priority).toBe("high")
  })

  it("lets a per-message priority override the configured one", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "T", message: "M", tags: [], priority: "min" })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body))
    expect(body.priority).toBe("min")
  })
})

describe("publish failures", () => {
  it("rejects with the HTTP status for non-2xx responses", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500))
    const client = createNtfyClient(settings({ token: "tk_123" }), { fetch: fetchMock as unknown as typeof fetch })

    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyHttpError)
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toThrow(/HTTP status 500/)
  })

  it("never leaks the token, topic or payload in HTTP errors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401))
    const client = createNtfyClient(settings({ token: "tk_123", topic: "secret_topic" }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    try {
      await client.publish({ title: "Secret title", message: "Secret message", tags: [] })
      expect.unreachable("publish should have rejected")
    } catch (error) {
      const message = describeNtfyError(error)
      expect(message).toContain("401")
      expect(message).not.toContain("tk_123")
      expect(message).not.toContain("secret_topic")
      expect(message).not.toContain("Secret title")
      expect(message).not.toContain("Secret message")
    }
  })

  it("rejects as NtfyTransportError when fetch throws synchronously", async () => {
    const fetchMock: MockFetch = vi.fn(() => {
      throw new TypeError("boom")
    })
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTransportError)
  })

  it("rejects as NtfyTransportError when fetch rejects asynchronously", async () => {
    const fetchMock: MockFetch = vi.fn(async () => {
      throw new TypeError("network down")
    })
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTransportError)
  })

  it("rejects as NtfyTimeoutError when the configured timeout elapses", async () => {
    const fetchMock: MockFetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))
        })
      }),
    )
    const client = createNtfyClient(settings({ timeoutMs: 20, token: "tk_123" }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    const started = Date.now()
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTimeoutError)
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toThrow(/timed out after 20ms/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("does not leak the token in transport error descriptions", async () => {
    const fetchMock: MockFetch = vi.fn(async () => {
      throw new TypeError("down")
    })
    const client = createNtfyClient(settings({ token: "tk_123" }), { fetch: fetchMock as unknown as typeof fetch })
    try {
      await client.publish({ title: "T", message: "M", tags: [] })
      expect.unreachable("publish should have rejected")
    } catch (error) {
      expect(describeNtfyError(error)).not.toContain("tk_123")
    }
  })

  it("never surfaces foreign error messages or payload text", () => {
    expect(describeNtfyError(new Error("literal-token-123"))).not.toContain("literal-token-123")
    expect(describeNtfyError("literal-token-123")).toBe("unexpected ntfy publish failure")
    expect(describeNtfyError(new NtfyHttpError("boom", 503))).toBe("ntfy server responded with HTTP status 503")
  })

  it("never embeds thrown error names or thrown strings in transport descriptions", async () => {
    const evil = new Error("literal-token-123")
    evil.name = "literal-token-123"
    const throwingFetches: Array<() => never> = [
      () => {
        throw evil
      },
      () => {
        throw "literal-token-123"
      },
    ]
    const rejectingFetches: Array<() => Promise<never>> = [
      async () => {
        throw evil
      },
      async () => {
        throw "literal-token-123"
      },
    ]
    for (const factory of [...throwingFetches, ...rejectingFetches]) {
      const fetchMock: MockFetch = vi.fn(factory as unknown as MockFetch)
      const client = createNtfyClient(settings({ token: "literal-token-123" }), {
        fetch: fetchMock as unknown as typeof fetch,
      })
      try {
        await client.publish({ title: "T", message: "M", tags: [] })
        expect.unreachable("publish should have rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(NtfyTransportError)
        expect(describeNtfyError(error)).toBe("ntfy publish failed before a response was received")
        expect(describeNtfyError(error)).not.toContain("literal-token-123")
      }
    }
  })
})

describe("truncateUtf8", () => {
  it("returns the input unchanged when it fits", () => {
    expect(truncateUtf8("hello", 1024)).toBe("hello")
  })

  it("cuts ASCII text at the byte budget", () => {
    expect(truncateUtf8("abcdef", 3)).toBe("abc")
  })

  it("never splits a multi-byte UTF-8 character", () => {
    const smiley = "\u{1f600}" // 4 bytes in UTF-8; "a" is 1 byte, "b" is 1 byte
    expect(truncateUtf8(`a${smiley}b`, 3)).toBe("a")
    expect(truncateUtf8(`a${smiley}b`, 4)).toBe("a")
    expect(truncateUtf8(`a${smiley}b`, 5)).toBe(`a${smiley}`)
    expect(truncateUtf8(`a${smiley}b`, 6)).toBe(`a${smiley}b`)
  })

  it("is deterministic", () => {
    const input = "z".repeat(5000)
    expect(truncateUtf8(input, 2048)).toBe(truncateUtf8(input, 2048))
  })
})

describe("sanitizeTitle", () => {
  it("removes control characters", () => {
    expect(sanitizeTitle("line1\nline2\tend\u0000")).toBe("line1 line2 end")
    expect(sanitizeTitle("a\u007fb\u009fc")).toBe("a b c")
  })

  it("trims the result", () => {
    expect(sanitizeTitle("  spaced  ")).toBe("spaced")
  })
})

describe("publish deadline", () => {
  it("rejects with a typed timeout when fetch never settles and ignores its signal", async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchMock: MockFetch = vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal
      return new Promise<Response>(() => {}) // never settles, ignores the signal
    })
    const client = createNtfyClient(settings({ timeoutMs: 30 }), { fetch: fetchMock as unknown as typeof fetch })
    const started = Date.now()
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTimeoutError)
    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toThrow(/timed out after 30ms/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it("absorbs a late fetch resolution after the deadline", async () => {
    let resolveFetch!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock: MockFetch = vi.fn(() => pending)
    const client = createNtfyClient(settings({ timeoutMs: 20 }), { fetch: fetchMock as unknown as typeof fetch })

    await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTimeoutError)
    // The response resolves only after the deadline; it must be absorbed.
    resolveFetch(jsonResponse(200))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // A subsequent publish is unaffected.
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await expect(client.publish({ title: "T2", message: "M2", tags: [] })).resolves.toBeUndefined()
  })

  it("absorbs a late fetch rejection after the deadline without an unhandled rejection", async () => {
    let rejectFetch!: (reason: unknown) => void
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject
    })
    const fetchMock: MockFetch = vi.fn(() => pending)
    const client = createNtfyClient(settings({ timeoutMs: 20 }), { fetch: fetchMock as unknown as typeof fetch })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      await expect(client.publish({ title: "T", message: "M", tags: [] })).rejects.toBeInstanceOf(NtfyTimeoutError)
      // The promise rejects only after the deadline; Promise.race must have
      // already attached a rejection handler so this is not an unhandled
      // rejection and cannot surface anywhere.
      rejectFetch(new Error("literal-token-123"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("keeps early fetch rejections as the fixed transport failure", async () => {
    const fetchMock: MockFetch = vi.fn(async () => {
      throw new TypeError("network down")
    })
    const client = createNtfyClient(settings({ timeoutMs: 2000 }), { fetch: fetchMock as unknown as typeof fetch })
    const started = Date.now()
    try {
      await client.publish({ title: "T", message: "M", tags: [] })
      expect.unreachable("publish should have rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(NtfyTransportError)
      expect(describeNtfyError(error)).toBe("ntfy publish failed before a response was received")
    }
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("publish bounds", () => {
  it("truncates the title to 1024 bytes and the message to 4096 bytes", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({
      title: "t".repeat(5000),
      message: "m".repeat(10_000),
      tags: [],
    })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body)) as { title: string; message: string }
    expect(Buffer.byteLength(body.title, "utf8")).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(body.message, "utf8")).toBeLessThanOrEqual(4096)
  })

  it("truncates on a UTF-8 boundary inside publish", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    const message = "x".repeat(4095).concat("\u{1f600}") // 4-byte char would exceed 4096
    await client.publish({ title: "T", message, tags: [] })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body)) as { message: string }
    expect(Buffer.byteLength(body.message, "utf8")).toBeLessThanOrEqual(4096)
    expect(body.message).not.toContain("\u{fffd}")
  })

  it("preserves newlines in the message body", async () => {
    const fetchMock = okFetch()
    const client = createNtfyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "T", message: "first line\nsecond line", tags: [] })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body)) as { message: string }
    expect(body.message).toBe("first line\nsecond line")
  })
})
