import { describe, expect, it } from "vitest"

import { SessionRegistry } from "../src/session-registry.js"

describe("SessionRegistry", () => {
  it("starts empty and reports unknown sessions as undefined", () => {
    const registry = new SessionRegistry()
    expect(registry.size).toBe(0)
    expect(registry.parentOf("sess_unknown")).toBeUndefined()
  })

  it("records a child session with its parent", () => {
    const registry = new SessionRegistry()
    registry.record("sess_child", "sess_parent")
    expect(registry.parentOf("sess_child")).toBe("sess_parent")
    expect(registry.size).toBe(1)
  })

  it("records root sessions (no parent) as null", () => {
    const registry = new SessionRegistry()
    registry.record("sess_root", null)
    registry.record("sess_root_undefined", undefined)
    registry.record("sess_root_empty", "")
    expect(registry.parentOf("sess_root")).toBeNull()
    expect(registry.parentOf("sess_root_undefined")).toBeNull()
    expect(registry.parentOf("sess_root_empty")).toBeNull()
  })

  it("updates an existing entry when the session changes", () => {
    const registry = new SessionRegistry()
    registry.record("sess_a", "sess_parent")
    registry.record("sess_a", null)
    expect(registry.parentOf("sess_a")).toBeNull()
    registry.record("sess_a", "sess_new_parent")
    expect(registry.parentOf("sess_a")).toBe("sess_new_parent")
    expect(registry.size).toBe(1)
  })

  it("removes entries on delete", () => {
    const registry = new SessionRegistry()
    registry.record("sess_child", "sess_parent")
    registry.record("sess_root", null)
    registry.remove("sess_child")
    expect(registry.parentOf("sess_child")).toBeUndefined()
    expect(registry.size).toBe(1)
    registry.remove("sess_root")
    expect(registry.size).toBe(0)
  })

  it("ignores empty session ids and clears", () => {
    const registry = new SessionRegistry()
    registry.record("", "sess_parent")
    expect(registry.size).toBe(0)
    registry.record("sess_a", "sess_p")
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.parentOf("sess_a")).toBeUndefined()
  })
})

describe("lookup revision tracking", () => {
  it("keeps a lookup current until it ends, then releases tracking", () => {
    const registry = new SessionRegistry()
    const revision = registry.beginLookup("sess_x")
    expect(revision).toBe(0)
    expect(registry.lookupIsCurrent("sess_x", revision)).toBe(true)
    registry.endLookup("sess_x")
    expect(registry.lookupIsCurrent("sess_x", revision)).toBe(false)
  })

  it("supports concurrent lookups that remain valid until each ends", () => {
    const registry = new SessionRegistry()
    const first = registry.beginLookup("sess_x")
    const second = registry.beginLookup("sess_x")
    expect(registry.lookupIsCurrent("sess_x", first)).toBe(true)
    expect(registry.lookupIsCurrent("sess_x", second)).toBe(true)
    // Ending one of two concurrent lookups must not invalidate the other.
    registry.endLookup("sess_x")
    expect(registry.lookupIsCurrent("sess_x", first)).toBe(true)
    expect(registry.lookupIsCurrent("sess_x", second)).toBe(true)
    registry.endLookup("sess_x")
    expect(registry.lookupIsCurrent("sess_x", first)).toBe(false)
    expect(registry.lookupIsCurrent("sess_x", second)).toBe(false)
  })

  it("invalidates active lookups on record", () => {
    const registry = new SessionRegistry()
    const revision = registry.beginLookup("sess_child")
    registry.record("sess_child", "sess_parent")
    expect(registry.lookupIsCurrent("sess_child", revision)).toBe(false)
    // The next lookup observes the bumped generation.
    expect(registry.beginLookup("sess_child")).toBe(revision + 1)
    registry.endLookup("sess_child")
  })

  it("invalidates active lookups on remove", () => {
    const registry = new SessionRegistry()
    const revision = registry.beginLookup("sess_gone")
    registry.remove("sess_gone")
    expect(registry.lookupIsCurrent("sess_gone", revision)).toBe(false)
    expect(registry.parentOf("sess_gone")).toBeUndefined()
  })

  it("invalidates active lookups for every session on clear", () => {
    const registry = new SessionRegistry()
    const revisionA = registry.beginLookup("sess_a")
    const revisionB = registry.beginLookup("sess_b")
    registry.record("sess_a", "sess_parent")
    registry.clear()
    expect(registry.lookupIsCurrent("sess_a", revisionA)).toBe(false)
    expect(registry.lookupIsCurrent("sess_b", revisionB)).toBe(false)
  })

  it("tracks lookups per session only", () => {
    const registry = new SessionRegistry()
    const revision = registry.beginLookup("sess_a")
    registry.beginLookup("sess_b")
    expect(registry.lookupIsCurrent("sess_a", revision)).toBe(true)
    registry.endLookup("sess_b")
    expect(registry.lookupIsCurrent("sess_a", revision)).toBe(true)
    registry.endLookup("sess_a")
  })

  it("treats endLookup and lookupIsCurrent on unknown sessions as no-ops", () => {
    const registry = new SessionRegistry()
    expect(registry.lookupIsCurrent("sess_never", 0)).toBe(false)
    expect(() => registry.endLookup("sess_never")).not.toThrow()
    expect(() => registry.beginLookup("")).not.toThrow()
  })
})
