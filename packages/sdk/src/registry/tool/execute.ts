import { RegistryCollisionError } from '../collision.js'

/**
 * Tool naming and a handful of small, stateless rendering helpers this file
 * used to share with `ToolRegistry`.
 *
 * `ToolRegistry` itself — registration, availability, the execution
 * pipeline — is gone (plan.md v3 §2): a runtime-owned `ToolManager`
 * (`toolsets/manager.ts`) resolves toolsets instead, and carries its own
 * copy of the pipeline this file used to define. What's left here is what
 * had no toolset/manager analogue to move to: a tool name has to be valid
 * regardless of which mechanism resolves it, and `describeWithOutput`/
 * `toolDiscoveryHint` are pure string formatting `ToolManager` still calls.
 */

/**
 * What a tool name may be, everywhere it comes from.
 *
 * A tool name reaches the provider verbatim, and the major message APIs
 * accept `[a-zA-Z0-9_-]` up to 64 characters. Nothing checked it: names
 * were derived by concatenation at three separate construction sites —
 * the remote-tool bridge, the plugin bridge, the CLI bridge — and any of
 * them could produce something the wire rejects.
 *
 * The rejection is a 400 on the WHOLE request rather than on that tool,
 * and the tools most likely to carry a bad name are registered deferred,
 * so it fired the moment one was activated with nothing naming the
 * culprit. Failing at registration instead names the tool, at the moment
 * something can still be done about it, and costs the turn nothing.
 *
 * One driver already ratified passing names through untouched, on the
 * grounds that a confusing name is "a naming problem to fix in the
 * registry, not something to paper over" — which is precisely why the
 * registry has to be the one that checks.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function assertToolName(name: string): void {
	if (TOOL_NAME_PATTERN.test(name)) return
	const reason =
		name.length > 64
			? `it is ${name.length} characters, over the 64-character limit`
			: 'it contains characters outside [a-zA-Z0-9_-]'
	throw new Error(
		`Tool name "${name}" cannot be sent to a provider: ${reason}. Providers reject the whole request for one bad name, so this is refused at registration where it can still be attributed.`,
	)
}

/**
 * Two sources contributed the same tool name and neither may take it.
 *
 * Named, and carrying the name, for the reason `DuplicateProviderError` is:
 * a host that wants to handle this — fall back to its own tool, log and
 * continue, surface it in a config error — has to be able to catch it
 * narrowly rather than match on message text. It also names both remedies,
 * because a hard collision policy without a way to decline would make
 * shadowing-by-name the only way to say "I do not want this tool", which is
 * precisely what now throws.
 */
export class ToolNameCollisionError extends RegistryCollisionError {
	readonly toolName: string

	constructor(toolName: string, context: string) {
		super(
			'ToolRegistry',
			toolName,
			`Tool name "${toolName}" is already registered by this host, and ${context} will not replace it. Rename the host tool, or decline the one being mounted with runtimeToolOverrides: { "${toolName}": "disabled" }.`,
		)
		this.name = 'ToolNameCollisionError'
		this.toolName = toolName
	}
}

/**
 * Append a tool's declared return shape to its description.
 *
 * No provider's tool wire format has a slot for an output schema, so the
 * description is the only channel that reaches the model. A remote server
 * that publishes one had it dropped at the type boundary and the model was
 * left inferring the return shape from prose — or from the first result it
 * happened to see, which is worse, because a tool that returns an empty
 * list once teaches the wrong lesson permanently.
 *
 * Rendered from JSON Schema verbatim rather than round-tripped through
 * anything: this is shown, never validated, so there is nothing to gain by
 * rebuilding it and fidelity to lose.
 */
export function describeWithOutput(
	description: string,
	outputSchema: Record<string, unknown> | undefined,
): string {
	if (outputSchema === undefined) return description
	return `${description}\n\nReturns (JSON Schema): ${JSON.stringify(outputSchema)}`
}

/**
 * One-line discoverability hint for a deferred tool: the first sentence of
 * its description, capped at ~100 chars. Used for the `<deferred_tools>`
 * prompt listing and for `search_tools` near-miss suggestions, where the
 * full description would re-import the token weight deferral avoids.
 */
export function toolDiscoveryHint(description: string, maxLength = 100): string {
	const normalized = description.trim().replace(/\s+/g, ' ')
	if (normalized.length === 0) return ''
	const sentenceMatch = normalized.match(/^.*?[.!?](?=\s|$)/)
	const sentence = sentenceMatch ? sentenceMatch[0] : normalized
	if (sentence.length <= maxLength) return sentence
	return `${sentence.slice(0, maxLength - 1).trimEnd()}…`
}
