import type { DecisionModel } from '@namzu/decision'
import type { Logger } from '@namzu/sdk'
import type { RoutingConfig, RoutingTarget } from '../../config/schema.js'

/**
 * Auto model routing: decide, per task, which configured model runs it.
 *
 * Pure of host state. The decision model, the clock, the logger and the
 * "is this provider usable here" question are all injected, so every path
 * below is testable offline. The one invariant that matters: this function
 * never throws and never fails open to anything but `routing.default`. A
 * decision outage must not silently send work to the expensive tier (cost)
 * or the weak one (quality).
 */

export type RouteTier = 'fast' | 'default' | 'big'

/** Locally computed facts about the task. No model call is needed to know them. */
export interface RouteFeatures {
	/** Files or images attached to the task. */
	readonly attachmentCount?: number
	/** The task will drive the desktop. */
	readonly usesComputerUse?: boolean
	/** The task runs inside a Pal. */
	readonly usesPal?: boolean
	/** Messages already in the conversation. */
	readonly conversationLength?: number
	/** The task was spoken, not typed. */
	readonly voice?: boolean
	/** The tier the previous turn failed on, if it failed. */
	readonly previousTurnFailedOnTier?: RouteTier
}

export interface RouteInput {
	/** The user's text for this task. Truncated before it is sent anywhere. */
	readonly task: string
	readonly features?: RouteFeatures
	readonly config: RoutingConfig
	/** An explicit user model choice. Wins over everything, with no model call. */
	readonly pin?: RoutingTarget
	/** Aborts the decision; the result is then the default. */
	readonly signal?: AbortSignal
}

export interface RouteDeps {
	/** Absent means no decision model is configured: the default runs. */
	readonly model?: DecisionModel
	/** Whether this machine can run a tier's provider. Absent means every tier can. */
	readonly isAvailable?: (target: RoutingTarget) => boolean
	readonly now?: () => number
	readonly logger?: Pick<Logger, 'debug'>
}

export interface RouteResult {
	readonly tier: RouteTier
	readonly provider: string
	readonly model: string
	/** Probability behind the pick, 0 to 1. 0 when nothing was decided. */
	readonly confidence: number
	/** A short stable code, safe to log. */
	readonly reason: string
}

export const DEFAULT_ROUTING_TIMEOUT_MS = 400
export const DEFAULT_ROUTING_THRESHOLD = 0.7
export const ROUTING_TASK_CHARS = 1500
/** Conversations longer than this outgrow a small model's window. */
const FAST_MAX_CONVERSATION = 40

export const ROUTING_FAST_QUESTION =
	'Is this task simple enough for a small, fast model to complete correctly? Answer yes only for short chat, a lookup, or a single small step.'
export const ROUTING_BIG_QUESTION =
	'Does this task need deep multi-step reasoning or large-scale code changes across many files?'
export const ROUTING_SCORE_LEVELS: readonly string[] = [
	'trivial: chat, lookup, or one step',
	'small: a single-file or single-tool task',
	'medium: multi-step work across several files',
	'large: open-ended, architectural, or long-horizon work',
]

function truncate(task: string): string {
	return task.length > ROUTING_TASK_CHARS ? task.slice(0, ROUTING_TASK_CHARS) : task
}

function describeState(task: string, features: RouteFeatures | undefined): string {
	const facts: string[] = []
	if (features?.attachmentCount) facts.push(`attachments: ${features.attachmentCount}`)
	if (features?.usesComputerUse) facts.push('drives the desktop')
	if (features?.usesPal) facts.push('runs in a Pal')
	if (features?.conversationLength) facts.push(`messages so far: ${features.conversationLength}`)
	if (features?.voice) facts.push('spoken')
	return facts.length > 0 ? `${truncate(task)}\n\n[${facts.join('; ')}]` : truncate(task)
}

function probability(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError('malformed probability')
	}
	return value
}

function massAtOrBelow(probabilities: readonly number[], last: number): number {
	const total = probabilities.reduce((sum, p) => sum + p, 0)
	if (!(total > 0)) throw new RangeError('malformed probabilities')
	return probabilities.slice(0, last + 1).reduce((sum, p) => sum + p, 0) / total
}

class RouteInterrupted extends Error {
	constructor(readonly reason: 'timeout' | 'aborted') {
		super(reason)
	}
}

/** Ask the decision model, bounded by the router's own timeout and the caller's signal. */
async function withinBudget<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	outer: AbortSignal | undefined,
): Promise<T> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onOuterAbort: (() => void) | undefined
	const interrupted = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new RouteInterrupted('timeout'))
		}, timeoutMs)
		onOuterAbort = () => {
			controller.abort()
			reject(new RouteInterrupted('aborted'))
		}
		if (outer?.aborted) onOuterAbort()
		else outer?.addEventListener('abort', onOuterAbort, { once: true })
	})
	try {
		return await Promise.race([run(controller.signal), interrupted])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		if (onOuterAbort) outer?.removeEventListener('abort', onOuterAbort)
	}
}

