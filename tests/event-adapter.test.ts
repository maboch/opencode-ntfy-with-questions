import { describe, expect, it } from "vitest"

import {
  extractErrorMessage,
  formatErrorDraft,
  formatIdleDraft,
  formatPermissionDraft,
  formatQuestionDraft,
  parseRuntimeEvent,
} from "../src/event-adapter.js"

const envelope = (type: string, data: unknown) => ({ id: "evt_1", type, created: 1, data })

describe("parseRuntimeEvent native shapes", () => {
  it("parses a flat session.created root session", () => {
    expect(parseRuntimeEvent(envelope("session.created", { sessionID: "sess_root" }))).toEqual({
      kind: "lifecycle",
      action: "created",
      sessionID: "sess_root",
      parentID: null,
    })
  })

  it("parses a flat session.created child session with parentID", () => {
    expect(parseRuntimeEvent(envelope("session.created", { sessionID: "sess_child", parentID: "sess_parent" }))).toEqual(
      { kind: "lifecycle", action: "created", sessionID: "sess_child", parentID: "sess_parent" },
    )
  })

  it("ignores a created frame with an empty parentID (treated as root)", () => {
    const parsed = parseRuntimeEvent(envelope("session.created", { sessionID: "sess_root", parentID: "" }))
    expect(parsed).toEqual({ kind: "lifecycle", action: "created", sessionID: "sess_root", parentID: null })
  })

  it("parses session.deleted", () => {
    expect(parseRuntimeEvent(envelope("session.deleted", { sessionID: "sess_gone" }))).toEqual({
      kind: "lifecycle",
      action: "deleted",
      sessionID: "sess_gone",
      parentID: null,
    })
  })

  it("ignores legacy session.updated and session.error routes", () => {
    expect(parseRuntimeEvent(envelope("session.updated", { info: { id: "sess_1" } }))).toBeNull()
    expect(parseRuntimeEvent(envelope("session.error", { sessionID: "sess_1" }))).toBeNull()
  })

  it("maps session.status idle to an internal session.idle event", () => {
    expect(parseRuntimeEvent(envelope("session.status", { sessionID: "sess_1", status: { type: "idle" } }))).toEqual({
      kind: "session.idle",
      sessionID: "sess_1",
    })
  })

  it("ignores busy and retry statuses", () => {
    expect(parseRuntimeEvent(envelope("session.status", { sessionID: "sess_1", status: { type: "busy" } }))).toBeNull()
    expect(
      parseRuntimeEvent(envelope("session.status", { sessionID: "sess_1", status: { type: "retry", attempt: 1 } })),
    ).toBeNull()
    expect(parseRuntimeEvent(envelope("session.status", { sessionID: "sess_1" }))).toBeNull()
  })

  it("ignores the deprecated session.idle event to avoid a duplicate notification", () => {
    expect(parseRuntimeEvent(envelope("session.idle", { sessionID: "sess_1" }))).toBeNull()
  })

  it("maps session.execution.failed to an internal session.error with type and message", () => {
    const parsed = parseRuntimeEvent(
      envelope("session.execution.failed", {
        sessionID: "sess_1",
        error: { type: "ProviderError", message: "boom", status: 500, response: { body: "raw secret body" } },
      }),
    )
    expect(parsed).toEqual({ kind: "session.error", sessionID: "sess_1", errorMessage: "ProviderError: boom" })
  })

  it("never includes the native error response body or stack", () => {
    const parsed = parseRuntimeEvent(
      envelope("session.execution.failed", {
        sessionID: "sess_1",
        error: { type: "ProviderError", message: "boom", response: { body: "RAW_BODY" }, stack: "STACK_TRACE" },
      }),
    )
    const message = parsed && "errorMessage" in parsed ? parsed.errorMessage : ""
    expect(message).not.toContain("RAW_BODY")
    expect(message).not.toContain("STACK_TRACE")
  })

  it("parses a terminal failure without a sessionID", () => {
    expect(
      parseRuntimeEvent(envelope("session.execution.failed", { error: { type: "InternalError", message: "oops" } })),
    ).toEqual({ kind: "session.error", sessionID: undefined, errorMessage: "InternalError: oops" })
  })

  it("ignores transient session.step.failed and session.retry.scheduled frames", () => {
    expect(parseRuntimeEvent(envelope("session.step.failed", { sessionID: "sess_1", error: {} }))).toBeNull()
    expect(parseRuntimeEvent(envelope("session.retry.scheduled", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("session.execution.started", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("session.execution.succeeded", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("session.execution.interrupted", { sessionID: "sess_1" }))).toBeNull()
  })

  it("parses native permission.asked action/resources/id", () => {
    const parsed = parseRuntimeEvent(
      envelope("permission.asked", {
        id: "per_1",
        sessionID: "sess_1",
        action: "edit",
        resources: ["**/*.ts", 42, "src/**"],
        save: ["**/*.ts"],
      }),
    )
    expect(parsed).toEqual({
      kind: "permission.asked",
      sessionID: "sess_1",
      requestID: "per_1",
      permission: "edit",
      patterns: ["**/*.ts", "src/**"],
    })
  })

  it("falls back to permission unknown and empty patterns on malformed permission.asked", () => {
    expect(parseRuntimeEvent(envelope("permission.asked", { sessionID: "sess_1" }))).toEqual({
      kind: "permission.asked",
      sessionID: "sess_1",
      requestID: undefined,
      permission: "unknown",
      patterns: [],
    })
  })

  it("parses native permission.replied requestID and ignores the legacy permissionID field", () => {
    expect(parseRuntimeEvent(envelope("permission.replied", { sessionID: "sess_1", requestID: "per_1", reply: "once" }))).toEqual(
      { kind: "permission.replied", requestID: "per_1" },
    )
    expect(parseRuntimeEvent(envelope("permission.replied", { sessionID: "sess_1", permissionID: "per_1" }))).toBeNull()
  })

  it("ignores question and form event routes", () => {
    expect(parseRuntimeEvent(envelope("question.asked", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("question.v2.asked", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("form.created", { sessionID: "sess_1" }))).toBeNull()
    expect(parseRuntimeEvent(envelope("form.replied", { sessionID: "sess_1" }))).toBeNull()
  })

  it("returns null for malformed envelopes", () => {
    for (const bad of [null, undefined, 42, "text", {}, { type: 42 }, { type: "" }]) {
      expect(parseRuntimeEvent(bad)).toBeNull()
    }
  })
})

describe("extractErrorMessage", () => {
  it("uses the native type and message", () => {
    expect(extractErrorMessage({ type: "ProviderError", message: "boom" })).toBe("ProviderError: boom")
  })

  it("still supports the older name/data.message shape", () => {
    expect(extractErrorMessage({ name: "UnknownError", data: { message: "provider boom" } })).toBe(
      "UnknownError: provider boom",
    )
  })

  it("returns non-empty strings unchanged", () => {
    expect(extractErrorMessage("raw failure")).toBe("raw failure")
  })

  it("falls back safely for malformed errors", () => {
    expect(extractErrorMessage(undefined)).toBe("unknown error")
    expect(extractErrorMessage({})).toBe("error: no additional details")
    expect(extractErrorMessage({ type: "Boom" })).toBe("Boom: no additional details")
    expect(extractErrorMessage({ message: "only message" })).toBe("error: only message")
  })
})

describe("notification formatting", () => {
  it("formats idle and error drafts with tags", () => {
    expect(formatIdleDraft("sess_1", "proj")).toEqual({
      kind: "session.idle",
      title: "proj - session idle",
      message: "Session sess_1 has finished its run and is idle.\nIt is waiting for your next instruction.",
      tags: ["hourglass_done"],
    })
    expect(formatErrorDraft(undefined, "Boom: bad", "proj").message).toBe("A session reported an error:\nBoom: bad")
  })

  it("formats permission drafts with patterns", () => {
    const draft = formatPermissionDraft("edit", ["a", "b"], "sess_1", "proj")
    expect(draft.tags).toEqual(["lock"])
    expect(draft.message).toContain('Permission "edit" is requested.')
    expect(draft.message).toContain("Patterns: a, b")
  })

  const questionArgs = {
    questions: [
      {
        question: "Which option?",
        header: "Pick one",
        options: [
          { label: "Option A", description: "First" },
          { label: "Option B", description: "Second" },
        ],
      },
      { question: "Pick many?", header: "Multi", multiple: true, options: [{ label: "One", description: "" }] },
    ],
  }

  it("formats every question, option and the multiple flag", () => {
    const draft = formatQuestionDraft(questionArgs, "proj")
    expect(draft.tags).toEqual(["question"])
    const message = draft.message
    expect(message).toContain("[1] Pick one: Which option?")
    expect(message).toContain("[2] Multi: Pick many?")
    expect(message).toContain("- Option A (First)")
    expect(message).toContain("Multiple answers: allowed")
    expect(message).toContain("Multiple answers: not allowed")
  })

  it("produces one generic notification for malformed question args", () => {
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
      { questions: [{ question: "q", header: "h", options: [{ label: "only" }] }] },
      { questions: [{ question: "q", header: "h", multiple: "yes", options: [{ label: "l", description: "d" }] }] },
    ]
    for (const args of malformed) {
      expect(formatQuestionDraft(args, "proj").message).toContain("unreadable question payload")
    }
  })

  it("accepts empty strings and an empty options array", () => {
    const draft = formatQuestionDraft(
      { questions: [{ question: "", header: "H", options: [] }, { question: "Q?", header: "", options: [{ label: "", description: "" }] }] },
      "proj",
    )
    expect(draft.message).toContain("[1] H:")
    expect(draft.message).toContain("[2] Q?")
    expect(draft.message).toContain("(unnamed option)")
  })
})
