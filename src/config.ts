/**
 * Configuration loading, {env:VAR} / {file:path} substitution and validation.
 *
 * The config file is intentionally NOT backward compatible with the older
 * `notification-ntfy.json`: this plugin reads
 * `notification-ntfy-with-questions.json` from the opencode config directory.
 */

import { open } from "node:fs/promises"
import { isAbsolute, dirname, join } from "node:path"
import { homedir as defaultHomedir } from "node:os"

import {
  CONFIG_FILE_NAME,
  DEFAULT_NTFY_PRIORITY,
  DEFAULT_NTFY_SERVER,
  DEFAULT_TIMEOUT_MS,
  MAX_CONFIG_FILE_BYTES,
  MAX_REFERENCED_FILE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  notificationKinds,
  ntfyPriorities,
  TOPIC_PATTERN,
  type NotificationKind,
  type NtfyPriority,
  type PluginConfig,
} from "./types.js"

/**
 * Configuration errors are fatal at plugin initialization. Messages must never
 * include substituted config values, tokens or file contents - only key names,
 * variable names and paths.
 */
export class ConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ConfigError"
    this.code = code
  }
}

const TOP_LEVEL_KEYS = new Set(["$schema", "enabled", "events", "suppressSubagents", "ntfy"])
const NTFY_KEYS = new Set(["server", "topic", "token", "priority", "timeoutMs"])

/**
 * Substitution is full-value-only: a valid reference must occupy the entire
 * string value. `{env:...}`/`{file:...}` appearing inside longer text, nested
 * braces, or multiple references are rejected during substitution.
 */
const REFERENCE_PREFIX_PATTERN = /\{(?:env|file):/
const FULL_REFERENCE_PATTERN = /^\{(env|file):([^{}]+)\}$/

/** Canonical decimal port: 0 or 1..65535 without leading zeroes. */
const URL_PORT =
  "(?:0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])"
/** Canonical dotted-decimal IPv4; every octet is 0..255 without leading zeroes. */
const URL_IPV4_OCTET = "(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])"
const URL_IPV4 = `(?:${URL_IPV4_OCTET}\\.){3}${URL_IPV4_OCTET}`
/** Non-numeric ASCII DNS/service name; labels cannot start or end with '-'. */
const URL_REG_NAME_LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?"
const URL_REG_NAME = `(?=[A-Za-z0-9._-]*[A-Za-z_-])${URL_REG_NAME_LABEL}(?:\\.${URL_REG_NAME_LABEL})*`
/** One RFC-3986 path segment: unreserved / pct-encoded / sub-delims / ":" / "@". */
const URL_PATH_SEGMENT = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*"
/** Strict raw HTTP(S) authority shape checked before the URL parser runs. */
const SERVER_CREDENTIALS_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/]*@/
const SERVER_SHAPE_PATTERN = new RegExp(
  `^[Hh][Tt][Tt][Pp][Ss]?://(?:\\[[0-9A-Fa-f:.]+\\]|${URL_IPV4}|${URL_REG_NAME})(?::${URL_PORT})?(?:/${URL_PATH_SEGMENT})*$`,
)

export interface ParseContext {
  /** Directory of the config file; relative {file:...} references resolve against it. */
  dir: string
  env?: Record<string, string | undefined>
  home?: string
}

