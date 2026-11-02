/**
 * Keeps the `[1m]` window marker off the wire.
 *
 * A model id ending in `[1m]` declares a one-million-token window to Namzu
 * (see `splitModelWindowSuffix`). The marker belongs to the person and the UI,
 * not to the vendor, so every driver and every request sees the bare id. This
 * wraps a provider once, where it is built, so no caller that holds the marked
 * id (a main model, a sub-agent, a side-job model, a fallback chain member)
 * has to remember to strip it.
 */

import { stripModelWindowSuffix } from '../compaction/context-window.js'
import type { LLMProvider } from '../types/provider/interface.js'

/** Provider methods whose first argument is a model id. */
const MODEL_FIRST_METHODS: ReadonlySet<string> = new Set([
	'supportsHostedWebSearchFor',
	'supportsImageInputFor',
	'reasoningEffortLevelsFor',
	'reasoningEffortDefaultFor',
	'effortLevelsFor',
	'resolveContextWindow',
	'healthCheck',
	'doctorCheck',
])

function stripParams(params: unknown): unknown {
	if (typeof params !== 'object' || params === null) return params
	const model = (params as { model?: unknown }).model
	if (typeof model !== 'string') return params
	const bare = stripModelWindowSuffix(model)
	return bare === model ? params : { ...params, model: bare }
}

export function withModelWindowSuffixStripped<T extends LLMProvider>(provider: T): T {
	return new Proxy(provider, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target)
			if (typeof value !== 'function') return value
			const method = value as (...args: unknown[]) => unknown
			if (property === 'chatStream' || property === 'chat') {
				return (params: unknown, ...rest: unknown[]) =>
					method.call(target, stripParams(params), ...rest)
			}
			if (typeof property === 'string' && MODEL_FIRST_METHODS.has(property)) {
				return (model: unknown, ...rest: unknown[]) =>
					method.call(
						target,
						typeof model === 'string' ? stripModelWindowSuffix(model) : model,
						...rest,
					)
			}
			return method.bind(target)
		},
	})
}
