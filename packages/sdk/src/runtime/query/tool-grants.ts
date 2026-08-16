import type { ToolCallSummary } from '../../types/hitl/index.js'

/**
 * The keys under which a tool call can be granted.
 *
 * Ordered widest-last, so a grant list read by a human says what it covers.
 * A call is pre-approved if ANY of its keys has been granted, which is what
 * lets one mechanism express both "this exact invocation" and "this tool,
 * whatever the arguments".
 */
export interface ToolGrantKeys {
	/** This exact invocation: the tool and these arguments. */
	readonly call: string
	/** The tool, whatever the arguments. */
	readonly tool: string
}

/**
 * Derive both grant keys for a call.
 *
 * The arguments are serialized with sorted keys, so two calls that differ
 * only in property order produce the same key. Without that, a grant for
 * `{path, mode}` would not cover `{mode, path}` and the same approval would
 * be asked for twice — which reads to the approver as the mechanism not
 * working, and teaches them to grant the wide key instead.
 */
export function toolGrantKeys(call: Pick<ToolCallSummary, 'name' | 'input'>): ToolGrantKeys {
	return {
		call: `${call.name}:${stableStringify(call.input)}`,
		tool: call.name,
	}
}

/**
 * Grants recorded during one run.
 *
 * Run-scoped, not persisted: an approval is a statement about this run's
 * work, and carrying it into a later run would be reuse nobody agreed to.
 * The durable half is the checkpointed decision, which is evidence of what
 * was approved, not a standing permission.
 */
export class ToolGrantSet {
	private readonly granted = new Set<string>()

	/** Record keys from an explicit approval. Ignores empty input. */
	grant(keys: readonly string[] | undefined): void {
		for (const key of keys ?? []) {
			if (key.length > 0) this.granted.add(key)
		}
	}

	/** Whether this call is already covered by a recorded grant. */
	covers(call: Pick<ToolCallSummary, 'name' | 'input'>): boolean {
		const keys = toolGrantKeys(call)
		return this.granted.has(keys.call) || this.granted.has(keys.tool)
	}

	get size(): number {
		return this.granted.size
	}

	/** The recorded keys, for a host rendering what it has already granted. */
	list(): string[] {
		return [...this.granted]
	}
}

/**
 * `JSON.stringify` with object keys sorted at every depth.
 *
 * Arrays keep their order, which is meaningful; object key order is not,
 * and letting it into the key would make the same call hash two ways.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
	return `{${entries.join(',')}}`
}