function invalid(detail: string): ConfigError {
  return new ConfigError("config.invalid", `configuration is invalid: ${detail}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Reads a UTF-8 file without ever buffering more than `maxBytes` bytes: the
 * stat size is checked first, then at most `maxBytes + 1` bytes are read so an
 * unexpected growth still triggers the limit instead of an unbounded buffer.
 */
async function readUtf8FileWithinLimit(
  filePath: string,
  maxBytes: number,
  tooLarge: () => ConfigError,
): Promise<string> {
  const handle = await open(filePath, "r")
  try {
    const stat = await handle.stat()
    if (stat.size > maxBytes) throw tooLarge()
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) throw tooLarge()
    return buffer.subarray(0, total).toString("utf8")
  } finally {
    await handle.close()
  }
}

/**
 * Absolute path of the plugin config file:
 * `$XDG_CONFIG_HOME/opencode/notification-ntfy-with-questions.json`, or
 * `~/.config/opencode/notification-ntfy-with-questions.json` when XDG_CONFIG_HOME
 * is not set.
 */
export function resolveConfigFilePath(
  env: Record<string, string | undefined> = process.env,
  home: string = defaultHomedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== "" ? xdg : join(home, ".config")
  return join(base, "opencode", CONFIG_FILE_NAME)
}

function describeFileReadError(filePath: string, cause: unknown): string {
  const code = cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "error"
  if (code === "ENOENT") {
    return (
      `config file not found at "${filePath}". ` +
      `Create it with at least {"ntfy": {"topic": "<your-topic>"}} and restart opencode.`
    )
  }
  return `config file at "${filePath}" could not be read (${code})`
}

/**
 * Reads, parses, expands and validates the config file. Any failure rejects
 * with a ConfigError so plugin initialization can fail with an actionable
 * message.
 */
export async function loadConfigFile(
  filePath: string = resolveConfigFilePath(),
  ctx: Omit<ParseContext, "dir"> = {},
): Promise<PluginConfig> {
  let text: string
  try {
    text = await readUtf8FileWithinLimit(filePath, MAX_CONFIG_FILE_BYTES, () =>
      new ConfigError("config.tooLarge", `configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit`),
    )
  } catch (cause) {
    // A limit violation is already a ConfigError and must not be rewrapped.
    if (cause instanceof ConfigError) throw cause
    throw new ConfigError("config.unreadable", describeFileReadError(filePath, cause))
  }
  return parseConfigText(text, { ...ctx, dir: dirname(filePath) })
}

/**
 * Parses raw config text: size limit, JSON parsing, token substitution, then
 * structural validation with defaults applied.
 */
export async function parseConfigText(text: string, ctx: ParseContext): Promise<PluginConfig> {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigError("config.tooLarge", `configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ConfigError("config.invalidJson", "configuration is not valid JSON")
  }
  const expanded = await substituteTokens(raw, {
    dir: ctx.dir,
    env: ctx.env ?? process.env,
    home: ctx.home ?? defaultHomedir(),
  })
  // Bound the aggregate result of substitution: many small references could
  // otherwise grow the effective configuration far beyond the raw file limit.
  const serialized = JSON.stringify(expanded)
  if (typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigError(
      "config.expandedTooLarge",
      `expanded configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit`,
    )
  }
  return normalizeConfig(expanded)
}

/**
 * Recursively expands `{env:NAME}` and `{file:path}` references. Recursion
 * walks nested object/array values; inside one string value a reference must
 * occupy the whole string (no interpolation). Substituted content is never
 * rescanned, so a secret file can safely contain brace-looking text.
 */
export async function substituteTokens(
  value: unknown,
  ctx: ParseContext & { home: string; env: Record<string, string | undefined> },
): Promise<unknown> {
  if (typeof value === "string") return expandString(value, ctx)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await substituteTokens(item, ctx))
    return out
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = await substituteTokens(item, ctx)
    return out
  }
  return value
}

function expandString(input: string, ctx: ParseContext & { home: string; env: Record<string, string | undefined> }): Promise<string> {
  // Ordinary strings with unrelated braces stay literals.
  if (!REFERENCE_PREFIX_PATTERN.test(input)) return Promise.resolve(input)
  const match = FULL_REFERENCE_PATTERN.exec(input)
  const reference = (match?.[2] ?? "").trim()
  if (!match || reference === "" || !/[^\s]/.test(reference)) {
    // Fixed, secret-safe explanation: the offending value is never echoed.
    throw new ConfigError(
      "config.substitution",
      "configuration contains an invalid {env:...}/{file:...} reference; a reference must occupy the entire string value",
    )
  }
  return match[1] === "env" ? Promise.resolve(resolveEnvReference(reference, ctx)) : resolveFileReference(reference, ctx)
}

