import { describe, expect, it } from 'vitest'

import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import { runExperiment } from '../experiment.js'
import { judgeScorer } from '../judge.js'
import type { EvalCase, EvalRun } from '../types.js'

/**
 * Every other scorer is a pure function over the run, which is what makes
 * them reproducible and what makes them unable to say whether an answer is
 * GOOD. A judge closes that, and brings a failure mode none of the others
 * have: it can fail to answer at all. A failed measurement scored zero
 * reads exactly like a regression, so the distinction is what most of this
 * file is about.
 */

function fakeProvider(reply: string | (() => never), tokens = 42): LLMProvider {
	const seen: ChatCompletionParams[] = []
	const provider: LLMProvider & { seen: ChatCompletionParams[] } = {
		id: 'fake',
		name: 'fake',
		capabilities: {
			supportsTools: false,
			supportsStreaming: true,
			supportsFunctionCalling: false,
		},
		seen,
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			seen.push(params)
			if (typeof reply !== 'string') reply()
			yield { id: 'j', delta: { content: reply as string } }
			yield {
				id: 'j',
				delta: {},
				finishReason: 'stop',
				usage: {
					promptTokens: tokens,
					completionTokens: 0,
					totalTokens: tokens,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
			}
		},
		async listModels() {
			return []
		},
		async healthCheck() {
			return true
		},
	}
	return provider
}

const RUN: EvalRun = {
	output: 'The capital of France is Paris.',
	steps: [],
	toolCalls: ['search'],
	stopReason: 'end_turn',
	totalTokens: 100,
	totalCostUsd: 0,
	durationMs: 10,
}

const CASE: EvalCase = { name: 'capital', input: 'What is the capital of France?' }

const RUBRIC = 'The answer names the correct city.'

describe('grading', () => {
	it('normalises the grade onto 0..1 against the scale it asked for', async () => {
		const scorer = judgeScorer({
			provider: fakeProvider('{"grade": 3, "reason": "names the right city"}'),
			model: 'm',
			rubric: RUBRIC,
			scale: 4,
		})
		const score = await scorer.score(RUN, CASE)

		expect(score.score).toBe(0.75)
		expect(score.reason).toBe('names the right city')
		expect(score.details?.grade).toBe(3)
	})

	it('reads a verdict wrapped in prose or fences', async () => {
		const scorer = judgeScorer({
			provider: fakeProvider('Here is my grade:\n```json\n{"grade": 4, "reason": "correct"}\n```'),
			model: 'm',
			rubric: RUBRIC,
		})
		expect((await scorer.score(RUN, CASE)).score).toBe(1)
	})

	it('handles a brace inside the reason string', async () => {
		const scorer = judgeScorer({
			provider: fakeProvider('{"grade": 2, "reason": "mentions {city} placeholder"}'),
			model: 'm',
			rubric: RUBRIC,
			scale: 4,
		})
		// A naive scan to the first `}` would cut the object in half here.
		expect((await scorer.score(RUN, CASE)).score).toBe(0.5)
	})

	it('carries what the judging itself cost', async () => {
		const scorer = judgeScorer({
			provider: fakeProvider('{"grade": 4, "reason": "ok"}', 1234),
			model: 'm',
			rubric: RUBRIC,
		})
		// A judge is the most expensive scorer there is; a bill nobody can
		// attribute is a bill nobody controls.
		expect((await scorer.score(RUN, CASE)).details?.judgeTokens).toBe(1234)
	})

	it('grades the same run the same way twice', async () => {
		const provider = fakeProvider('{"grade": 4, "reason": "ok"}') as LLMProvider & {
			seen: ChatCompletionParams[]
		}
		await judgeScorer({ provider, model: 'm', rubric: RUBRIC }).score(RUN, CASE)
		// Sampling noise is indistinguishable from a regression, so the
		// judge does not sample.
		expect(provider.seen[0]?.temperature).toBe(0)
	})
})

describe('what the judge is shown', () => {
	const promptOf = (provider: LLMProvider) =>
		String((provider as unknown as { seen: ChatCompletionParams[] }).seen[0]?.messages[0]?.content)

	it('shows the rubric, the task and the answer', async () => {
		const provider = fakeProvider('{"grade": 4, "reason": "ok"}')
		await judgeScorer({ provider, model: 'm', rubric: RUBRIC }).score(RUN, CASE)

		const prompt = promptOf(provider)
		expect(prompt).toContain(RUBRIC)
		expect(prompt).toContain('What is the capital of France?')
		expect(prompt).toContain('The capital of France is Paris.')
	})

	it('withholds the trajectory unless asked', async () => {
		const off = fakeProvider('{"grade": 4, "reason": "ok"}')
		await judgeScorer({ provider: off, model: 'm', rubric: RUBRIC }).score(RUN, CASE)
		expect(promptOf(off)).not.toContain('TOOLS CALLED')

		const on = fakeProvider('{"grade": 4, "reason": "ok"}')
		await judgeScorer({
			provider: on,
			model: 'm',
			rubric: RUBRIC,
			includeTrajectory: true,
		}).score(RUN, CASE)
		expect(promptOf(on)).toContain('search')
	})

	it('says when it truncated the answer', async () => {
		const provider = fakeProvider('{"grade": 4, "reason": "ok"}')
		await judgeScorer({
			provider,
			model: 'm',
			rubric: RUBRIC,
			maxOutputChars: 10,
		}).score({ ...RUN, output: 'x'.repeat(500) }, CASE)

		// A judge shown a silently cut answer marks it down for stopping
		// mid-sentence, which scores our truncation rather than the run.
		expect(promptOf(provider)).toContain('cut at 10 characters by the harness')
	})

	it('offers the reference answer when the case has one', async () => {
		const provider = fakeProvider('{"grade": 4, "reason": "ok"}')
		await judgeScorer({ provider, model: 'm', rubric: RUBRIC }).score(RUN, {
			...CASE,
			expected: 'Paris',
		})
		expect(promptOf(provider)).toContain('Paris')
	})
})

