import { describe, expect, it, vi } from 'vitest'

import type { ChatCompletionParams, StreamChunk } from '../../types/provider/index.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import { runExperiment } from '../experiment.js'
import { judgeScorer } from '../judge.js'
import type { EvalRun } from '../types.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const completedRun = (): EvalRun => ({
	output: 'Paris',
	steps: [],
	toolCalls: [],
	stopReason: 'end_turn',
	totalTokens: 1,
	totalCostUsd: 0,
	durationMs: 0,
})

describe('the case deadline includes scoring', () => {
	it('detaches a hostile judge, aborts its transport, and continues with the next case', async () => {
		const firstStarted = deferred<void>()
		const releaseFirst = deferred<void>()
		const transportSignals: Array<AbortSignal | undefined> = []
		let judgeCalls = 0
		const provider: LLMProvider = {
			id: 'held-judge',
			name: 'Held judge',
			capabilities: {
				supportsTools: false,
				supportsStreaming: true,
				supportsFunctionCalling: false,
			},
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const call = judgeCalls++
				transportSignals.push(params.signal)
				if (call === 0) {
					firstStarted.resolve()
					// Deliberately ignore abort. The harness must settle from its
					// own race while still carrying the signal to this transport.
					await releaseFirst.promise
				}
				yield { id: `judge-${call}`, delta: { content: '{"grade": 4, "reason": "correct"}' } }
				yield {
					id: `judge-${call}`,
					delta: {},
					finishReason: 'stop',
					usage: {
						promptTokens: 1,
						completionTokens: 1,
						totalTokens: 2,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				}
			},
		}
		const runSignals: AbortSignal[] = []
		const running = runExperiment({
			name: 'judge deadline',
			cases: [
				{ name: 'stalled judge', input: 'first' },
				{ name: 'later case', input: 'second' },
			],
			scorers: [
				judgeScorer({
					provider,
					model: 'judge-model',
					rubric: 'Award full credit when the answer is Paris.',
				}),
			],
			timeoutMs: 20,
			run: async (_input, _case, signal) => {
				runSignals.push(signal)
				return completedRun()
			},
		})
		let settled = false
		void running.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await firstStarted.promise
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 10 })
		} catch (err) {
			waitFailure = err
		} finally {
			// Mutations that clear the timer after `run`, omit the scorer race,
			// or leave the judge raw must fail an assertion without leaving the
			// deliberately hostile generator behind in the test process.
			releaseFirst.resolve()
		}

		const report = await running
		if (waitFailure) throw waitFailure
		expect(runSignals).toHaveLength(2)
		expect(transportSignals).toHaveLength(2)
		// The idle wrapper owns a private transport controller; cancellation
		// flows into it without giving the judge ownership of the case's
		// controller or changing the first cause.
		expect(transportSignals[0]).not.toBe(runSignals[0])
		expect(transportSignals[0]?.aborted).toBe(true)
		expect(transportSignals[0]?.reason).toBe(runSignals[0]?.reason)
		expect(runSignals[0]?.reason).toMatchObject({
			message: 'case timed out after 20ms',
		})
		expect(transportSignals[1]).not.toBe(runSignals[1])
		expect(transportSignals[1]?.aborted).toBe(false)
		expect(report.cases).toHaveLength(2)
		expect(report.cases[0]).toMatchObject({
			case: 'stalled judge',
			status: 'inconclusive',
			passed: false,
		})
		expect(report.cases[0]?.scores.judge).toMatchObject({
			score: 0,
			unavailable: true,
		})
		expect(report.cases[0]?.scores.judge?.reason).toContain('case timed out after 20ms')
		expect(report.cases[1]).toMatchObject({
			case: 'later case',
			status: 'passed',
			passed: true,
		})
		expect(report.inconclusive).toBe(1)
		expect(report.passed).toBe(1)
		expect(report.failed).toBe(0)
	})

	it('also bounds a judge called directly without an experiment signal', async () => {
		const started = deferred<void>()
		const release = deferred<void>()
		let transportSignal: AbortSignal | undefined
		const provider: LLMProvider = {
			id: 'direct-held-judge',
			name: 'Direct held judge',
			capabilities: {
				supportsTools: false,
				supportsStreaming: true,
				supportsFunctionCalling: false,
			},
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				transportSignal = params.signal
				started.resolve()
				// Ignore the wrapper-owned transport abort. Its independent race
				// must still reject the public direct call.
				await release.promise
				yield { id: 'late', delta: { content: '{"grade": 4, "reason": "late"}' } }
			},
		}
		const scorer = judgeScorer({
			provider,
			model: 'judge-model',
			rubric: 'Award full credit when the answer is Paris.',
			streamIdleTimeoutMs: 20,
		})
		const judging = scorer.score(completedRun(), { name: 'direct', input: 'capital?' })
		let outcome: { score: unknown } | { error: unknown } | undefined
		void Promise.resolve(judging).then(
			(score) => {
				outcome = { score }
			},
			(error: unknown) => {
				outcome = { error }
			},
		)

		await started.promise
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 1_000, interval: 10 })
		} catch (err) {
			waitFailure = err
		} finally {
			// A mutation that calls the raw provider must fail promptly and
			// still release its deliberately hostile iterator afterwards.
			release.resolve()
		}

		await Promise.resolve(judging).catch(() => {})
		if (waitFailure) throw waitFailure
		expect(outcome).toMatchObject({
			error: {
				kind: 'network',
				providerId: 'direct-held-judge',
			},
		})
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(outcome && 'error' in outcome ? outcome.error : undefined)
		expect((outcome && 'error' in outcome ? outcome.error : undefined) as Error).toMatchObject({
			message: expect.stringContaining('stream idle for 20ms'),
		})
	})
})
