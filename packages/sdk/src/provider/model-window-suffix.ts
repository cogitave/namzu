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

const WRAPPED = Symbol.for('namzu.modelWindowSuffixStripped')

type AnyMethod = (...args: unknown[]) => unknown

function wrapMethod(name: string, method: AnyMethod): AnyMethod | undefined {
	if (name === 'chatStream' || name === 'chat') {
		return function (this: unknown, params: unknown, ...rest: unknown[]) {
			return method.call(this, stripParams(params), ...rest)
		}
	}
	if (MODEL_FIRST_METHODS.has(name)) {
		return function (this: unknown, model: unknown, ...rest: unknown[]) {
			return method.call(
				this,
				typeof model === 'string' ? stripModelWindowSuffix(model) : model,
				...rest,
			)
		}
	}
	return undefined
}

/**
 * The same provider, now stripping the marker from every model it is handed.
 * The instance is patched in place (not proxied) so a host that keys state on
 * the provider object keeps finding it; wrapping twice changes nothing.
 */
export function withModelWindowSuffixStripped<T extends LLMProvider>(provider: T): T {
	const target = provider as unknown as Record<PropertyKey, unknown>
	if (target[WRAPPED] === true) return provider
	if (!Object.isExtensible(provider)) {
		return new Proxy(provider, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object)
				if (typeof value !== 'function') return value
				const wrapped =
					typeof property === 'string' ? wrapMethod(property, value as AnyMethod) : undefined
				return (wrapped ?? (value as AnyMethod)).bind(object)
			},
		})
	}
	for (const name of ['chatStream', 'chat', ...MODEL_FIRST_METHODS]) {
		const method = target[name]
		if (typeof method !== 'function') continue
		const wrapped = wrapMethod(name, method as AnyMethod)
		if (wrapped) target[name] = wrapped
	}
	Object.defineProperty(provider, WRAPPED, { value: true, enumerable: false })
	return provider
}
