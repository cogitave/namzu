/**
 * Per-turn context the SDK is allowed to hand a working-memory provider.
 *
 * NEUTRAL by construction: opaque strings + a number, NO host/Postgres/disk
 * types. It mirrors `AgentRuntimeContext.notes: readonly string[]` and the
 * `web-search` seam discipline — the host closes over everything else
 * (threadId, output dir, tenancy) when it builds the provider, so the SDK
 * never learns a domain type. The SDK only POSITIONS the returned string at
 * the primacy edge; the host OWNS the content and its authority framing.
 */
export interface WorkingMemoryTurnContext {
	/** The active run id (opaque). */
	readonly runId: string
	/** 1-based iteration counter for this run. */
	readonly iteration: number
}

/**
 * Returns a rendered, already-sanitized working-memory block to pin at the
 * primacy edge (a single leading system message, refreshed every iteration).
 *
 * The SDK does no parsing of the returned string — it stores it verbatim under
 * a sentinel header and re-pins it each turn. An empty/blank return ⇒ no block
 * is injected (the byte-identical-when-empty property). Async so the host can
 * `stat` the output dir / read the registry each turn. Failure-isolated by the
 * SDK: a throwing/slow provider degrades to "no refresh this turn", never
 * breaks the run.
 */
export type WorkingMemoryProvider = (ctx: WorkingMemoryTurnContext) => string | Promise<string>