export async function routeModel(input: RouteInput, deps: RouteDeps = {}): Promise<RouteResult> {
	const now = deps.now ?? Date.now
	const started = now()
	const { config } = input
	const result = (
		tier: RouteTier,
		target: RoutingTarget,
		confidence: number,
		reason: string,
	): RouteResult => {
		const routed: RouteResult = {
			tier,
			provider: target.provider,
			model: target.model,
			confidence,
			reason,
		}
		try {
			deps.logger?.debug('auto model routed', {
				'namzu.routing.tier': tier,
				'namzu.routing.reason': reason,
				'namzu.routing.confidence': confidence,
				'namzu.routing.duration_ms': Math.max(0, now() - started),
				'gen_ai.request.model': target.model,
				'namzu.provider.id': target.provider,
			})
		} catch {
			// A logger must never be able to fail a turn.
		}
		return routed
	}
	const fallback = (reason: string): RouteResult => result('default', config.default, 0, reason)

	try {
		if (input.pin) return result('default', input.pin, 1, 'pinned')

		const usable = (target: RoutingTarget | undefined): RoutingTarget | undefined =>
			target && (deps.isAvailable?.(target) ?? true) ? target : undefined
		const features = input.features
		const failedOn = features?.previousTurnFailedOnTier
		const big = usable(config.tiers?.big)
		// The small tier is scoped to short chat and one-step tasks: small
		// models are poor at multi-step tool use, so anything that drives the
		// desktop, runs in a Pal, carries attachments or sits in a long
		// conversation never reaches it.
		const fastBarred =
			features?.usesComputerUse === true ||
			features?.usesPal === true ||
			(features?.attachmentCount ?? 0) > 0 ||
			(features?.conversationLength ?? 0) > FAST_MAX_CONVERSATION ||
			failedOn === 'fast' ||
			failedOn === 'default'
		const fast = fastBarred ? undefined : usable(config.tiers?.fast)

		// A failure escalates exactly one tier and needs no model call.
		if (failedOn === 'fast') return result('default', config.default, 1, 'escalated-after-failure')
		if (failedOn === 'default') {
			return big
				? result('big', big, 1, 'escalated-after-failure')
				: fallback('failed-no-bigger-tier')
		}

		if (!fast && !big) return fallback(fastBarred ? 'fast-tier-barred' : 'no-tier-available')
		if (!deps.model) return fallback('no-decision-model')

		const model = deps.model
		const timeoutMs = config.timeoutMs ?? DEFAULT_ROUTING_TIMEOUT_MS
		const fastThreshold = config.thresholds?.fast ?? DEFAULT_ROUTING_THRESHOLD
		const bigThreshold = config.thresholds?.big ?? DEFAULT_ROUTING_THRESHOLD
		const state = describeState(input.task, features)

		let pFast: number | undefined
		let pBig: number | undefined
		if (config.strategy === 'score') {
			const decision = await withinBudget(
				(signal) => model.score(state, '', ROUTING_SCORE_LEVELS, { signal }),
				timeoutMs,
				input.signal,
			)
			const { probabilities } = decision
			if (!Array.isArray(probabilities) || probabilities.length !== ROUTING_SCORE_LEVELS.length) {
				throw new RangeError('malformed probabilities')
			}
			for (const p of probabilities) probability(p)
			if (fast) pFast = massAtOrBelow(probabilities, 1)
			if (big) pBig = 1 - massAtOrBelow(probabilities, 2)
		} else {
			const [fastDecision, bigDecision] = await withinBudget(
				(signal) =>
					Promise.all([
						fast
							? model.yesno(state, ROUTING_FAST_QUESTION, { signal })
							: Promise.resolve(undefined),
						big ? model.yesno(state, ROUTING_BIG_QUESTION, { signal }) : Promise.resolve(undefined),
					]),
				timeoutMs,
				input.signal,
			)
			if (fastDecision) pFast = probability(fastDecision.p)
			if (bigDecision) pBig = probability(bigDecision.p)
		}

		const wantsFast = fast !== undefined && pFast !== undefined && pFast >= fastThreshold
		const wantsBig = big !== undefined && pBig !== undefined && pBig >= bigThreshold
		// Both "trivial" and "deep" at once is a contradiction, not a signal.
		if (wantsFast && wantsBig) return fallback('contradictory-decision')
		if (wantsFast && fast) return result('fast', fast, pFast ?? 0, 'simple-task')
		if (wantsBig && big) return result('big', big, pBig ?? 0, 'demanding-task')
		const leaning = Math.max(pFast ?? 0, pBig ?? 0)
		return result('default', config.default, Math.max(0, 1 - leaning), 'ordinary-task')
	} catch (err) {
		if (err instanceof RouteInterrupted) return fallback(err.reason)
		if (err instanceof RangeError) return fallback('malformed-decision')
		return fallback('decision-unavailable')
	}
}

/**
 * The concrete model `auto` stands for when there is no task to size, such as
 * a Pal pinning its model at session start: the configured default if its
 * provider is usable here, else `undefined` so the caller keeps its own choice.
 */
export function resolveAutoDefault(
	config: RoutingConfig,
	isAvailable: (target: RoutingTarget) => boolean,
): RoutingTarget | undefined {
	return isAvailable(config.default) ? config.default : undefined
}
