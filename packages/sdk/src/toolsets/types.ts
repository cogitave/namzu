import type { ToolDefinition } from '../types/tool/index.js'
import type { ToolSource, ToolSourceKind } from '../types/toolset/index.js'

// Re-exported so the rest of `toolsets/` can `import type { ToolSource }
// from './types.js'` and never reach past this module's own boundary.
// `public-types.ts` already exports these from `types/toolset/index.js`
// directly, and lists this module's OWN new names explicitly (not `export
// type *`), so this re-export does not create a duplicate public export.
export type { ToolSource, ToolSourceKind }

/**
 * A toolset's own default for the tools it contributes.
 *
 * Deliberately narrower than {@link ToolAvailability} (`'active' |
 * 'deferred' | 'suspended'`): `'suspended'` is runtime state a session
 * enters and leaves, not something a tool source declares about itself.
 * Absent means `'active'`.
 */
export type ToolsetAvailability = 'active' | 'deferred'

/**
 * The unit every tool comes from.
 *
 * A `Toolset` is a value, not a registration: `toolset()`, every wrapper
 * below, and `combineToolsets` all return one without touching any shared
 * state. Nothing "is registered" until a later item (`ToolRegistry` /
 * the `ToolManager` plan.md v3 describes) is handed one.
 */
export interface Toolset {
	/** Where these tools come from. Ownership and trust stay with this. */
	readonly source: ToolSource
	/**
	 * The current snapshot, in a deterministic order.
	 *
	 * Called fresh whenever a caller wants the current tools — a wrapper
	 * re-derives its mapping/filtering on every call rather than caching,
	 * so a live inner toolset's change is visible the moment `tools()` is
	 * called again, with no separate invalidation step.
	 */
	tools(): readonly ToolDefinition[]
	/**
	 * This toolset's default for tools it contributes. Absent means
	 * `'active'`. A wrapper composes this along with everything else: see
	 * {@link deferred}.
	 */
	readonly availability?: ToolsetAvailability
	/**
	 * Subscribe to "the next `tools()` call may return something different"
	 * — an MCP server's `list_changed`, for instance. Returns the
	 * unsubscribe function. Absent means this toolset never changes on its
	 * own (a plain {@link toolset} never does).
	 *
	 * A wrapper or {@link combineToolsets} that wraps a live toolset forwards
	 * this by calling the inner `onChange` with the same listener, so a
	 * change three layers down reaches a listener on the outermost toolset,
	 * and unsubscribing at the outer layer unsubscribes at every inner one.
	 */
	onChange?(listener: () => void): () => void
	/** Release whatever this toolset holds open (a connection, a watcher). */
	close?(): Promise<void>
}

/**
 * A lean per-tool pointer back to the source that contributed it.
 *
 * This is what plan.md §3 (a later item, not this one) stamps onto
 * `ToolDefinition.source`, replacing today's `ToolDefinition.provenance`.
 * Defined here, ahead of that wiring, because item A1 owns "one notion of a
 * source id" and the glob matching over it ({@link matchesSourceIdGlob}); no
 * wrapper in this module writes it onto a `ToolDefinition` yet — there is
 * nowhere on `ToolDefinition` for it to go until that later item lands.
 */
export interface ToolSourceRef {
	readonly id: string
	readonly kind: ToolSourceKind
	/** Only set when `kind` is `'mcp_server'`: the connected server's configured name. */
	readonly server?: string
	/**
	 * Only set when `kind` is `'mcp_server'`. See `ToolProvenance.readOnlyHintTrusted`
	 * (`types/tool/index.ts`) — same meaning, carried on the source instead of
	 * duplicated onto every tool the source contributes.
	 */
	readonly readOnlyHintTrusted?: boolean
}

/**
 * Project a `ToolSource` down to the lean shape a later item stamps onto
 * each tool. Pure; reads nothing but its arguments.
 *
 * `readOnlyHintTrusted` defaults to `source.mcpServer?.readOnlyHintTrusted`
 * — the operator's per-server trust decision, wired by whatever built this
 * `ToolSource` (`mcpToolset`, plan.md §4). The `mcp` parameter overrides that
 * default rather than being the only channel for it: a caller that already
 * has the decision in hand some other way (a test, a wrapper) may still pass
 * it explicitly, but `sourceOf` (`toolsets/manager.ts`) relies on the
 * default so a trusted server's tools resolve as trusted with no extra
 * wiring at the call site.
 */
export function toToolSourceRef(
	source: ToolSource,
	mcp?: { readonly readOnlyHintTrusted: boolean },
): ToolSourceRef {
	if (source.kind !== 'mcp_server') return { id: source.id, kind: source.kind }
	return {
		id: source.id,
		kind: source.kind,
		server: source.mcpServer?.name ?? source.name,
		readOnlyHintTrusted: mcp?.readOnlyHintTrusted ?? source.mcpServer?.readOnlyHintTrusted ?? false,
	}
}

/** A synchronous test over one tool, for {@link filtered} and {@link requireApproval}. */
export type ToolPredicate = (tool: ToolDefinition) => boolean

/**
 * What `filtered` (and `requireApproval`'s optional selector) may match on.
 *
 * `sourceIdGlob` matches the WHOLE toolset's own {@link ToolSource.id}
 * (glob syntax: {@link matchesSourceIdGlob}) — not a per-tool source, which
 * does not exist until a later item stamps {@link ToolSourceRef} onto each
 * `ToolDefinition`. A toolset is one source, so this keeps every tool the
 * toolset contributes when the glob matches, and none when it does not.
 *
 * `metadata` is a deep-match against `ToolDefinition.metadata`: every key in
 * the pattern must be present and equal (or, for a nested plain object,
 * recursively matched) on the tool's own metadata. A tool with no metadata
 * never matches a metadata selector.
 */
export type ToolFilterSelector =
	| readonly string[]
	| { readonly metadata: Readonly<Record<string, unknown>> }
	| { readonly sourceIdGlob: string }
