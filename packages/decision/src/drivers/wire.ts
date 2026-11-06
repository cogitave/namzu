/**
 * Shared wire handling for decision drivers that speak the "System One"
 * request shape: a POST of `{ state, questions: { q: <question> } }` whose
 * response carries `{ answers: { q: <answer> } }`. Azure AI Foundry's
 * `microsoft/v1/systemone` endpoint and OpenRouter-style `/decisions`
 * servers both answer in this shape; a driver supplies the URL, the headers
 * and (optionally) a `model` field, and reuses the parsing here.
 */

import {
	type ChoiceDecision,
	DecisionError,
	type ScoreDecision,
	type YesNoDecision,
} from '../contract.js'

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberRecord(v: unknown): Record<string, number> {
	const out: Record<string, number> = {}
	if (isRecord(v)) {
		for (const [k, val] of Object.entries(v)) if (typeof val === 'number') out[k] = val
	}
	return out
}

export type Question = Record<string, unknown>

export interface DecisionPost {
	/** Fully-qualified URL to POST to. */
	url: string
	/** Request headers, including any Authorization. */
	headers: Record<string, string>
	/** The request body, already carrying `state` + `questions`. */
	body: Record<string, unknown>
	fetch: typeof fetch
	signal?: AbortSignal
}

/**
 * POST one question and return the answer object (`answers.q`), or throw a
 * {@link DecisionError} carrying the service's status and code on a non-2xx.
 */
export async function postDecision(post: DecisionPost): Promise<unknown> {
	const res = await post.fetch(post.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...post.headers },
		body: JSON.stringify(post.body),
		signal: post.signal,
	})
	let json: unknown
	try {
		json = await res.json()
	} catch {
		json = undefined
	}
	if (!res.ok) {
		const err = isRecord(json) && isRecord(json.error) ? json.error : {}
		throw new DecisionError(
			typeof err.message === 'string' ? err.message : `Decision request failed (${res.status})`,
			res.status,
			typeof err.code === 'string' ? err.code : undefined,
		)
	}
	const answers = isRecord(json) ? json.answers : undefined
	return isRecord(answers) ? answers.q : undefined
}

export function yesnoQuestion(instructions: string): Question {
	return { type: 'noul', instructions }
}

/**
 * A choice question: the options are the keys of `criteria` (2 to 255 of them), each with a
 * description or `null` for a bare label. Verified against the live service.
 */
export function choiceQuestion(instructions: string, options: readonly string[]): Question {
	return {
		type: 'choice',
		instructions,
		criteria: Object.fromEntries(options.map((option) => [option, null])),
	}
}

/** A score question: `criteria` is the ordered scale, lowest first (2 to 10 levels). Verified against the live service. */
export function scoreQuestion(instructions: string, levels: readonly string[]): Question {
	return { type: 'score', instructions, criteria: [...levels] }
}

export function parseYesNo(answer: unknown): YesNoDecision {
	const noul = isRecord(answer) ? answer.noul : undefined
	if (typeof noul !== 'number') {
		throw new DecisionError('Decision response carried no "noul" probability')
	}
	return { p: noul }
}

/** A choice answer is `{ choice, probabilities, confidence }`; the most probable option stands in if `choice` is absent. */
export function parseChoice<const T extends string>(answer: unknown): ChoiceDecision<T> {
	const body = isRecord(answer) ? answer : {}
	const probabilities = numberRecord(body.probabilities)
	let option: unknown = body.choice
	if (typeof option !== 'string') {
		option = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0]
	}
	if (typeof option !== 'string') {
		throw new DecisionError('Decision response carried no "choice" answer')
	}
	return {
		option: option as T,
		probabilities: probabilities as Record<T, number>,
		...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
	}
}

/**
 * A score answer is `{ score, probabilities, legend, confidence }`: `score` is the
 * probability-weighted average of the level indices (so it can fall between levels),
 * `probabilities` is keyed by index. `level` is the most probable level.
 */
export function parseScore(answer: unknown): ScoreDecision {
	const body = isRecord(answer) ? answer : {}
	const keyed = numberRecord(body.probabilities)
	const size = Object.keys(keyed).reduce((n, k) => Math.max(n, Number(k) + 1), 0)
	const probabilities = Array.from({ length: size }, (_, i) => keyed[String(i)] ?? 0)
	let level = 0
	probabilities.forEach((p, i) => {
		if (p > (probabilities[level] ?? 0)) level = i
	})
	if (probabilities.length === 0 && typeof body.score !== 'number') {
		throw new DecisionError('Decision response carried no "score" answer')
	}
	return {
		level: probabilities.length > 0 ? level : Math.round(body.score as number),
		probabilities,
		...(typeof body.score === 'number' ? { score: body.score } : {}),
		...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
	}
}
