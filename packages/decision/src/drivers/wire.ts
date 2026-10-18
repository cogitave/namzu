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

// TODO(decision): confirm the live wire field for choice options against the
// Foundry OpenAPI schema (yesno is verified; choice/score request shape is
// provisional).
export function choiceQuestion(instructions: string, options: readonly string[]): Question {
	return { type: 'choice', instructions, options: [...options] }
}

// TODO(decision): confirm the live wire field for score levels against the
// Foundry OpenAPI schema (yesno is verified; choice/score request shape is
// provisional).
export function scoreQuestion(instructions: string, levels: readonly string[]): Question {
	return { type: 'score', instructions, levels: [...levels] }
}

export function parseYesNo(answer: unknown): YesNoDecision {
	const noul = isRecord(answer) ? answer.noul : undefined
	if (typeof noul !== 'number') {
		throw new DecisionError('Decision response carried no "noul" probability')
	}
	return { p: noul }
}

export function parseChoice<const T extends string>(answer: unknown): ChoiceDecision<T> {
	const body = isRecord(answer) && isRecord(answer.choice) ? answer.choice : answer
	const probabilities = numberRecord(isRecord(body) ? body.probabilities : undefined)
	let option = isRecord(body) ? body.option : undefined
	if (typeof option !== 'string') {
		// Defensive: fall back to the most probable option.
		option = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0]
	}
	if (typeof option !== 'string') {
		throw new DecisionError('Decision response carried no "choice" answer')
	}
	return { option: option as T, probabilities: probabilities as Record<T, number> }
}

export function parseScore(answer: unknown): ScoreDecision {
	const body = isRecord(answer) && isRecord(answer.score) ? answer.score : answer
	const raw = isRecord(body) ? body : {}
	const probabilities = Array.isArray(raw.probabilities)
		? raw.probabilities.filter((x): x is number => typeof x === 'number')
		: []
	let level = raw.level
	if (typeof level !== 'number') {
		let best = -1
		probabilities.forEach((p, i) => {
			if (best < 0 || p > (probabilities[best] ?? 0)) best = i
		})
		level = best >= 0 ? best : undefined
	}
	if (typeof level !== 'number') {
		throw new DecisionError('Decision response carried no "score" answer')
	}
	return { level, probabilities }
}
