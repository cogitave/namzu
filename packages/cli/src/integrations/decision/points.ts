/**
 * Decision points: the places the host lets a System-1 decision model weigh in.
 *
 * A point is one named yes/no question the host already answers with a rule. The
 * decision model may be asked the same question beside the rule, and a point has a
 * mode:
 *
 * - `off`: nothing is asked. The default for every point, because a question
 *   carries text of the conversation to the decision service.
 * - `shadow`: the model is asked and its answer is written to the log with what
 *   the rule decided, and nothing else happens. This is how a point earns trust:
 *   the log says how often the two agree before anyone lets the model act.
 * - `on`: the answer is handed back to the caller, which acts on it only where
 *   the model is confident and keeps its rule everywhere else.
 *
 * Nothing here throws, waits longer than its timeout, or lets a failure reach the
 * caller as anything but "no answer". The log holds no text of the conversation:
 * only which point, the mode, the probability, what the rule said, how long the
 * call took and how it ended.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionModel } from '@namzu/decision'
import type { DecisionPointId, DecisionPointMode } from '../../config/schema.js'
import { namzuHomePath } from '../state/home.js'

/** One line of the decision log. */
export interface DecisionLogEntry {
	readonly at: number
	readonly point: DecisionPointId
	readonly mode: DecisionPointMode
	/** P(true) from the model, absent when there was no answer. */
	readonly p?: number
	/** What the host's own rule decided for the same question. */
	readonly rule: boolean
	readonly latencyMs: number
	readonly outcome: 'answered' | 'timeout' | 'error'
	/** Characters of the question's state: a size, never the text. */
	readonly chars: number
	/**
	 * For a choice among several options: whether the model's top option was the one the host (or
	 * the model being watched) chose. Absent for a yes/no question and when the model gave no answer.
	 */
	readonly agreed?: boolean
	/** For a choice: how many options were put to the model. */
	readonly options?: number
}

export interface DecisionQuestion {
	readonly point: DecisionPointId
	/** What the model is shown. It leaves the machine, so it is cut by the caller. */
	readonly state: string
	readonly instructions: string
	/** The answer the host's rule gave, for the log. */
	readonly rule: boolean
}

/** A choice among named options; the answer is a ranking of them. */
export interface DecisionChoiceQuestion {
	readonly point: DecisionPointId
	readonly state: string
	readonly instructions: string
	/** 2 to 255 distinct options. */
	readonly options: readonly string[]
	/**
	 * The option already chosen by the host's rule or by the model being watched, for the log. Absent
	 * when nothing has chosen: the answer then decides, and there is nothing to compare with.
	 */
	readonly chosen?: string
}

/** Options in order of fit, best first, each with the probability the model gave it. */
export interface DecisionRanking {
	readonly ranked: readonly { readonly option: string; readonly p: number }[]
}

export interface DecisionPointsOptions {
	readonly model: DecisionModel | undefined
	readonly modes: Readonly<Partial<Record<DecisionPointId, DecisionPointMode>>> | undefined
	readonly timeoutMs?: number
	readonly now?: () => number
	/** Where entries go; the default appends to `<NAMZU_HOME>/decision/points.jsonl`. */
	readonly log?: (entry: DecisionLogEntry) => void
}

export interface DecisionPoints {
	/** The mode a point is in; `off` when no model is configured. */
	mode(point: DecisionPointId): DecisionPointMode
	/**
	 * Ask the model, as the point's mode allows. Resolves to P(true) only in `on` mode
	 * and only when the model answered in time; `undefined` in every other case, so a
	 * caller that gets nothing keeps its rule.
	 */
	ask(question: DecisionQuestion, signal?: AbortSignal): Promise<number | undefined>
	/**
	 * Ask the model to choose among options, as the point's mode allows. Resolves to the ranking only
	 * in `on` mode and only when the model answered in time; `undefined` otherwise. In `shadow` and
	 * `on` the answer is logged: the probability it gave the option already chosen, and whether its
	 * top option was that one.
	 */
	choose(
		question: DecisionChoiceQuestion,
		signal?: AbortSignal,
	): Promise<DecisionRanking | undefined>
}

const DEFAULT_TIMEOUT_MS = 1_500
const LOG_ROTATE_BYTES = 1_000_000

