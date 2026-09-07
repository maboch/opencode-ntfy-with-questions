/**
 * In-memory sessionID -> parentID cache plus in-flight fallback-lookup
 * tracking.
 *
 * opencode emits `session.created`/`session.updated`/`session.deleted` events,
 * which lets the plugin classify sessions as root or subagent without an HTTP
 * round trip for every idle/error event. The value is `string | null`: a
 * non-empty string is the parent (subagent) session, `null` means the session
 * is a known root, and an entry can be absent (unknown).
 *
 * Lookup tracking exists only while a fallback `session.get` is in flight. Each
 * `record`/`remove`/`clear` bumps the generation of the affected session(s), so
 * a lookup that started before a lifecycle event (for example
 * `session.deleted`) can detect that its response is stale and must not be
 * cached. Tracking state is released once the final concurrent lookup ends, so
 * no per-deleted-session tombstones accumulate.
 */

/** Normalized parent lookup: undefined means "not cached / unknown". */
export type ParentResult = string | null | undefined

interface LookupState {
  /** Bumped by record/remove/clear; beginLookup snapshots it as the revision. */
  generation: number
  /** Number of concurrent in-flight lookups for this session. */
  active: number
}

export class SessionRegistry {
  private readonly parents = new Map<string, string | null>()
  private readonly lookups = new Map<string, LookupState>()

  /**
   * Records or refreshes the parent of a session from a create/update event.
   * A missing or empty parentID means the session has no parent (root).
   * Invalidates any in-flight lookup for the session.
   */
  record(sessionID: string, parentID: string | null | undefined): void {
    if (sessionID === "") return
    this.invalidateLookup(sessionID)
    this.parents.set(sessionID, parentID && parentID !== "" ? parentID : null)
  }

  /** Removes a session (session.deleted) and invalidates its in-flight lookups. */
  remove(sessionID: string): void {
    this.invalidateLookup(sessionID)
    this.parents.delete(sessionID)
  }

  /**
   * Returns the cached parent of a session:
   * - a non-empty sessionID string when the session is a subagent,
   * - `null` when the session is a known root,
   * - `undefined` when the session is not in the cache.
   */
  parentOf(sessionID: string): ParentResult {
    return this.parents.get(sessionID)
  }

  /** Number of cached sessions. */
  get size(): number {
    return this.parents.size
  }

  /** Clears every cached parent and invalidates all in-flight lookups. */
  clear(): void {
    this.parents.clear()
    for (const sessionID of this.lookups.keys()) this.invalidateLookup(sessionID)
  }

  /**
   * Starts tracking an in-flight fallback lookup for a session and returns the
   * current revision. Concurrent lookups for the same session are supported:
   * each stays current until a lifecycle event invalidates it or it ends.
   */
  beginLookup(sessionID: string): number {
    if (sessionID === "") return 0
    let state = this.lookups.get(sessionID)
    if (!state) {
      state = { generation: 0, active: 0 }
      this.lookups.set(sessionID, state)
    }
    state.active += 1
    return state.generation
  }

  /**
   * True while the lookup started at `revision` is still the authoritative one:
   * no lifecycle event has invalidated this session's lookups since then.
   */
  lookupIsCurrent(sessionID: string, revision: number): boolean {
    const state = this.lookups.get(sessionID)
    return state !== undefined && state.generation === revision
  }

  /**
   * Releases tracking for one ended lookup. State is removed once the final
   * concurrent lookup for the session ends.
   */
  endLookup(sessionID: string): void {
    const state = this.lookups.get(sessionID)
    if (!state) return
    state.active -= 1
    if (state.active <= 0) this.lookups.delete(sessionID)
  }

  private invalidateLookup(sessionID: string): void {
    const state = this.lookups.get(sessionID)
    if (state) state.generation += 1
  }
}
