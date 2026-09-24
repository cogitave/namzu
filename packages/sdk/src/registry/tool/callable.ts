import type { ToolRegistryContract } from '../../types/tool/index.js'

/**
 * The tools a call on this step can reach: registered now, active, and on
 * the step's allow-list when it has one. In registry order.
 *
 * This is what every "Available: …" a model is shown must say, because a
 * model takes it literally and calls the next name on it. Two answers used
 * to build that list separately and disagreed. A refusal echoed the step's
 * allow-list, which is a snapshot taken when the request was built and so
 * can name a tool unregistered since — a connector that disconnected — or
 * one that is deferred or suspended, which the executor refuses. An
 * unknown-tool error listed the whole registry, which on a narrowed step is
 * mostly tools the step refuses. Each sent the model to a name the other
 * one answered, and a run went round between them until it was stopped.
 *
 * `allowed` absent means the step is not narrowed. An EMPTY list is a step
 * that may call nothing, and the answer is then empty too.
 */
export function callableToolNames(
	tools: Pick<ToolRegistryContract, 'listNames' | 'getAvailability'>,
	allowed: readonly string[] | undefined,
): string[] {
	const permitted = allowed === undefined ? undefined : new Set(allowed)
	return tools
		.listNames()
		.filter(
			(name) =>
				(permitted === undefined || permitted.has(name)) &&
				tools.getAvailability(name) === 'active',
		)
}

/** The list as a model reads it: comma-separated, or `(none)`. */
export function formatToolNames(names: readonly string[]): string {
	return names.length > 0 ? names.join(', ') : '(none)'
}
