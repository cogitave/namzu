import { GENAI } from '../../constants/telemetry/index.js'
import type {
	ToolResultGuardrailContext,
	ToolResultGuardrailSpec,
	ToolResultVerdict,
} from '../../types/guardrail/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'

/**
 * A tool result was refused terminally.
 *
 * Thrown rather than returned because the caller's failure path turns every
 * exception into an ordinary tool failure the model then reads and works
 * around — which is exactly what a terminal refusal must not become. The
 * distinct type is what lets that path re-throw this one and convert the
 * rest. A `halt` reported as a failed tool call would be a `refuse` with
 * extra steps.
 */
export class ToolResultHalted extends Error {
	readonly guardrail: string

	constructor(guardrail: string, reason: string) {
		super(`Tool result halted by guardrail "${guardrail}": ${reason}`)
		this.name = 'ToolResultHalted'
		this.guardrail = guardrail
	}
}

function nameOf(spec: { name?: string }, index: number): string {
	return spec.name ?? `tool-result-guardrail[${index}]`
}

function normalize<T>(spec: T | { name: string; check: T }): { name?: string; check: T } {
	return typeof spec === 'function' ? { check: spec as T } : (spec as { name: string; check: T })
}

/**
 * A guardrail that throws FAILS CLOSED, as the run-level ones do.
 *
 * `refuse` rather than `halt` for the same reason the tool boundary has a
 * recoverable refusal at all: a broken screen means this result's safety is
 * unknown, not that the run is unsalvageable. The model is told and can
 * choose differently.
 */
async function safely(
	run: () => ToolResultVerdict | Promise<ToolResultVerdict>,
	name: string,
	log: Logger,
): Promise<ToolResultVerdict> {
	try {
		return await run()
	} catch (err) {
		const reason = `guardrail "${name}" threw: ${toErrorMessage(err)}`
		log.error('Tool-result guardrail threw — failing closed', {
			'namzu.guardrail.name': name,
			'exception.message': toErrorMessage(err),
		})
		return { action: 'refuse', reason }
	}
}

/**
 * Screen a tool's result before anything downstream reads it.
 *
 * Runs every guardrail in order and stops at the first refusal. Rewrites
 * compose — each guardrail sees what the previous one produced — matching
 * the output-guardrail path, so a redaction chain behaves the same at both
 * boundaries.
 *
 * Returns the result to use. A refusal comes back as a failed `ToolResult`
 * carrying the reason, because that is the shape the model already knows
 * how to read: it is the same thing a tool that could not do its job
 * returns, and the alternative — a blank result — tells the model the tool
 * found nothing, which is a different claim and a false one.
 */
export async function screenToolResult(
	guardrails: readonly ToolResultGuardrailSpec[] | undefined,
	result: ToolResult,
	ctx: Omit<ToolResultGuardrailContext, 'output' | 'success'>,
	log: Logger,
): Promise<ToolResult> {
	if (!guardrails || guardrails.length === 0) return result

	let current = result.output
	let rewritten = false

	for (const [index, spec] of guardrails.entries()) {
		const { name, check } = normalize(spec)
		const label = nameOf({ name }, index)
		const verdict = await safely(
			() => check({ ...ctx, output: current, success: result.success }),
			label,
			log,
		)

		if (verdict.action === 'halt') {
			log.error('Tool-result guardrail halted the run', {
				[GENAI.TOOL_NAME]: ctx.toolName,
				'namzu.guardrail.name': label,
				reason: verdict.reason,
			})
			throw new ToolResultHalted(label, verdict.reason)
		}

		if (verdict.action === 'refuse') {
			log.warn('Tool-result guardrail refused the result', {
				[GENAI.TOOL_NAME]: ctx.toolName,
				'namzu.guardrail.name': label,
				reason: verdict.reason,
			})
			return {
				success: false,
				output: '',
				error: `Tool "${ctx.toolName}" produced a result that was refused by guardrail "${label}": ${verdict.reason}`,
			}
		}

		if (verdict.action === 'rewrite') {
			log.info('Tool-result guardrail rewrote the result', {
				[GENAI.TOOL_NAME]: ctx.toolName,
				'namzu.guardrail.name': label,
				reason: verdict.reason,
			})
			current = verdict.output
			rewritten = true
		}
	}

	return rewritten ? { ...result, output: current } : result
}
