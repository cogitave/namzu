/**
 * The auto-review classifier: a model that reads one proposed action in the
 * light of the conversation and says whether it may run.
 *
 * It backs the `classify` review mode. The mode decides WHICH calls are put to
 * it (see `review-policy.ts`); this decides what happens to one. Four things
 * are non-negotiable, and each has a test:
 *
 * - **Two passes.** A short pass (at most 64 output tokens) answers block or
 *   allow. Allow ends it. Block goes to a longer pass (at most 8192) that may
 *   reason about the person's authority, and its verdict stands.
 * - **Fail closed.** A provider error, an unreadable answer, or running out of
 *   retries blocks the call. There is no path from "could not check" to "run".
 * - **No tool results.** The transcript it reads holds what the person and the
 *   agent said and what the agent asked tools to do, never what they returned.
 * - **Counting.** Blocks are counted so a host can stop a session that keeps
 *   hitting them: after a run of consecutive blocks, or a total, the decision
 *   carries `limitReached` and the host chooses what to do. The classifier
 *   never changes a mode.
 */

import { GENAI } from '../../../constants/telemetry/index.js'
import { collectChatCompletion } from '../../../provider/collect-chat-completion.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TokenUsage } from '../../../types/common/index.js'
import type { ToolCallSummary } from '../../../types/hitl/index.js'
import {
	type Message,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { classifyProviderError } from '../../../types/provider/errors.js'
import type { LLMProvider } from '../../../types/provider/interface.js'
import {
	type BackoffPolicy,
	sleep as abortableSleep,
	backoffProportional,
} from '../../../utils/backoff.js'
import { SCOPE_ATTRIBUTE } from '../../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../../utils/logger.js'
import {
	STAGE_ONE_INSTRUCTION,
	STAGE_TWO_INSTRUCTION,
	VERDICT_STOP,
	buildSystemPrompt,
} from './prompt.js'
import { type AutoReviewRules, resolveAutoReviewRules } from './rules.js'
import { projectAction, projectTranscript, renderEntry, renderedLength } from './transcript.js'
import { parseVerdict } from './verdict.js'

/** Which pass produced a decision. `0` means neither ran. */
export type AutoReviewStage = 0 | 1 | 2

/** What one review came to. */
export type AutoReviewDecision =
	| {
			readonly verdict: 'allow'
			readonly stage: 1 | 2
			readonly latencyMs: number
	  }
	| {
			readonly verdict: 'block'
			/**
			 * `rule`: the classifier judged it unsafe. `unavailable`: the check could
			 * not be completed. `unreadable`: the answer was not a verdict.
			 * `aborted`: the turn was cancelled while it ran.
			 */
			readonly cause: 'rule' | 'unavailable' | 'unreadable' | 'aborted'
			readonly stage: AutoReviewStage
			/** One plain sentence, fit to show the person and to tell the model. */
			readonly reason: string
			/** The rule the classifier named, when it named one. */
			readonly rule?: string
			readonly latencyMs: number
			/**
			 * Set on the block that brought the counters to a limit. They are reset
			 * as this is returned; what to do about it is the host's decision.
			 */
			readonly limitReached?: 'consecutive' | 'total'
	  }
	| {
			/**
			 * The conversation is too long for the check to read. Nothing was
			 * judged; the host should compact and try again.
			 */
			readonly verdict: 'too_long'
	  }

/** One action to be reviewed. */
export interface AutoReviewRequest {
	/** The call under review. Its id is left out of the transcript so it is not shown twice. */
	readonly call: Pick<ToolCallSummary, 'id' | 'name' | 'input'>
	/** The conversation so far. Tool results in it are ignored. */
	readonly transcript: readonly Message[]
	/** Where tool definitions are read for `classifierInput`. */
	readonly tools?: Pick<ToolManager, 'get'>
	readonly signal?: AbortSignal
}

/** How many blocks the classifier tolerates before it tells the host to step in. */
export interface AutoReviewLimits {
	/** Blocks in a row. Default 3. */
	readonly consecutive?: number
	/** Blocks over the whole session, until a limit is reported. Default 20. */
	readonly total?: number
}

export interface AutoReviewClassifierOptions {
	readonly provider: LLMProvider
	readonly model: string
	/** Additions to, or replacements of, the built-in rule lists. */
	readonly rules?: AutoReviewRules
	readonly log?: Logger
	/** Told what each pass cost, so a host can charge it to the session. */
	readonly onUsage?: (usage: TokenUsage, stage: 1 | 2) => void
	readonly limits?: AutoReviewLimits
	/**
	 * The longest rendered transcript, in characters, that is sent. Longer is
	 * reported as `too_long`. Default 400 000 (roughly 100 000 tokens).
	 */
	readonly maxTranscriptChars?: number
	/** The most characters one transcript entry keeps. Default 2000. */
	readonly maxEntryChars?: number
	/** Retries after a failed provider call. Default 2. */
	readonly maxRetries?: number
	/** The wait before a retry. Default 2 s doubling to 10 s, with some jitter. */
	readonly retryDelay?: BackoffPolicy
	/** How long the first pass may take. Default 60 s. */
	readonly quickDeadlineMs?: number
	/** How long the second pass may take. Default 120 s. */
	readonly reasonedDeadlineMs?: number
	/** Sampling temperature. Default 0. */
	readonly temperature?: number
	/** The wait between retries; replaced by tests so they never wait for real. */
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	/** Jitter source for the retry delay. */
	readonly random?: () => number
	/** Clock for latency. */
	readonly now?: () => number
}

export interface AutoReviewClassifier {
	/** Reviews one action. Never throws for a provider failure: that is a block. */
	review(request: AutoReviewRequest): Promise<AutoReviewDecision>
	/** The block counters right now. */
	readonly denials: { readonly consecutive: number; readonly total: number }
	/** Zeroes the block counters. */
	reset(): void
}

export const DEFAULT_AUTO_REVIEW_LIMITS = { consecutive: 3, total: 20 } as const
const DEFAULT_MAX_TRANSCRIPT_CHARS = 400_000
const DEFAULT_RETRY_DELAY: BackoffPolicy = { initialDelayMs: 2_000, maxDelayMs: 10_000 }
const ACTION_CHARS = 8_000

/** The words the model is told when a call is blocked. */
export function autoReviewBlockedFeedback(reason: string): string {
	return `Blocked by auto mode: ${reason}. Do not try to work around this; if the action is needed, tell the user what you want to do and why, so they can approve it or switch modes.`
}

class DeadlineError extends Error {
	readonly retryable = true
	constructor() {
		super('the safety check took too long')
		this.name = 'DeadlineError'
	}
}

class TooLongError extends Error {}

export function createAutoReviewClassifier(
	options: AutoReviewClassifierOptions,
): AutoReviewClassifier {
	const log = resolveLogger(options.log).child({ [SCOPE_ATTRIBUTE]: 'runtime/auto-review' })
	const systemPrompt = buildSystemPrompt(resolveAutoReviewRules(options.rules))
	const limits = {
		consecutive: options.limits?.consecutive ?? DEFAULT_AUTO_REVIEW_LIMITS.consecutive,
		total: options.limits?.total ?? DEFAULT_AUTO_REVIEW_LIMITS.total,
	}
	const maxChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS
	const maxRetries = options.maxRetries ?? 2
	const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY
	const sleep = options.sleep ?? abortableSleep
	const random = options.random ?? Math.random
	const now = options.now ?? Date.now
	let consecutive = 0
	let total = 0

	/** One provider call, bounded by a deadline and by the turn's own signal. */
	async function ask(
		messages: Message[],
		stage: 1 | 2,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const deadlineMs =
			stage === 1 ? (options.quickDeadlineMs ?? 60_000) : (options.reasonedDeadlineMs ?? 120_000)
		for (let attempt = 0; ; attempt += 1) {
			const controller = new AbortController()
			const onAbort = (): void => controller.abort(signal?.reason)
			if (signal?.aborted) throw signal.reason ?? new Error('aborted')
			signal?.addEventListener('abort', onAbort, { once: true })
			let expired = false
			const timer = setTimeout(() => {
				expired = true
				controller.abort(new DeadlineError())
			}, deadlineMs)
			try {
				// Raced against the abort, not only handed the signal: a provider that
				// ignores it would otherwise hold the call open past its deadline, and
				// a turn cancelled while it waits would wait with it.
				const collected = collectChatCompletion(
					options.provider.chatStream({
						model: options.model,
						messages,
						maxTokens: stage === 1 ? 64 : 8_192,
						temperature: options.temperature ?? 0,
						...(stage === 1 ? { stop: [VERDICT_STOP] } : {}),
						cacheControl: { type: 'auto' },
						signal: controller.signal,
					}),
				)
				collected.catch(() => {})
				const cutOff = new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener(
						'abort',
						() => reject(controller.signal.reason ?? new Error('aborted')),
						{ once: true },
					)
				})
				cutOff.catch(() => {})
				const response = await Promise.race([collected, cutOff])
				options.onUsage?.(response.usage, stage)
				return response.message.content ?? ''
			} catch (error) {
				if (signal?.aborted) throw error
				const cause = expired ? new DeadlineError() : error
				const classified = classifyProviderError(cause)
				if (classified.code === 'context_length_exceeded') throw new TooLongError()
				if ((!expired && !classified.retryable) || attempt >= maxRetries) throw cause
				await sleep(backoffProportional(attempt, retryDelay, random), signal)
			} finally {
				clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
			}
		}
	}

	function blocked(
		started: number,
		stage: AutoReviewStage,
		cause: 'rule' | 'unavailable' | 'unreadable' | 'aborted',
		reason: string,
		rule?: string,
	): AutoReviewDecision {
		let limitReached: 'consecutive' | 'total' | undefined
		if (cause !== 'aborted') {
			consecutive += 1
			total += 1
			if (consecutive >= limits.consecutive) limitReached = 'consecutive'
			else if (total >= limits.total) limitReached = 'total'
			if (limitReached !== undefined) {
				consecutive = 0
				total = 0
			}
		}
		return {
			verdict: 'block',
			cause,
			stage,
			reason,
			...(rule !== undefined ? { rule } : {}),
			latencyMs: now() - started,
			...(limitReached !== undefined ? { limitReached } : {}),
		}
	}

	function record(name: string, decision: AutoReviewDecision, started: number): void {
		log.info('auto review decision', {
			[GENAI.TOOL_NAME]: name,
			'namzu.auto_review.verdict': decision.verdict,
			'namzu.auto_review.latency_ms': now() - started,
			...(decision.verdict !== 'too_long' ? { 'namzu.auto_review.stage': decision.stage } : {}),
			...(decision.verdict === 'block' ? { 'namzu.auto_review.cause': decision.cause } : {}),
			...(decision.verdict === 'block' && decision.limitReached
				? { 'namzu.auto_review.limit_reached': decision.limitReached }
				: {}),
		})
	}

	async function review(request: AutoReviewRequest): Promise<AutoReviewDecision> {
		const started = now()
		const decision = await decide(request, started)
		record(request.call.name, decision, started)
		return decision
	}

	async function decide(request: AutoReviewRequest, started: number): Promise<AutoReviewDecision> {
		const entries = projectTranscript(request.transcript, {
			...(request.tools ? { tools: request.tools } : {}),
			excludeCallIds: new Set([request.call.id]),
			...(options.maxEntryChars !== undefined ? { maxEntryChars: options.maxEntryChars } : {}),
		})
		const lines = entries.map(renderEntry)
		const projected = projectAction(
			request.call.name,
			request.call.input,
			request.tools,
			ACTION_CHARS,
		)
		// A prefix of a command is not the command: what follows the cut could be
		// anything, and a verdict on the part that was shown says nothing about it.
		if (projected.truncated) {
			return blocked(
				started,
				0,
				'unreadable',
				'the action is too long for the safety check to read in full, so it was not run',
			)
		}
		const action = renderEntry({
			kind: 'tool',
			name: request.call.name,
			input: projected.text,
		})
		if (renderedLength(lines) + action.length > maxChars) return { verdict: 'too_long' }

		const body = `<transcript>\n${lines.join('\n')}\n</transcript>\n\nThe action under review:\n${action}\n\n`
		const conversation = (instruction: string): Message[] => [
			createSystemMessage(systemPrompt, 'cache'),
			createUserMessage(`${body}${instruction}`),
		]

		let quick: string
		try {
			quick = await ask(conversation(STAGE_ONE_INSTRUCTION), 1, request.signal)
		} catch (error) {
			if (error instanceof TooLongError) return { verdict: 'too_long' }
			if (request.signal?.aborted) {
				return blocked(started, 0, 'aborted', 'the review was cancelled before it finished')
			}
			return blocked(
				started,
				0,
				'unavailable',
				'the safety check could not be completed, so the action was not run',
			)
		}
		const first = parseVerdict(quick)
		// A first pass that says allow ends here; one that says block, or says
		// nothing readable, goes on to the careful pass, which can still allow.
		if (first !== undefined && !first.block)
			return { verdict: 'allow', stage: 1, latencyMs: now() - started }

		let careful: string
		try {
			careful = await ask(conversation(STAGE_TWO_INSTRUCTION), 2, request.signal)
		} catch (error) {
			if (error instanceof TooLongError) return { verdict: 'too_long' }
			if (request.signal?.aborted) {
				return blocked(started, 1, 'aborted', 'the review was cancelled before it finished')
			}
			return blocked(
				started,
				1,
				'unavailable',
				'a first look flagged this action and the closer look could not be completed',
			)
		}
		const second = parseVerdict(careful)
		if (second === undefined) {
			return blocked(
				started,
				2,
				'unreadable',
				'the safety check did not give a usable answer, so the action was not run',
			)
		}
		if (!second.block) {
			consecutive = 0
			return { verdict: 'allow', stage: 2, latencyMs: now() - started }
		}
		return blocked(started, 2, 'rule', second.reason ?? 'this action looks unsafe', second.rule)
	}

	return {
		review: async (request) => {
			const decision = await review(request)
			if (decision.verdict === 'allow') consecutive = 0
			return decision
		},
		get denials() {
			return { consecutive, total }
		},
		reset() {
			consecutive = 0
			total = 0
		},
	}
}
