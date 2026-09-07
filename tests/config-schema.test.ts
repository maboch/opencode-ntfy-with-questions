import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { FormatsPlugin } from "ajv-formats"
import formatsModule from "ajv-formats"
import { afterEach, describe, expect, it } from "vitest"

import { ConfigError, loadConfigFile, normalizeConfig, normalizeServerUrl, parseConfigText } from "../src/config.js"
import {
  DEFAULT_NTFY_PRIORITY,
  DEFAULT_NTFY_SERVER,
  DEFAULT_TIMEOUT_MS,
  notificationKinds,
  type NtfyPriority,
} from "../src/types.js"

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-schema-"))
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

describe("schema parity", () => {
  const schemaPath = resolve(process.cwd(), "notification-ntfy-with-questions.schema.json")
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: {
      enabled: { default: boolean }
      events: { properties: Record<string, { default: boolean }> }
      suppressSubagents: { properties: Record<string, { default: boolean }> }
      ntfy: {
        properties: {
          server: { default: string }
          priority: { default: NtfyPriority }
          timeoutMs: { default: number }
        }
      }
    }
  }
  // format: "uri" on the literal server branch is validated via ajv-formats.
  const addFormats =
    (formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin)
  const ajv = new Ajv2020({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile(schema)

  const validSamples = [
    { ntfy: { topic: "topic-a" } },
    { enabled: false, ntfy: { topic: "topic-b" } },
    {
      events: { "session.idle": true, "session.error": false },
      suppressSubagents: { "session.idle": false },
      ntfy: {
        server: "https://self.ntfy.example/x",
        topic: "topic-c",
        token: "{env:NTFY_TOKEN}",
        priority: "max",
        timeoutMs: 1,
      },
    },
    { $schema: "https://example.invalid/s.json", ntfy: { topic: "t" } },
    { ntfy: { topic: "t", server: "https://ntfy.sh" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/notify/" } },
    { ntfy: { topic: "t", server: "http://localhost:8090/prefix" } },
    { ntfy: { topic: "t", server: "http://127.0.0.1:8090" } },
    { ntfy: { topic: "t", server: "http://[::1]:8090" } },
    { ntfy: { topic: "t", server: "https://[2001:db8::1]/prefix" } },
    { ntfy: { topic: "t", server: "https://x.test:65535/path" } },
    { ntfy: { topic: "t", server: "https://x.test/a%20b" } },
    { ntfy: { topic: "t", server: "http://foo_bar.test" } },
    { ntfy: { topic: "t", server: "https://x.test/a/b" } },
    { ntfy: { topic: "t", server: "https://x.test/%20/%23/%3F" } },
    { ntfy: { topic: "t", server: "https://x.test/%C3%A9/na%C3%AFve" } },
    { ntfy: { topic: "t", server: "http://123.example" } },
    { ntfy: { topic: "t", server: "http://123-example" } },
  ]

  const invalidSamples = [
    { ntfy: { topic: "with space" } },
    { ntfy: { topic: "t", timeoutMs: 0 } },
    { ntfy: { topic: "t", timeoutMs: 60001 } },
    { ntfy: { topic: "t", timeoutMs: 1.5 } },
    { ntfy: { topic: "t", priority: "nope" } },
    { ntfy: { topic: "t", token: "" } },
    { ntfy: { topic: "t", extra: 1 } },
    { ntfy: { topic: "t" }, extraTop: true },
    { events: { bogus: true }, ntfy: { topic: "t" } },
    { suppressSubagents: { bogus: true }, ntfy: { topic: "t" } },
    { enabled: "yes", ntfy: { topic: "t" } },
    {},
    { ntfy: {} },
    // Invalid server literals: the schema must reject what the runtime rejects.
    { ntfy: { topic: "t", server: "ftp://ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https://user:pass@ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/?a=b" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/#frag" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com /x" } },
    { ntfy: { topic: "t", server: "ntfy.example.com" } },
    { ntfy: { topic: "t", server: "" } },
    { ntfy: { topic: "t", server: 42 } },
    // Raw syntax the URL parser alone would accept or mishandle.
    { ntfy: { topic: "t", server: "http:///ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https:///x.test" } },
    { ntfy: { topic: "t", server: "https://x.test:00080" } },
    { ntfy: { topic: "t", server: "https://x.test:080" } },
    { ntfy: { topic: "t", server: "http://foo%20bar.test" } },
    { ntfy: { topic: "t", server: "http://foo%23bar.test" } },
    // Empty delimiters and malformed hosts/ports.
    { ntfy: { topic: "t", server: "https://x.test/?" } },
    { ntfy: { topic: "t", server: "https://x.test/#" } },
    { ntfy: { topic: "t", server: "https://%/" } },
    { ntfy: { topic: "t", server: "https://x.test:abc" } },
    { ntfy: { topic: "t", server: "https://x.test:65536" } },
    // Malformed percent escapes and raw path characters.
    { ntfy: { topic: "t", server: "https://x.test/%" } },
    { ntfy: { topic: "t", server: "https://x.test/%2" } },
    { ntfy: { topic: "t", server: "https://x.test/%GG" } },
    { ntfy: { topic: "t", server: "https://x.test/a{b}" } },
    { ntfy: { topic: "t", server: "https://x.test/a\\b" } },
    { ntfy: { topic: "t", server: "https://x.test/a[b]" } },
    { ntfy: { topic: "t", server: "https://x.test/\u017c" } },
    // Malformed or all-numeric hosts.
    { ntfy: { topic: "t", server: "http://256.256.256.256" } },
    { ntfy: { topic: "t", server: "http://256.0.0.1" } },
    { ntfy: { topic: "t", server: "http://1.2.3.4.5" } },
    { ntfy: { topic: "t", server: "http://4294967296" } },
    { ntfy: { topic: "t", server: "http://99999999999" } },
    { ntfy: { topic: "t", server: "http://01.2.3.4" } },
    // Whitespace-only placeholders.
    { ntfy: { topic: "{env:   }" } },
    { ntfy: { topic: "{file:   }" } },
    { ntfy: { topic: "t", server: "{env:   }" } },
    { ntfy: { topic: "t", server: "{file:   }" } },
  ]

  for (const sample of validSamples) {
    it(`accepts valid sample and schema agrees: ${JSON.stringify(sample)}`, () => {
      expect(validate(structuredClone(sample))).toBe(true)
      const config = normalizeConfig(structuredClone(sample))
      expect(config).toBeDefined()
    })
  }

  for (const sample of invalidSamples) {
    it(`rejects invalid sample and schema agrees: ${JSON.stringify(sample)}`, () => {
      expect(validate(structuredClone(sample))).toBe(false)
      expect(() => normalizeConfig(structuredClone(sample))).toThrow(ConfigError)
    })
  }

  it("schema accepts exact env/file references for server, topic and token", () => {
    expect(validate({ ntfy: { topic: "{env:NTFY_TOPIC}", server: "{env:NTFY_SERVER}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "{file:topic.txt}", server: "{file:server.txt}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "t", token: "{env:NTFY_TOKEN}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "t", token: "plain-token{a}b" } })).toBe(true)
  })

  it("schema rejects partial or malformed reference strings", () => {
    const partialSamples = [
      { ntfy: { topic: "pre{env:A}" } },
      { ntfy: { topic: "{env:A}post" } },
      { ntfy: { topic: "{env:A}{env:B}" } },
      { ntfy: { topic: "{env:}" } },
      { ntfy: { topic: "t", server: "https://x.test/{env:P}" } },
      { ntfy: { topic: "t", server: "x{env:A}" } },
      { ntfy: { topic: "t", token: "abc{env:X}" } },
      { ntfy: { topic: "t", token: "{env:X}abc" } },
      { ntfy: { topic: "t", token: "{file:a}b" } },
      { ntfy: { topic: "t", token: "{env:   }" } },
    ]
    for (const sample of partialSamples) {
      expect(validate(structuredClone(sample))).toBe(false)
    }
  })

  it("runtime rejects partial or malformed references with a fixed substitution error", async () => {
    const partialValues: Array<[string, unknown]> = [
      ["topic", "pre{env:A}"],
      ["topic", "{env:A}post"],
      ["topic", "{env:A}{env:B}"],
      ["topic", "{env:}"],
      ["server", "x{env:A}"],
      ["server", "https://x.test/{env:P}"],
      ["token", "abc{env:X}"],
      ["token", "{env:}x"],
      ["token", "{env:   }"],
    ]
    for (const [field, value] of partialValues) {
      const raw = { ntfy: { topic: "t", [field]: value } }
      const error = await rejectionOf(
        parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { A: "v", X: "w", P: "p" } }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).toContain("entire string value")
    }
  })

  it("runtime accepts exact references after substitution with concrete values", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(
      JSON.stringify({ ntfy: { topic: "{env:NTFY_TOPIC}", server: "{file:server-url.txt}" } }),
      dir,
    )
    await writeFile(join(dir, "opencode", "server-url.txt"), "https://ntfy.example.com/base", "utf8")
    const config = await loadConfigFile(filePath, { env: { NTFY_TOPIC: "env-topic" } })
    expect(config.ntfy.topic).toBe("env-topic")
    expect(config.ntfy.server).toBe("https://ntfy.example.com/base/")
  })

  it("runtime rejects whitespace-only references with a fixed substitution error", async () => {
    const envError = await rejectionOf(
      parseConfigText(JSON.stringify({ ntfy: { topic: "{env:   }" } }), { dir: "/tmp", env: {} }),
    )
    expect((envError as ConfigError).code).toBe("config.substitution")
    expect(envError.message).not.toContain("{env:   }")
    const fileError = await rejectionOf(
      parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:  }" } }), { dir: "/tmp" }),
    )
    expect((fileError as ConfigError).code).toBe("config.substitution")
    expect(fileError.message).not.toContain("{file:  }")
  })

  it("agrees on defaults with the JSON Schema default keywords", () => {
    const config = normalizeConfig({ ntfy: { topic: "t" } })
    expect(config.enabled).toBe(schema.properties.enabled.default)
    expect(config.ntfy.server).toBe(normalizeServerUrl(schema.properties.ntfy.properties.server.default))
    expect(config.ntfy.priority).toBe(schema.properties.ntfy.properties.priority.default)
    expect(config.ntfy.timeoutMs).toBe(schema.properties.ntfy.properties.timeoutMs.default)
    for (const kind of notificationKinds) {
      expect(config.events[kind]).toBe(schema.properties.events.properties[kind]!.default)
    }
    for (const key of ["session.idle", "session.error"] as const) {
      expect(config.suppressSubagents[key]).toBe(schema.properties.suppressSubagents.properties[key]!.default)
    }
    expect(DEFAULT_NTFY_SERVER).toBe(schema.properties.ntfy.properties.server.default)
    expect(DEFAULT_NTFY_PRIORITY).toBe(schema.properties.ntfy.properties.priority.default)
    expect(DEFAULT_TIMEOUT_MS).toBe(schema.properties.ntfy.properties.timeoutMs.default)
  })
})
