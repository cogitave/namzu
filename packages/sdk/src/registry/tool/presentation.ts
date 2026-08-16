import type { ToolRegistryContract, ToolResult } from '../../types/tool/index.js'
import type { ToolCallView, ToolResultView } from '../../types/tool/presentation.js'
import { toErrorMessage } from '../../utils/error.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import type { Logger } from '../../utils/logger.js'
import { resolveLogger } from '../../utils/logger.js'

/**
 * Asks a tool how it should be shown, and falls back when it has no
 * opinion.
 *
 * The fallback is not a placeholder — it is the exact behaviour one host
 * had already converged on, moved to where every host can reach it. What
 * changes is that a tool the host never heard of can now override it.
 */
export interface ToolPresenter {
	presentCall(toolName: string, input: unknown): ToolCallView
	presentResult(toolName: string, input: unknown, result: ToolResult): ToolResultView
}

const MAX_LABEL = 120

function truncate(value: string, max = MAX_LABEL): string {
	const oneLine = value.replace(/\s+/g, ' ')
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * The label a tool with no opinion gets.
 *
 * The pick order is load-bearing and was arrived at by use. `description`
 * is LAST so it only speaks for a tool none of the others describe — those
 * tools were falling through to a truncated `JSON.stringify`, which is how
 * a delegation tool came to show a blob of its own arguments while
 * requiring the model to write a label nothing then read.
 */
export function genericLabel(input: unknown): string {
	if (input && typeof input === 'object') {
		const obj = input as Record<string, unknown>
		const pick = (k: string): string | undefined =>
			typeof obj[k] === 'string' ? (obj[k] as string) : undefined
		const primary =
			pick('command') ??
			pick('path') ??
			pick('file_path') ??
			pick('pattern') ??
			pick('query') ??
			pick('description')
		if (primary) return truncate(primary)
	}
	if (typeof input === 'string') return truncate(input)
	return truncate(JSON.stringify(input ?? {}))
}

/**
 * `registry` is the `ToolRegistryContract` a run already holds, so a
 * presenter never needs its own copy of what is registered — and a tool
 * added at runtime by a plugin is presentable the moment it is registered.
 */
export function createToolPresenter(
	registry: ToolRegistryContract,
	logger?: Logger,
): ToolPresenter {
	// `SCOPE_ATTRIBUTE`, not a bare `component` key. The 40 bare ones are a
	// frozen inventory the log gate counts; a new binding has no reason to
	// join it, and the ratchet caught this one before it did.
	const log = resolveLogger(logger).child({ [SCOPE_ATTRIBUTE]: 'registry/tool/presentation' })

	/**
	 * A tool's presenter is host-supplied code running inside a render
	 * path. A throw here must not take down the surface that was only
	 * trying to draw a line, so it is caught and reported once — the same
	 * trade a log sink already makes.
	 */
	const guard = <T>(toolName: string, hook: string, fn: () => T | undefined): T | undefined => {
		try {
			return fn()
		} catch (err) {
			log.warn('a tool presenter threw — falling back to the generic view', {
				'namzu.tool.name': toolName,
				'namzu.tool.presenter_hook': hook,
				'namzu.error.message': toErrorMessage(err),
			})
			return undefined
		}
	}

	return {
		presentCall(toolName, input) {
			const definition = registry.get(toolName)
			const view = definition?.presentCall
				? guard(toolName, 'presentCall', () => definition.presentCall?.(input))
				: undefined
			return view ?? { kind: 'generic', label: genericLabel(input) }
		},

		presentResult(toolName, input, result) {
			const definition = registry.get(toolName)
			const view = definition?.presentResult
				? guard(toolName, 'presentResult', () => definition.presentResult?.(input, result))
				: undefined
			// Falls back to the RESULT's own text, not the input's label: a
			// caller asking how to show what came back and getting a
			// description of what went in is worse than a plain string.
			return view ?? { kind: 'generic', label: truncate(result.output ?? '') }
		},
	}
}
