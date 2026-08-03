import type {
	GuardrailVerdict,
	InputGuardrailContext,
	InputGuardrailSpec,
	OutputGuardrailContext,
	OutputGuardrailSpec,
} from '../../types/guardrail/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'

export interface GuardrailOutcome {
	/** True when a guardrail blocked. */
	readonly blocked: boolean
	/** Which guardrail decided, when it is named. */
	readonly name?: string
	readonly reason?: string
	/** Set when a guardrail rewrote the output rather than blocking it. */
	readonly rewritten?: string
}

function nameOf(spec: { name?: string }, index: number): string {
	return spec.name ?? `guardrail[${index}]`
}

function normalize<T>(spec: T | { name: string; check: T }): { name?: string; check: T } {
	return typeof spec === 'function' ? { check: spec as T } : (spec as { name: string; check: T })
}

/**
 * Run input guardrails before the first model call.
 *
 * Cheapest possible place to stop a run: nothing has been spent yet. The
 * previous surface could not do this at all — `run_start` fires with only
 * `{ runId }` and the `run_started` event carries only `systemPrompt`, so
 * the user's prompt was unreachable from any hook.
 */
export async function runInputGuardrails(
	guardrails: readonly InputGuardrailSpec[] | undefined,
	ctx: InputGuardrailContext,
	log: Logger,
): Promise<GuardrailOutcome> {
	if (!guardrails || guardrails.length === 0) return { blocked: false }

	for (const [index, spec] of guardrails.entries()) {
		const { name, check } = normalize(spec)
		const verdict = await safely(() => check(ctx), nameOf({ name }, index), log)
		if (verdict.action === 'block') {
			log.warn('Input guardrail blocked the run', {
				runId: ctx.runId,
				guardrail: nameOf({ name }, index),
				reason: verdict.reason,
			})
			return { blocked: true, name: nameOf({ name }, index), reason: verdict.reason }
		}
		// `rewrite` is meaningless on input: the run has not produced
		// anything to rewrite, and silently editing a user's prompt is a
		// different (and worse) feature than refusing it.
		if (verdict.action === 'rewrite') {
			log.warn('Input guardrail returned `rewrite`, which is not supported on input — ignoring', {
				runId: ctx.runId,
				guardrail: nameOf({ name }, index),
			})
		}
	}

	return { blocked: false }
}

/**
 * Run output guardrails against the final result.
 *
 * **Caveat, stated plainly:** this gates the FINAL result, not the stream.
 * `text_delta` events reach the host as the model produces them, so a
 * consumer that renders deltas live has already shown text by the time a
 * guardrail sees it. A rewrite therefore has to be treated as a
 * correction, and `run_completed` carries the corrected text. Gating the
 * stream itself would mean buffering every token — trading the streaming
 * UX for the guarantee — which is a decision for the host, not the SDK.
 *
 * Rewrites compose: each guardrail sees what the previous one produced.
 */
export async function runOutputGuardrails(
	guardrails: readonly OutputGuardrailSpec[] | undefined,
	ctx: OutputGuardrailContext,
	log: Logger,
): Promise<GuardrailOutcome> {
	if (!guardrails || guardrails.length === 0) return { blocked: false }

	let current = ctx.output
	let rewritten = false

	for (const [index, spec] of guardrails.entries()) {
		const { name, check } = normalize(spec)
		const verdict = await safely(
			() => check({ ...ctx, output: current }),
			nameOf({ name }, index),
			log,
		)

		if (verdict.action === 'block') {
			log.warn('Output guardrail blocked the result', {
				runId: ctx.runId,
				guardrail: nameOf({ name }, index),
				reason: verdict.reason,
			})
			return { blocked: true, name: nameOf({ name }, index), reason: verdict.reason }
		}

		if (verdict.action === 'rewrite') {
			log.info('Output guardrail rewrote the result', {
				runId: ctx.runId,
				guardrail: nameOf({ name }, index),
				reason: verdict.reason,
			})
			current = verdict.output
			rewritten = true
		}
	}

	return rewritten ? { blocked: false, rewritten: current } : { blocked: false }
}

/**
 * A guardrail that throws FAILS CLOSED.
 *
 * The opposite of the stop-condition policy, and deliberately so: a broken
 * halt predicate should not kill a healthy run, but a broken safety check
 * must not silently wave content through. If the thing that decides
 * whether output is safe is itself broken, the honest answer is that
 * safety is unknown.
 */
async function safely(
	run: () => GuardrailVerdict | Promise<GuardrailVerdict>,
	name: string,
	log: Logger,
): Promise<GuardrailVerdict> {
	try {
		return await run()
	} catch (err) {
		const reason = `guardrail "${name}" threw: ${toErrorMessage(err)}`
		log.error('Guardrail threw — failing closed', { guardrail: name, error: toErrorMessage(err) })
		return { action: 'block', reason }
	}
}
