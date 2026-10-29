import { AsyncLocalStorage } from 'node:async_hooks'

import {
	type AutoReviewClassifier,
	type AutoReviewDecision,
	type AutoReviewRequest,
	type LLMProvider,
	type Logger,
	type ResumeHandler,
	type SessionId,
	type TokenUsage,
	type TurnId,
	createAutoReviewClassifier,
} from '@namzu/sdk'

import { parseSmallModel } from '../integrations/small-model/route.js'
import type { AutoModeSettings } from './settings.js'

/**
 * The auto mode's classifier as this application builds it.
 *
 * The kernel owns the mechanism (`createAutoReviewClassifier`); this decides
 * three things it leaves to the host: which model answers, how a model is
 * reached for the session in hand, and who pays for the passes.
 *
 * ## The model
 *
 * `permissions.autoMode.model` names it. Left out, the session's own model
 * answers: a check that is cheaper than the work it guards is a check that is
 * easy to talk round, so quality is the default. `smallModel` as the value
 * means the side model, for an operator who would rather spend less. Anything
 * else is read like `smallModel` itself (`provider/model`, or a bare model of
 * the session's provider).
 *
 * ## Failing closed
 *
 * A model that cannot be reached, a provider with no credential on this
 * machine, a name nobody knows: each blocks the call it was asked about, in
 * the kernel's own words (`cause: 'unavailable'`). Nothing here turns "could
 * not check" into "go ahead".
 */

/** The reserved word for the side model in `permissions.autoMode.model`. */
export const SMALL_MODEL_KEYWORD = 'smallModel'

export interface ClassifierTarget {
	readonly providerId: string
	readonly model: string
}

export interface SessionClassifierDeps {
	readonly settings?: AutoModeSettings | undefined
	/** The provider and model the conversation runs on right now. */
	readonly active: () => ClassifierTarget
	readonly isKnownProvider: (providerId: string) => boolean
	/** A provider client for `target`; rejects when the machine has no credential for it. */
	readonly providerFor: (sessionId: SessionId, target: ClassifierTarget) => Promise<LLMProvider>
	/** The side model's route, when it is wanted. Absent: `smallModel` cannot be honoured. */
	readonly smallRoute?: (sessionId: SessionId, signal: AbortSignal) => Promise<ClassifierTarget>
	readonly log?: Logger | undefined
	/** Counts what a pass cost against the turn it belongs to. */
	readonly charge?: (input: {
		readonly sessionId: SessionId
		readonly turnId: TurnId
		readonly usage: TokenUsage
		readonly stage: 1 | 2
	}) => void
	/** Overrides for tests (limits, retry sleep and the like). */
	readonly classifierOptions?: Partial<Parameters<typeof createAutoReviewClassifier>[0]>
}

/** A call the classifier turned down, kept for `/permissions`. */
export interface RecentBlock {
	readonly tool: string
	/** What the call was about, short: the command, the path or the address. */
	readonly summary: string
	readonly reason: string
}

/** How many blocked calls are kept; the oldest drop first. */
export const RECENT_BLOCKS_KEPT = 20

function summaryOf(input: unknown): string {
	if (input && typeof input === 'object') {
		const record = input as Record<string, unknown>
		for (const key of ['command', 'path', 'file_path', 'url']) {
			const value = record[key]
			if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200)
		}
	}
	try {
		return (JSON.stringify(input) ?? '').slice(0, 200)
	} catch {
		return ''
	}
}

/** The session and turn whose handler is running; the classifier has no other way to know. */
interface ClassifierScope {
	readonly sessionId: SessionId
	readonly turnId: TurnId
}

const scope = new AsyncLocalStorage<ClassifierScope>()

/**
 * Runs a review handler inside the scope the classifier reads its session and
 * turn from. The kernel passes the classifier the call and the transcript, not
 * the turn that asked, and a pass has to be charged to a turn.
 */
export function withClassifierScope(handler: ResumeHandler): ResumeHandler {
	return (request, context) =>
		scope.run({ sessionId: request.sessionId, turnId: request.turnId }, () =>
			handler(request, context),
		)
}

