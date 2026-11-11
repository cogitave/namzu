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
		// A validator may answer with its issue list as the whole body instead of an `error` object.
		const issueBody = Array.isArray(json) || (isRecord(json) && Array.isArray(json.issues))
		throw new DecisionError(
			typeof err.message === 'string'
				? err.message
				: issueBody
					? JSON.stringify(json)
					: `Decision request failed (${res.status})`,
			res.status,
			typeof err.code === 'string' ? err.code : undefined,
		)
	}
	const answers = isRecord(json) ? json.answers : undefined
	return isRecord(answers) ? answers.q : undefined
}

/** A yes/no question; `criteria` (what makes the answer yes) is added only when given. */
export function yesnoQuestion(instructions: string, criteria?: string): Question {
	return {
		type: 'noul',
		instructions,
		...(criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
	}
}

/** The forms a yes/no question's `criteria` can take on the wire, in the order they are tried. */
export type YesNoCriteriaForm = 'text' | 'object' | 'folded'

const CRITERIA_FORMS: readonly YesNoCriteriaForm[] = ['text', 'object', 'folded']

/**
 * What a service was last found to take for a yes/no `criteria`, per address and model, for the
 * life of the process. Only a form other than plain text is stored, so a service that takes text
 * is never touched.
 */
const rememberedForms = new Map<string, YesNoCriteriaForm>()

/** Test seam: forget what was learnt about services. */
export function forgetCriteriaForms(): void {
	rememberedForms.clear()
}

/**
 * A yes/no question in one of the criteria forms:
 * - `text`: `criteria` is the sentence (what the drivers have always sent);
 * - `object`: `criteria` is `{ true: <sentence> }`, the object form the service's published schema
 *   describes (its `true` and `false` keys are each optional);
 * - `folded`: no `criteria` field at all, the sentence appended to `instructions`.
 */
export function yesnoQuestionAs(
	form: YesNoCriteriaForm,
	instructions: string,
	criteria: string,
): Question {
	if (form === 'text') return yesnoQuestion(instructions, criteria)
	if (form === 'object') return { type: 'noul', instructions, criteria: { true: criteria } }
	return { type: 'noul', instructions: `${instructions}\n\n${criteria}` }
}

export interface SchemaIssue {
	path: string[]
	message: string
}

/** The issue list a validator put in an error message or body, or none when the text is not one. */
export function schemaIssues(text: string): SchemaIssue[] {
	const trimmed = text.trim()
	if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		return []
	}
	const list = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.issues)
			? parsed.issues
			: []
	const out: SchemaIssue[] = []
	for (const item of list) {
		if (!isRecord(item) || !Array.isArray(item.path) || typeof item.message !== 'string') continue
		out.push({ path: item.path.map(String), message: item.message })
	}
	return out
}

/** A validator's issue list as one line (`questions.q.criteria: <message>`); other text comes back unchanged. */
export function readableServiceText(text: string): string {
	const issues = schemaIssues(text)
	if (issues.length === 0) return text
	return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

/** True when a 400 names the question's `instructions` or `criteria` as what it refused. */
export function refusesQuestionField(error: unknown, fields: readonly string[]): boolean {
	if (!(error instanceof DecisionError) || error.status !== 400) return false
	const named = fields.join('|')
	if (schemaIssues(error.message).some((i) => i.path.some((part) => fields.includes(part)))) {
		return true
	}
	return new RegExp(
		`(missing|null|required).*(${named})|(${named}).*(missing|null|required)`,
		'i',
	).test(error.message)
}

/**
 * Post a yes/no question. With `criteria`, it goes in the form the service last took; when the
 * service answers 400 naming `criteria`, it is asked again in the next form (text, then the
 * published object, then folded into `instructions`), and the form that worked is remembered for
 * this address and model. Any other failure, and a refusal of the last form, is thrown as is.
 */
export async function postYesNo(opts: {
	post: (question: Question) => Promise<unknown>
	instructions: string
	criteria?: string
	/** Names the service and model the learnt form belongs to. */
	memoryKey: string
}): Promise<unknown> {
	const criteria = opts.criteria
	if (criteria === undefined || criteria.length === 0) {
		return opts.post(yesnoQuestion(opts.instructions))
	}
	const start = Math.max(0, CRITERIA_FORMS.indexOf(rememberedForms.get(opts.memoryKey) ?? 'text'))
	for (let i = start; ; i++) {
		const form = CRITERIA_FORMS[i] as YesNoCriteriaForm
		try {
			const answer = await opts.post(yesnoQuestionAs(form, opts.instructions, criteria))
			if (form !== 'text') rememberedForms.set(opts.memoryKey, form)
			return answer
		} catch (error) {
			if (i === CRITERIA_FORMS.length - 1 || !refusesQuestionField(error, ['criteria'])) throw error
		}
	}
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
