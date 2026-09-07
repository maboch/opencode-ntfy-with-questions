import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  ConfigError,
  loadConfigFile,
  normalizeConfig,
  normalizeServerUrl,
  parseConfigText,
  resolveConfigFilePath,
} from "../src/config.js"
import { MAX_REFERENCED_FILE_BYTES, notificationKinds } from "../src/types.js"

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-config-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function writeConfig(text: string, dir: string): Promise<string> {
  const dirName = join(dir, "opencode")
  await mkdir(dirName, { recursive: true })
  const filePath = join(dirName, "notification-ntfy-with-questions.json")
  await writeFile(filePath, text, "utf8")
  return filePath
}

/** Resolves a rejected promise to its error for message assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the promise to reject")
}

describe("config file path", () => {
  it("uses $XDG_CONFIG_HOME when set", () => {
    expect(resolveConfigFilePath({ XDG_CONFIG_HOME: "/custom/config" }, "/home/tester")).toBe(
      join("/custom/config", "opencode", "notification-ntfy-with-questions.json"),
    )
  })

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", () => {
    const expected = join("/home/tester", ".config", "opencode", "notification-ntfy-with-questions.json")
    expect(resolveConfigFilePath({}, "/home/tester")).toBe(expected)
    expect(resolveConfigFilePath({ XDG_CONFIG_HOME: "" }, "/home/tester")).toBe(expected)
  })
})

describe("loadConfigFile", () => {
  it("fails with an actionable error when the config file is missing", async () => {
    const dir = await makeDir()
    const missing = join(dir, "opencode", "notification-ntfy-with-questions.json")
    const error = await rejectionOf(loadConfigFile(missing))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe("config.unreadable")
    expect(error.message).toMatch(/config file not found/)
    expect(error.message).toContain(missing)
  })

  it("loads a minimal config with defaults applied", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "my-topic" } }), dir)
    const config = await loadConfigFile(filePath)
    expect(config.enabled).toBe(true)
    for (const kind of notificationKinds) expect(config.events[kind]).toBe(true)
    expect(config.suppressSubagents).toEqual({ "session.idle": true, "session.error": true })
    expect(config.ntfy.server).toBe("https://ntfy.sh/")
    expect(config.ntfy.topic).toBe("my-topic")
    expect(config.ntfy.priority).toBe("default")
    expect(config.ntfy.timeoutMs).toBe(5000)
    expect(config.ntfy.token).toBeUndefined()
  })

  it("rejects invalid JSON and never echoes the file content", async () => {
    const dir = await makeDir()
    // Deliberately invalid JSON that still contains a secret-looking value.
    const filePath = await writeConfig('{"ntfy":{"topic":"sup3rs3cret-content"', dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe("config.invalidJson")
    expect(error.message).toMatch(/not valid JSON/)
    expect(error.message).not.toContain("sup3rs3cret-content")
  })
})

describe("validation", () => {
  it("accepts a complete config", () => {
    const raw = {
      $schema: "https://example.invalid/schema.json",
      enabled: true,
      events: { "session.idle": true, "session.error": false, "permission.asked": true, "question.asked": false },
      suppressSubagents: { "session.idle": false, "session.error": true },
      ntfy: {
        server: "https://ntfy.example.com/prefix",
        topic: "opencode_alerts-1",
        token: "tk_123",
        priority: "high",
        timeoutMs: 30000,
      },
    }
    const config = normalizeConfig(raw)
    expect(config.ntfy.server).toBe("https://ntfy.example.com/prefix/")
    expect(config.events["session.error"]).toBe(false)
    expect(config.suppressSubagents["session.idle"]).toBe(false)
    expect(config.ntfy.priority).toBe("high")
  })

  const invalidCases: Array<[string, unknown, RegExp]> = [
    ["non-object top level", [1, 2], /top level/],
    ["unknown top-level key", { unknownKey: true, ntfy: { topic: "t" } }, /unknown top-level property "unknownKey"/],
    ["events not object", { events: true, ntfy: { topic: "t" } }, /"events" must be an object/],
    ["unknown event key", { events: { "session.bogus": true }, ntfy: { topic: "t" } }, /"events.session.bogus"/],
    ["non-boolean event value", { events: { "session.idle": "yes" }, ntfy: { topic: "t" } }, /must be a boolean/],
    [
      "suppressSubagents unknown key",
      { suppressSubagents: { "permission.asked": false }, ntfy: { topic: "t" } },
      /not a supported property/,
    ],
    ["suppressSubagents non boolean", { suppressSubagents: { "session.idle": 1 }, ntfy: { topic: "t" } }, /must be a boolean/],
    ["missing ntfy", {}, /required property "ntfy" is missing/],
    ["ntfy not object", { ntfy: "nope" }, /"ntfy" must be an object/],
    ["ntfy unknown key", { ntfy: { topic: "t", secret: "x" } }, /"ntfy.secret"/],
    ["missing topic", { ntfy: {} }, /required property "ntfy.topic"/],
    ["empty topic", { ntfy: { topic: "" } }, /"ntfy.topic"/],
    ["topic with space", { ntfy: { topic: "a b" } }, /"ntfy.topic"/],
    ["topic too long", { ntfy: { topic: "x".repeat(65) } }, /"ntfy.topic"/],
    ["non-string topic", { ntfy: { topic: 7 } }, /required property "ntfy.topic"/],
    ["server not http", { ntfy: { topic: "t", server: "ftp://ntfy.sh" } }, /http/],
    ["server with credentials", { ntfy: { topic: "t", server: "https://user:pass@ntfy.sh" } }, /credentials/],
    ["server with query", { ntfy: { topic: "t", server: "https://ntfy.sh/?a=b" } }, /query string/],
    ["server with empty query delimiter", { ntfy: { topic: "t", server: "https://x.test/?" } }, /query string/],
    ["server with fragment", { ntfy: { topic: "t", server: "https://ntfy.sh/#frag" } }, /fragment/],
    ["server with empty fragment delimiter", { ntfy: { topic: "t", server: "https://x.test/#" } }, /fragment/],
    ["server with whitespace", { ntfy: { topic: "t", server: "https://x.test /x" } }, /must not contain whitespace/],
    ["server with bare percent host", { ntfy: { topic: "t", server: "https://%/" } }, /not a valid URL/],
    ["server with invalid port", { ntfy: { topic: "t", server: "https://x.test:abc" } }, /not a valid URL/],
    ["server out of range port", { ntfy: { topic: "t", server: "https://x.test:99999" } }, /not a valid URL/],
    ["non-string server", { ntfy: { topic: "t", server: 42 } }, /must be a non-empty string/],
    ["token not a string", { ntfy: { topic: "t", token: 42 } }, /"ntfy.token"/],
    ["token empty", { ntfy: { topic: "t", token: "" } }, /"ntfy.token"/],
    ["invalid priority", { ntfy: { topic: "t", priority: "urgent" } }, /priority/],
    ["timeout not a number", { ntfy: { topic: "t", timeoutMs: "soon" } }, /timeoutMs/],
    ["timeout non-integer", { ntfy: { topic: "t", timeoutMs: 1.5 } }, /timeoutMs/],
    ["timeout too small", { ntfy: { topic: "t", timeoutMs: 0 } }, /timeoutMs.*between 1 and 60000/],
    ["timeout negative", { ntfy: { topic: "t", timeoutMs: -5 } }, /timeoutMs/],
    ["timeout too large", { ntfy: { topic: "t", timeoutMs: 60001 } }, /timeoutMs.*between 1 and 60000/],
    ["enabled not boolean", { enabled: "yes", ntfy: { topic: "t" } }, /"enabled"/],
  ]

  for (const [name, raw, pattern] of invalidCases) {
    it(`rejects: ${name}`, () => {
      expect(() => normalizeConfig(raw)).toThrow(pattern)
    })
  }
})

describe("size limits", () => {
  it("rejects a config file larger than 64 KiB without leaking content", async () => {
    const dir = await makeDir()
    const big = JSON.stringify({ ntfy: { topic: "t" }, padding: "x".repeat(70 * 1024) })
    const filePath = await writeConfig(big, dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.tooLarge")
    expect(error.message).not.toContain("x".repeat(20))
  })

  it("rejects referenced files larger than 16 KiB without leaking content", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: "{file:secret.txt}" } }), dir)
    const secret = join(dir, "opencode", "secret.txt")
    await writeFile(secret, "x".repeat(MAX_REFERENCED_FILE_BYTES + 1), "utf8")
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.fileTooLarge")
    expect(error.message).toContain("secret.txt")
    expect(error.message).not.toContain("x".repeat(20))
  })

  it("rejects environment values larger than 16 KiB, naming variable and limit only", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_HUGE}" } }
    const error = await rejectionOf(
      parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_HUGE: "e".repeat(MAX_REFERENCED_FILE_BYTES + 1) } }),
    )
    expect((error as ConfigError).code).toBe("config.envTooLarge")
    expect(error.message).toContain("NTFY_HUGE")
    expect(error.message).not.toContain("eee")
  })

  it("rejects aggregate expanded configs larger than 64 KiB without leaking content", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(
      JSON.stringify({
        a: "{file:blob-0.txt}",
        b: "{file:blob-1.txt}",
        c: "{file:blob-2.txt}",
        d: "{file:blob-3.txt}",
        e: "{file:blob-4.txt}",
      }),
      dir,
    )
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(dir, "opencode", `blob-${i}.txt`), "b".repeat(MAX_REFERENCED_FILE_BYTES), "utf8")
    }
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.expandedTooLarge")
    expect(error.message).not.toContain("bbb")
  })
})

describe("token substitution", () => {
  it("substitutes {env:VAR} from the provided environment", async () => {
    const raw = { ntfy: { topic: "{env:NTFY_TOPIC}", token: "{env:NTFY_TOKEN}" } }
    const config = await parseConfigText(JSON.stringify(raw), {
      dir: "/tmp",
      env: { NTFY_TOPIC: "env-topic", NTFY_TOKEN: "env-token" },
    })
    expect(config.ntfy.topic).toBe("env-topic")
    expect(config.ntfy.token).toBe("env-token")
  })

  it("fails on a missing environment variable, naming only the variable", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_MISSING_TOKEN}" } }
    const error = await rejectionOf(parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { OTHER: "value" } }))
    expect(error.message).toMatch(/environment variable "NTFY_MISSING_TOKEN"/)
    expect(error.message).not.toMatch(/value/)
  })

  it("fails on an empty environment variable value", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_EMPTY}" } }
    const error = await rejectionOf(parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_EMPTY: "" } }))
    expect((error as ConfigError).code).toBe("config.envUnset")
  })

  it("never includes substituted values in validation errors", async () => {
    const raw = { ntfy: { topic: "ok-topic", token: "{env:NTFY_HUSH}" }, unknownField: true }
    const error = await rejectionOf(
      parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_HUSH: "sup3rs3cret" } }),
    )
    expect(error.message).toContain("unknownField")
    expect(error.message).not.toContain("sup3rs3cret")
  })

  it("substitutes {file:path} relative to the config directory", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "{file:topic.txt}" } }), dir)
    await writeFile(join(dir, "opencode", "topic.txt"), "file-topic\n", "utf8")
    const config = await loadConfigFile(filePath)
    expect(config.ntfy.topic).toBe("file-topic")
  })

  it("supports absolute file paths", async () => {
    const dir = await makeDir()
    const secret = join(dir, "abs-secret.txt")
    await writeFile(secret, "  abs-token  ", "utf8")
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: `{file:${secret}}` } }), dir)
    const config = await loadConfigFile(filePath)
    expect(config.ntfy.token).toBe("abs-token")
  })

  it("supports ~/ file paths resolved against the home directory", async () => {
    const dir = await makeDir()
    const home = join(dir, "home")
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "tilde-token.txt"), "tilde-token", "utf8")
    const config = await parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:~/tilde-token.txt}" } }), {
      dir,
      home,
    })
    expect(config.ntfy.token).toBe("tilde-token")
  })

  it("fails when a referenced file is missing, naming only the path", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: "{file:missing.txt}" } }), dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect(error.message).toContain("missing.txt")
    expect((error as ConfigError).code).toBe("config.fileUnreadable")
  })

  it("recurses through nested structures before validation", async () => {
    const config = await parseConfigText(
      JSON.stringify({
        $schema: "{env:NTFY_SCHEMA}",
        ntfy: { topic: "{env:NTFY_TOPIC}", server: "{env:NTFY_SERVER}" },
        events: { "session.idle": true },
      }),
      {
        dir: "/tmp",
        env: { NTFY_SCHEMA: "https://example.invalid/s.json", NTFY_TOPIC: "nested-topic", NTFY_SERVER: "https://ntfy.example.com" },
      },
    )
    expect(config.ntfy.topic).toBe("nested-topic")
    expect(config.ntfy.server).toBe("https://ntfy.example.com/")
  })

  it("does not rescan substituted content for further tokens", async () => {
    const dir = await makeDir()
    await writeFile(join(dir, "payload.txt"), "{env:NTFY_SHOULD_NOT_EXPAND}", "utf8")
    const config = await parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:payload.txt}" } }), {
      dir,
      env: {},
    })
    expect(config.ntfy.token).toBe("{env:NTFY_SHOULD_NOT_EXPAND}")
  })

  it("rejects references embedded in surrounding text", async () => {
    const badValues = [
      "{env:NTFY_TOPIC}-suffix",
      "prefix-{env:NTFY_TOPIC}",
      "{env:NTFY_A}{env:NTFY_B}",
      "{file:topic.txt}/extra",
    ]
    for (const value of badValues) {
      const error = await rejectionOf(
        parseConfigText(JSON.stringify({ ntfy: { topic: value } }), { dir: "/tmp", env: { NTFY_TOPIC: "t" } }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).toContain("entire string value")
    }
  })

  it("rejects empty, whitespace-only and malformed references", async () => {
    const badValues = ["{env:}", "{env:   }", "{file:}", "{file:   }", "{env:a{b}", "{file:a}b", "{env:}x", "{env:}x", "{{env:A}}"]
    for (const value of badValues) {
      const error = await rejectionOf(
        parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: value } }), { dir: "/tmp", env: {} }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).not.toContain(value)
    }
  })

  it("keeps ordinary strings with unrelated braces as literals", async () => {
    const config = await parseConfigText(
      JSON.stringify({ ntfy: { topic: "t", token: "abc{x}y{z}" } }),
      { dir: "/tmp" },
    )
    expect(config.ntfy.token).toBe("abc{x}y{z}")
  })
})

describe("normalizeServerUrl", () => {
  it("keeps a reverse-proxy path prefix and adds one trailing slash", () => {
    expect(normalizeServerUrl("https://ntfy.example.com/notify")).toBe("https://ntfy.example.com/notify/")
    expect(normalizeServerUrl("https://ntfy.example.com/notify/")).toBe("https://ntfy.example.com/notify/")
    expect(normalizeServerUrl("https://ntfy.example.com/a///")).toBe("https://ntfy.example.com/a/")
  })

  it("preserves an explicit port", () => {
    expect(normalizeServerUrl("http://localhost:8090")).toBe("http://localhost:8090/")
  })

  it("rejects raw whitespace and empty query/fragment delimiters", () => {
    expect(() => normalizeServerUrl("https://x.test /x")).toThrow(/must not contain whitespace/)
    expect(() => normalizeServerUrl("https://x.test\t")).toThrow(/must not contain whitespace/)
    expect(() => normalizeServerUrl("https://x.test/?")).toThrow(/query string/)
    expect(() => normalizeServerUrl("https://x.test/#")).toThrow(/fragment/)
  })

  it("rejects malformed hosts and ports", () => {
    expect(() => normalizeServerUrl("https://%/")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:abc")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:65536")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://")).toThrow(/not a valid URL|include a host/)
  })

  it("rejects raw syntax that a lenient URL parser would accept", () => {
    // Triple-slash authorities are folded into a path by new URL.
    expect(() => normalizeServerUrl("http:///ntfy.example.com")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https:///x.test")).toThrow(/not a valid URL/)
    // Zero-padded ports are silently dropped by new URL.
    expect(() => normalizeServerUrl("https://x.test:080")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:00080")).toThrow(/not a valid URL/)
    // Percent-encoded host characters are not host syntax.
    expect(() => normalizeServerUrl("http://foo%20bar.test")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("http://foo%23bar.test")).toThrow(/not a valid URL/)
  })

  it("accepts canonical ports, encoded paths and IPv6", () => {
    expect(normalizeServerUrl("https://x.test:0/")).toBe("https://x.test:0/")
    expect(normalizeServerUrl("https://x.test:65535")).toBe("https://x.test:65535/")
    expect(normalizeServerUrl("https://ntfy.example.com/a%20b")).toBe("https://ntfy.example.com/a%20b/")
    expect(normalizeServerUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/")
  })

  it("accepts nested and percent-encoded path segments", () => {
    expect(normalizeServerUrl("https://x.test/")).toBe("https://x.test/")
    expect(normalizeServerUrl("https://x.test/a/b")).toBe("https://x.test/a/b/")
    expect(normalizeServerUrl("https://x.test/%20/%23/%3F")).toBe("https://x.test/%20/%23/%3F/")
    expect(normalizeServerUrl("https://x.test/%C3%A9/na%C3%AFve")).toBe("https://x.test/%C3%A9/na%C3%AFve/")
  })

  it("rejects malformed percent escapes and raw path characters", () => {
    expect(() => normalizeServerUrl("https://x.test/%")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/%2")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/%GG")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a{b}")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a\\b")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a[b]")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/\u017c")).toThrow(/not a valid URL/)
  })

  it("accepts localhost and IPv6 literals", () => {
    expect(normalizeServerUrl("http://localhost:8090")).toBe("http://localhost:8090/")
    expect(normalizeServerUrl("http://[::1]:8090")).toBe("http://[::1]:8090/")
    expect(normalizeServerUrl("https://[2001:db8::1]/prefix")).toBe("https://[2001:db8::1]/prefix/")
  })

  it("rejects malformed or all-numeric hosts", () => {
    const badHosts = [
      "http://256.256.256.256",
      "http://256.0.0.1",
      "http://1.2.3.4.5",
      "http://4294967296",
      "http://99999999999",
      "http://01.2.3.4",
    ]
    for (const server of badHosts) {
      expect(() => normalizeServerUrl(server)).toThrow(/not a valid URL/)
    }
  })

  it("accepts canonical IPv4 and numeric-prefixed DNS names", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/")
    expect(normalizeServerUrl("http://123.example")).toBe("http://123.example/")
    expect(normalizeServerUrl("http://123-example")).toBe("http://123-example/")
  })
})