function resolveEnvReference(name: string, ctx: ParseContext & { env: Record<string, string | undefined> }): string {
  if (name === "") {
    throw new ConfigError("config.substitution", "configuration contains an {env:...} reference with an empty variable name")
  }
  const value = ctx.env[name]
  // An empty value is treated as missing: an unset or blank variable almost
  // always means the secret was not configured, and silently substituting ""
  // would send unauthenticated requests.
  if (value === undefined || value === "") {
    throw new ConfigError("config.envUnset", `configuration references environment variable "${name}" but it is not set`)
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REFERENCED_FILE_BYTES) {
    throw new ConfigError(
      "config.envTooLarge",
      `value of environment variable "${name}" referenced by the configuration exceeds the ${MAX_REFERENCED_FILE_BYTES}-byte limit`,
    )
  }
  return value
}

async function resolveFileReference(spec: string, ctx: ParseContext & { home: string }): Promise<string> {
  if (spec === "") {
    throw new ConfigError("config.substitution", "configuration contains a {file:...} reference with an empty path")
  }
  const resolved = resolveReferencePath(spec, ctx)
  let text: string
  try {
    text = await readUtf8FileWithinLimit(
      resolved,
      MAX_REFERENCED_FILE_BYTES,
      () =>
        new ConfigError(
          "config.fileTooLarge",
          `file "${resolved}" referenced by the configuration exceeds the ${MAX_REFERENCED_FILE_BYTES}-byte limit`,
        ),
    )
  } catch (cause) {
    // A limit violation is already a ConfigError and must not be rewrapped.
    if (cause instanceof ConfigError) throw cause
    throw new ConfigError("config.fileUnreadable", `configuration references file "${resolved}" but it could not be read`)
  }
  return text.trim()
}

function resolveReferencePath(spec: string, ctx: ParseContext & { home: string }): string {
  if (spec === "~") return ctx.home
  if (spec.startsWith("~/")) return join(ctx.home, spec.slice(2))
  if (isAbsolute(spec)) return spec
  return join(ctx.dir, spec)
}

/**
 * Validates the expanded config structure and applies defaults. Unknown
 * properties are rejected at every level so the runtime validator stays in
 * sync with the bundled JSON Schema.
 */