export function createDecisionPoints(options: DecisionPointsOptions): DecisionPoints {
	const { model } = options
	const now = options.now ?? Date.now
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const log = options.log ?? appendDecisionLog
	const mode = (point: DecisionPointId): DecisionPointMode =>
		model === undefined ? 'off' : (options.modes?.[point] ?? 'off')

	/** Runs one call to the model inside the timeout and the caller's signal. Never throws. */
	const timed = async <T>(
		exec: (model: DecisionModel, signal: AbortSignal) => Promise<T>,
		model: DecisionModel,
		signal: AbortSignal | undefined,
	): Promise<{ value?: T; outcome: DecisionLogEntry['outcome'] }> => {
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		const onOuterAbort = () => controller.abort()
		signal?.addEventListener('abort', onOuterAbort, { once: true })
		if (signal?.aborted) controller.abort()
		try {
			const timedOut = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort()
					reject(new Error('timeout'))
				}, timeoutMs)
			})
			const value = await Promise.race([exec(model, controller.signal), timedOut])
			return { value, outcome: 'answered' }
		} catch (error) {
			return {
				outcome: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'error',
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer)
			signal?.removeEventListener('abort', onOuterAbort)
		}
	}
	const record = (entry: DecisionLogEntry): void => {
		try {
			log(entry)
		} catch {
			// A log that cannot be written is not a reason to lose the decision.
		}
	}

	return {
		mode,
		async ask(question, signal) {
			const current = mode(question.point)
			if (current === 'off' || model === undefined) return undefined
			const startedAt = now()
			const called = await timed(
				(m, s) => m.yesno(question.state, question.instructions, { signal: s }),
				model,
				signal,
			)
			let p: number | undefined = called.value?.p
			let outcome = called.outcome
			if (
				outcome === 'answered' &&
				(typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
			) {
				p = undefined
				outcome = 'error'
			}
			record({
				at: startedAt,
				point: question.point,
				mode: current,
				...(p !== undefined ? { p } : {}),
				rule: question.rule,
				latencyMs: Math.max(0, now() - startedAt),
				outcome,
				chars: question.state.length,
			})
			return current === 'on' ? p : undefined
		},
		async choose(question, signal) {
			const current = mode(question.point)
			if (current === 'off' || model === undefined) return undefined
			if (question.options.length < 2 || question.options.length > 255) return undefined
			const startedAt = now()
			const called = await timed(
				(m, s) =>
					m.choice(question.state, question.instructions, question.options, {
						signal: s,
					}),
				model,
				signal,
			)
			let ranking: DecisionRanking | undefined
			let outcome = called.outcome
			if (outcome === 'answered') {
				ranking = rankOptions(question.options, called.value?.probabilities)
				if (!ranking) outcome = 'error'
			}
			const top = ranking?.ranked[0]
			const chosenP =
				question.chosen !== undefined
					? ranking?.ranked.find((entry) => entry.option === question.chosen)?.p
					: top?.p
			record({
				at: startedAt,
				point: question.point,
				mode: current,
				...(chosenP !== undefined ? { p: chosenP } : {}),
				rule: question.chosen !== undefined,
				latencyMs: Math.max(0, now() - startedAt),
				outcome,
				chars: question.state.length,
				options: question.options.length,
				...(top && question.chosen !== undefined ? { agreed: top.option === question.chosen } : {}),
			})
			return current === 'on' ? ranking : undefined
		},
	}
}

/** The options sorted by the probability the model gave them; undefined when it gave none usable. */
function rankOptions(
	options: readonly string[],
	probabilities: Readonly<Record<string, number>> | undefined,
): DecisionRanking | undefined {
	if (!probabilities) return undefined
	const ranked = options
		.map((option) => ({ option, p: probabilities[option] }))
		.filter(
			(entry): entry is { option: string; p: number } =>
				typeof entry.p === 'number' && Number.isFinite(entry.p) && entry.p >= 0 && entry.p <= 1,
		)
		.sort((a, b) => b.p - a.p)
	return ranked.length > 0 ? { ranked } : undefined
}

/** Appends one entry to the decision log, rotating it once at a megabyte. Never throws. */
export function appendDecisionLog(entry: DecisionLogEntry, home: string = namzuHomePath()): void {
	try {
		const directory = join(home, 'decision')
		const file = join(directory, 'points.jsonl')
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		try {
			if (statSync(file).size >= LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
		} catch {
			// No log yet.
		}
		appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
	} catch {
		// Optional record keeping must never reach the person.
	}
}

/** The answer a caller acts on: only a confident one is `yes` or `no`. */
export type Verdict = 'yes' | 'no' | 'unsure'

export const CONFIDENT_YES = 0.7
export const CONFIDENT_NO = 0.3

export function verdictOf(p: number | undefined): Verdict {
	if (p === undefined) return 'unsure'
	if (p >= CONFIDENT_YES) return 'yes'
	if (p <= CONFIDENT_NO) return 'no'
	return 'unsure'
}