/** Why the classifier cannot be used with these settings, or undefined when it can. */
export function classifierUnavailableReason(opts: {
	readonly settings?: AutoModeSettings | undefined
	readonly disabled?: boolean | undefined
	readonly active: ClassifierTarget
	readonly isKnownProvider: (providerId: string) => boolean
	/** Whether this machine holds a credential for the provider. */
	readonly hasCredential: (providerId: string) => boolean
	readonly hasSmallModel: boolean
}): string | undefined {
	if (opts.disabled) return 'Auto mode is turned off by permissions.disableAutoMode.'
	const named = opts.settings?.model
	if (named === undefined) return undefined
	if (named === SMALL_MODEL_KEYWORD) {
		return opts.hasSmallModel ? undefined : 'Auto mode has no small model to ask in this session.'
	}
	const target = parseSmallModel(named, opts.active.providerId, opts.isKnownProvider)
	if (!opts.isKnownProvider(target.providerId) || !opts.hasCredential(target.providerId)) {
		return `Auto mode asks ${named}, which this machine has no way to reach.`
	}
	return undefined
}

const UNAVAILABLE: Extract<AutoReviewDecision, { verdict: 'block' }> = {
	verdict: 'block',
	cause: 'unavailable',
	stage: 0,
	reason: 'the check that decides this could not be reached, so the action was not run',
	latencyMs: 0,
}

/**
 * One classifier for the session. The model it asks is settled on each review,
 * so a model switch mid-session is followed; the block counters belong to the
 * model in use, and start again when it changes.
 */
export function createSessionClassifier(
	deps: SessionClassifierDeps,
): AutoReviewClassifier & { recentBlocks(): readonly RecentBlock[] } {
	const blocks: RecentBlock[] = []
	const rules = deps.settings
		? {
				...(deps.settings.allow ? { allow: deps.settings.allow } : {}),
				...(deps.settings.softDeny ? { softDeny: deps.settings.softDeny } : {}),
				...(deps.settings.hardDeny ? { hardDeny: deps.settings.hardDeny } : {}),
				...(deps.settings.environment ? { environment: deps.settings.environment } : {}),
			}
		: undefined
	let current: { readonly key: string; readonly classifier: AutoReviewClassifier } | undefined

	const resolveTarget = async (
		sessionId: SessionId,
		signal: AbortSignal | undefined,
	): Promise<ClassifierTarget | undefined> => {
		const active = deps.active()
		const named = deps.settings?.model
		if (named === undefined) return active
		if (named === SMALL_MODEL_KEYWORD) {
			return deps.smallRoute?.(sessionId, signal ?? new AbortController().signal)
		}
		return parseSmallModel(named, active.providerId, deps.isKnownProvider)
	}

	const classifierFor = async (
		sessionId: SessionId,
		signal: AbortSignal | undefined,
	): Promise<AutoReviewClassifier | undefined> => {
		const target = await resolveTarget(sessionId, signal)
		if (target === undefined) return undefined
		const key = `${sessionId}\n${target.providerId}\n${target.model}`
		if (current?.key === key) return current.classifier
		const provider = await deps.providerFor(sessionId, target)
		const classifier = createAutoReviewClassifier({
			provider,
			model: target.model,
			...(rules ? { rules } : {}),
			...(deps.log ? { log: deps.log } : {}),
			onUsage: (usage, stage) => {
				const turn = scope.getStore()
				if (turn) deps.charge?.({ ...turn, usage, stage })
			},
			...deps.classifierOptions,
		})
		current = { key, classifier }
		return classifier
	}

	return {
		async review(request: AutoReviewRequest): Promise<AutoReviewDecision> {
			const turn = scope.getStore()
			try {
				const classifier = turn ? await classifierFor(turn.sessionId, request.signal) : undefined
				if (!classifier) return UNAVAILABLE
				const decision = await classifier.review(request)
				if (decision.verdict === 'block' && decision.cause === 'rule') {
					blocks.unshift({
						tool: request.call.name,
						summary: summaryOf(request.call.input),
						reason: decision.reason,
					})
					blocks.length = Math.min(blocks.length, RECENT_BLOCKS_KEPT)
				}
				return decision
			} catch {
				return UNAVAILABLE
			}
		},
		recentBlocks() {
			return [...blocks]
		},
		get denials() {
			return current?.classifier.denials ?? { consecutive: 0, total: 0 }
		},
		reset() {
			current?.classifier.reset()
		},
	}
}