export function normalizeConfig(raw: unknown): PluginConfig {
  if (!isPlainObject(raw)) throw invalid("the top level must be a JSON object")
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw invalid(`unknown top-level property "${key}" is not allowed`)
  }

  const enabled = readBoolean(raw, "enabled", true)

  const events = allTrueEvents()
  const rawEvents = raw["events"]
  if (rawEvents !== undefined) {
    if (!isPlainObject(rawEvents)) throw invalid('"events" must be an object')
    for (const key of Object.keys(rawEvents)) {
      if (!(notificationKinds as readonly string[]).includes(key)) {
        throw invalid(`"events.${key}" is not a supported event`)
      }
      if (typeof rawEvents[key] !== "boolean") throw invalid(`"events.${key}" must be a boolean`)
    }
    for (const key of notificationKinds) {
      if (typeof rawEvents[key] === "boolean") events[key] = rawEvents[key] as boolean
    }
  }

  const suppressSubagents = { "session.idle": true, "session.error": true }
  const rawSuppress = raw["suppressSubagents"]
  if (rawSuppress !== undefined) {
    if (!isPlainObject(rawSuppress)) throw invalid('"suppressSubagents" must be an object')
    for (const key of Object.keys(rawSuppress)) {
      if (key !== "session.idle" && key !== "session.error") {
        throw invalid(`"suppressSubagents.${key}" is not a supported property`)
      }
      if (typeof rawSuppress[key] !== "boolean") throw invalid(`"suppressSubagents.${key}" must be a boolean`)
    }
    if (typeof rawSuppress["session.idle"] === "boolean") {
      suppressSubagents["session.idle"] = rawSuppress["session.idle"] as boolean
    }
    if (typeof rawSuppress["session.error"] === "boolean") {
      suppressSubagents["session.error"] = rawSuppress["session.error"] as boolean
    }
  }

  const rawNtfy = raw["ntfy"]
  if (rawNtfy === undefined) throw invalid('required property "ntfy" is missing')
  if (!isPlainObject(rawNtfy)) throw invalid('"ntfy" must be an object')
  for (const key of Object.keys(rawNtfy)) {
    if (!NTFY_KEYS.has(key)) throw invalid(`"ntfy.${key}" is not allowed`)
  }

  const topic = rawNtfy["topic"]
  if (typeof topic !== "string") throw invalid('required property "ntfy.topic" is missing or not a string')
  if (!TOPIC_PATTERN.test(topic)) {
    throw invalid('"ntfy.topic" must be 1-64 characters from A-Z a-z 0-9 - _')
  }

  const serverValue = rawNtfy["server"]
  const server = serverValue === undefined ? normalizeServerUrl(DEFAULT_NTFY_SERVER) : normalizeServerUrl(serverValue as string)

  let token: string | undefined
  const tokenValue = rawNtfy["token"]
  if (tokenValue !== undefined) {
    if (typeof tokenValue !== "string" || tokenValue.length === 0) {
      throw invalid('"ntfy.token" must be a non-empty string when provided')
    }
    token = tokenValue
  }

  let priority: NtfyPriority = DEFAULT_NTFY_PRIORITY
  const priorityValue = rawNtfy["priority"]
  if (priorityValue !== undefined) {
    if (typeof priorityValue !== "string" || !(ntfyPriorities as readonly string[]).includes(priorityValue)) {
      throw invalid('"ntfy.priority" must be one of min, low, default, high, max')
    }
    priority = priorityValue as NtfyPriority
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS
  const timeoutValue = rawNtfy["timeoutMs"]
  if (timeoutValue !== undefined) {
    if (typeof timeoutValue !== "number" || !Number.isInteger(timeoutValue)) {
      throw invalid('"ntfy.timeoutMs" must be an integer')
    }
    if (timeoutValue < MIN_TIMEOUT_MS || timeoutValue > MAX_TIMEOUT_MS) {
      throw invalid(`"ntfy.timeoutMs" must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
    }
    timeoutMs = timeoutValue
  }

  return { enabled, events, suppressSubagents, ntfy: { server, topic, token, priority, timeoutMs } }
}

function allTrueEvents(): Record<NotificationKind, boolean> {
  return {
    "session.idle": true,
    "session.error": true,
    "permission.asked": true,
    "question.asked": true,
  }
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw invalid(`"${key}" must be a boolean`)
  return value
}

/**
 * Validates a raw server URL and normalizes it to `scheme://host[:port][/prefix]/`
 * with exactly one trailing slash.
 *
 * Before `new URL` runs, the raw string must match one strict HTTP(S) shape:
 * exactly `://`, an ASCII DNS/service/IPv4 host or bracketed IPv6, an optional
 * canonical decimal port (0 or 1..65535, no leading zeroes), and an optional
 * path prefix that may contain percent-encoded characters. Credentials, raw
 * whitespace and any raw `?`/`#` (even empty delimiters) are rejected. `new URL`
 * stays the final semantic validator.
 */
export function normalizeServerUrl(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw invalid('"ntfy.server" must be a non-empty string')
  }
  // The WHATWG URL parser tolerates several inputs that must stay invalid for
  // parity with the bundled JSON Schema (whitespace, empty query/fragment
  // delimiters, triple-slash authorities, zero-padded ports, exotic hosts).
  // Inspect the raw string before parsing so those are rejected up front.
  if (/\s/.test(input)) {
    throw invalid('"ntfy.server" must not contain whitespace')
  }
  if (input.includes("?")) throw invalid('"ntfy.server" must not contain a query string')
  if (input.includes("#")) throw invalid('"ntfy.server" must not contain a fragment')
  if (!/^[Hh][Tt][Tt][Pp][Ss]?:\/\//.test(input)) {
    throw invalid('"ntfy.server" must start with http:// or https://')
  }
  if (SERVER_CREDENTIALS_PATTERN.test(input)) {
    throw invalid('"ntfy.server" must not contain credentials')
  }
  if (!SERVER_SHAPE_PATTERN.test(input)) {
    throw invalid('"ntfy.server" is not a valid URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw invalid('"ntfy.server" is not a valid URL')
  }
  if (!url.hostname) throw invalid('"ntfy.server" must include a host')
  const pathname = url.pathname.replace(/\/+$/, "")
  return `${url.protocol}//${url.host}${pathname}/`
}