describe('a judge that cannot judge', () => {
	const failing = (reply: string) =>
		judgeScorer({ provider: fakeProvider(reply), model: 'm', rubric: RUBRIC, scale: 4 })

	it('throws on a reply with no JSON at all', async () => {
		await expect(failing('I think it was pretty good!').score(RUN, CASE)).rejects.toThrow(/no JSON/)
	})

	it('throws on a grade outside the scale it was given', async () => {
		// Clamping would turn a judge that misread the scale into a
		// confident score, and a judge that misread the scale did not apply
		// the rubric either.
		await expect(failing('{"grade": 9, "reason": "great"}').score(RUN, CASE)).rejects.toThrow(
			/outside the 0\.\.4 scale/,
		)
	})

	it('throws on a non-numeric grade', async () => {
		await expect(failing('{"grade": "good", "reason": "x"}').score(RUN, CASE)).rejects.toThrow(
			/no numeric grade/,
		)
	})

	it('throws on an unterminated object', async () => {
		await expect(failing('{"grade": 3, "reason": "cut off').score(RUN, CASE)).rejects.toThrow(
			/unterminated/,
		)
	})

	it('refuses to exist without a rubric', () => {
		expect(() => judgeScorer({ provider: fakeProvider('{}'), model: 'm', rubric: '   ' })).toThrow(
			/rubric is required/,
		)
	})

	it('refuses a nonsense scale', () => {
		expect(() =>
			judgeScorer({ provider: fakeProvider('{}'), model: 'm', rubric: RUBRIC, scale: 0 }),
		).toThrow(/positive integer/)
	})

	it('refuses a nonsense stream idle bound before starting a judge request', () => {
		expect(() =>
			judgeScorer({
				provider: fakeProvider('{}'),
				model: 'm',
				rubric: RUBRIC,
				streamIdleTimeoutMs: -1,
			}),
		).toThrow(/streamIdleTimeoutMs must be an integer/)
	})
})

describe('a broken judge is not a bad run', () => {
	const dataset = {
		name: 'suite',
		cases: [CASE],
		run: async (): Promise<EvalRun> => RUN,
	}

	it('reports the case as inconclusive rather than failed', async () => {
		const report = await runExperiment({
			...dataset,
			scorers: [
				judgeScorer({
					provider: fakeProvider(() => {
						throw new Error('429 rate limited')
					}),
					model: 'm',
					rubric: RUBRIC,
				}),
			],
		})

		expect(report.inconclusive).toBe(1)
		expect(report.failed).toBe(0)
		expect(report.passed).toBe(0)
		expect(report.cases[0]?.scores.judge?.unavailable).toBe(true)
		expect(report.cases[0]?.scores.judge?.reason).toContain('429')
	})

	it('keeps an unavailable score out of the mean entirely', async () => {
		const report = await runExperiment({
			...dataset,
			scorers: [
				{ name: 'always-one', score: () => ({ score: 1, reason: 'fine' }) },
				judgeScorer({
					provider: fakeProvider(() => {
						throw new Error('down')
					}),
					model: 'm',
					rubric: RUBRIC,
				}),
			],
		})

		// Not 0.5. A measurement that never happened is not a zero, and
		// averaging it in would report a regression the harness caused.
		expect(report.cases[0]?.mean).toBe(1)
		expect(report.cases[0]?.status).toBe('passed')
		expect(report.mean).toBe(1)
	})

	it('omits a scorer that was never available from the per-dimension means', async () => {
		const report = await runExperiment({
			...dataset,
			scorers: [
				judgeScorer({
					provider: fakeProvider(() => {
						throw new Error('down')
					}),
					model: 'm',
					rubric: RUBRIC,
				}),
			],
		})

		// A dimension with no measurements is not a dimension that scored 0.
		expect(report.byScorer.judge).toBeUndefined()
	})

	it('still fails a case the judge actually judged badly', async () => {
		const report = await runExperiment({
			...dataset,
			scorers: [
				judgeScorer({
					provider: fakeProvider('{"grade": 0, "reason": "names the wrong city"}'),
					model: 'm',
					rubric: RUBRIC,
				}),
			],
		})

		expect(report.failed).toBe(1)
		expect(report.inconclusive).toBe(0)
		expect(report.cases[0]?.scores.judge?.unavailable).toBeUndefined()
	})
})
