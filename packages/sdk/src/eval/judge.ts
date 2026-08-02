import { collect } from '../provider/collect.js'
import type { LLMProvider } from '../types/provider/interface.js'
import type { EvalCase, EvalRun, Score, Scorer } from './types.js'

/**
 * Grade an open-ended answer with a model.
 *
 * Every other scorer here is a pure function over the run, which is what
 * makes them cheap and reproducible — and also what makes them unable to
 * say anything about whether an answer is *good*. `containsScorer` can
 * check that a required phrase appears; it cannot tell a correct
 * explanation from a fluent wrong one. That was the hole: the dimension
 * most worth guarding was the one with no scorer behind it.
 *
 * A judge is a network call, so this scorer can fail in ways a pure
 * function cannot. It throws rather than returning a low score, and the
 * harness files a throw as `unavailable` — a rate limit must not read as
 * a regression. See `Score.unavailable`.
 */
export interface JudgeScorerConfig {
	/** Defaults to `'judge'`. Give it a distinct name to run several. */
	name?: string
	provider: LLMProvider
	model: string
	/**
	 * What "good" means, in the caller's words. REQUIRED.
	 *
	 * A judge asked to rate quality with no rubric rates fluency, which
	 * correlates with almost nothing worth measuring and drifts whenever
	 * the judge model changes. Making this optional would make the scorer
	 * easy to use and its output meaningless, so it is not optional.
	 */
	rubric: string
	/**
	 * Highest grade on the scale. Default 4.
	 *
	 * An integer scale, not a 0..1 float: models place a continuous score
	 * poorly and cluster on round numbers, while a short ordinal scale
	 * against a written rubric is a judgement they can actually make. The
	 * result is divided down to 0..1 for the report.
	 *
	 * The default is EVEN on purpose — an odd scale has a midpoint, and a
	 * midpoint is where an uncertain judge parks. Forcing a side produces a
	 * signal; a pile of 3-out-of-5s does not.
	 */
	scale?: number
	/**
	 * Show the judge which tools the run called. Default false.
	 *
	 * Useful when the rubric is about method rather than answer, and a
	 * needless cost otherwise — the trajectory is usually longer than the
	 * answer it produced.
	 */
	includeTrajectory?: boolean
	/**
	 * Cap on the answer text handed to the judge. Default 20000.
	 *
	 * Truncation is disclosed IN the prompt. A judge shown a silently cut
	 * answer marks it down for stopping mid-sentence, which scores our
	 * truncation rather than the run.
	 */
	maxOutputChars?: number
}

const DEFAULT_SCALE = 4
const DEFAULT_MAX_OUTPUT_CHARS = 20_000

interface Verdict {
	grade: number
	reason: string
}

/**
 * Pull the verdict out of the reply.
 *
 * Models wrap JSON in prose or fences however firmly asked not to, so the
 * first balanced object is extracted rather than the whole reply parsed.
 * What is NOT tolerated is a missing or out-of-range grade: that is an
 * unusable measurement, and the caller has to hear about it rather than
 * receive a number invented from a fallback.
 */
function parseVerdict(reply: string, scale: number): Verdict {
	const start = reply.indexOf('{')
	if (start === -1) throw new Error(`judge returned no JSON object: ${reply.slice(0, 200)}`)

	let depth = 0
	let inString = false
	let escaped = false
	let end = -1
	for (let i = start; i < reply.length; i++) {
		const ch = reply[i]
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === '\\') {
			escaped = true
			continue
		}
		if (ch === '"') {
			inString = !inString
			continue
		}
		if (inString) continue
		if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) {
				end = i
				break
			}
		}
	}
	if (end === -1)
		throw new Error(`judge returned an unterminated JSON object: ${reply.slice(0, 200)}`)

	let parsed: unknown
	try {
		parsed = JSON.parse(reply.slice(start, end + 1))
	} catch (err) {
		throw new Error(
			`judge returned unparsable JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	const grade = (parsed as { grade?: unknown }).grade
	if (typeof grade !== 'number' || !Number.isFinite(grade)) {
		throw new Error(`judge returned no numeric grade: ${JSON.stringify(parsed).slice(0, 200)}`)
	}
	if (grade < 0 || grade > scale) {
		// Clamping instead would quietly turn a judge that misread the scale
		// into a confident score, and a judge that misread the scale did not
		// apply the rubric either.
		throw new Error(`judge returned ${grade}, outside the 0..${scale} scale it was given`)
	}

	const reason = (parsed as { reason?: unknown }).reason
	return {
		grade,
		reason: typeof reason === 'string' && reason.length > 0 ? reason : '(judge gave no reason)',
	}
}

function buildPrompt(
	config: JudgeScorerConfig,
	run: EvalRun,
	evalCase: EvalCase,
	scale: number,
): string {
	const limit = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
	const answer = run.output ?? ''
	const truncated = answer.length > limit

	const sections: string[] = [
		'Grade the ANSWER against the RUBRIC.',
		'',
		`RUBRIC:\n${config.rubric}`,
		'',
		`TASK:\n${typeof evalCase.input === 'string' ? evalCase.input : JSON.stringify(evalCase.input)}`,
	]

	if (evalCase.expected !== undefined) {
		sections.push(
			'',
			`REFERENCE (one good answer, not the only one):\n${
				typeof evalCase.expected === 'string'
					? evalCase.expected
					: JSON.stringify(evalCase.expected)
			}`,
		)
	}

	if (config.includeTrajectory === true) {
		sections.push(
			'',
			`TOOLS CALLED, in order:\n${run.toolCalls.length > 0 ? run.toolCalls.join(' -> ') : '(none)'}`,
		)
	}

	sections.push('', `ANSWER:\n${truncated ? answer.slice(0, limit) : answer}`)
	if (truncated) {
		// Disclosed, so the judge does not mark the answer down for an
		// ending we removed.
		sections.push(
			'',
			`(The answer above was cut at ${limit} characters by the harness, not by the agent. Do not penalise it for ending abruptly.)`,
		)
	}

	sections.push(
		'',
		`Reply with JSON and nothing else: {"grade": <integer 0..${scale}>, "reason": "<one or two sentences>"}.`,
		`0 means the rubric is not met at all; ${scale} means it is fully met. Judge only against the rubric.`,
	)

	return sections.join('\n')
}

export function judgeScorer(config: JudgeScorerConfig): Scorer {
	const scale = config.scale ?? DEFAULT_SCALE
	if (!Number.isInteger(scale) || scale < 1) {
		throw new Error(`judgeScorer: scale must be a positive integer, got ${scale}`)
	}
	if (config.rubric.trim().length === 0) {
		throw new Error(
			'judgeScorer: a rubric is required. A judge with no rubric rates fluency, which is not what anyone means to measure.',
		)
	}

	return {
		name: config.name ?? 'judge',
		async score(run: EvalRun, evalCase: EvalCase): Promise<Score> {
			const response = await collect(
				config.provider.chatStream({
					model: config.model,
					messages: [{ role: 'user', content: buildPrompt(config, run, evalCase, scale) }],
					// The same run must grade the same way twice, or a
					// regression cannot be told from sampling noise.
					temperature: 0,
					maxTokens: 512,
				}),
			)

			const verdict = parseVerdict(response.message.content ?? '', scale)
			return {
				score: verdict.grade / scale,
				reason: verdict.reason,
				details: {
					grade: verdict.grade,
					scale,
					// Carried so a suite can account for what the judging
					// itself cost. A judge is the most expensive scorer there
					// is, and a bill nobody can attribute is a bill nobody
					// controls.
					judgeTokens: response.usage.totalTokens,
				},
			}
		},
	}
}
