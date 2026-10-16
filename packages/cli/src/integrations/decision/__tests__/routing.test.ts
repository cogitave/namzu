import { DecisionError, type DecisionModel } from '@namzu/decision'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoutingConfig } from '../../../config/schema.js'
import {
	ROUTING_BIG_QUESTION,
	ROUTING_FAST_QUESTION,
	ROUTING_TASK_CHARS,
	resolveAutoDefault,
	routeModel,
} from '../routing.js'

const DEFAULT = { provider: 'anthropic', model: 'sonnet' }
const FAST = { provider: 'ollama', model: 'gemma3:1b' }
const BIG = { provider: 'anthropic', model: 'opus' }

const config: RoutingConfig = {
	default: DEFAULT,
	tiers: { fast: FAST, big: BIG },
}

/** A decision model answering the two routing questions from fixed numbers. */
function yesnoModel(pFast: number, pBig: number): DecisionModel {
	return {
		yesno: vi.fn(async (_state: string, question: string) => ({
			p: question === ROUTING_FAST_QUESTION ? pFast : pBig,
		})),
		choice: vi.fn(),
		score: vi.fn(),
	} as unknown as DecisionModel
}

function scoreModel(probabilities: number[]): DecisionModel {
	return {
		yesno: vi.fn(),
		choice: vi.fn(),
		score: vi.fn(async () => ({ level: 0, probabilities })),
	} as unknown as DecisionModel
}

function failingModel(error: unknown): DecisionModel {
	return {
		yesno: vi.fn(async () => {
			throw error
		}),
		choice: vi.fn(),
		score: vi.fn(async () => {
			throw error
		}),
	} as unknown as DecisionModel
}

const task = 'rename this variable'

describe('routeModel tier selection (yesno)', () => {
	it('sends a simple task to the fast tier', async () => {
		const r = await routeModel({ task, config }, { model: yesnoModel(0.9, 0.1) })
		expect(r).toMatchObject({ tier: 'fast', ...FAST, confidence: 0.9, reason: 'simple-task' })
	})

	it('sends a demanding task to the big tier', async () => {
		const r = await routeModel({ task, config }, { model: yesnoModel(0.1, 0.85) })
		expect(r).toMatchObject({ tier: 'big', ...BIG, confidence: 0.85 })
	})

	it('keeps an ordinary task on the default', async () => {
		const r = await routeModel({ task, config }, { model: yesnoModel(0.5, 0.5) })
		expect(r).toMatchObject({ tier: 'default', ...DEFAULT, reason: 'ordinary-task' })
		expect(r.confidence).toBeCloseTo(0.5)
	})

	it('treats the threshold as inclusive and honours configured thresholds', async () => {
		const tight: RoutingConfig = { ...config, thresholds: { fast: 0.95, big: 0.95 } }
		expect((await routeModel({ task, config: tight }, { model: yesnoModel(0.9, 0.1) })).tier).toBe(
			'default',
		)
		expect((await routeModel({ task, config }, { model: yesnoModel(0.7, 0.1) })).tier).toBe('fast')
	})

	it('falls to the default when the answers contradict each other', async () => {
		const r = await routeModel({ task, config }, { model: yesnoModel(0.9, 0.9) })
		expect(r).toMatchObject({ tier: 'default', reason: 'contradictory-decision' })
	})

	it('asks only the questions a configured tier needs', async () => {
		const model = yesnoModel(0.9, 0.9)
		await routeModel({ task, config: { default: DEFAULT, tiers: { fast: FAST } } }, { model })
		expect(model.yesno).toHaveBeenCalledTimes(1)
		expect(model.yesno).toHaveBeenCalledWith(task, ROUTING_FAST_QUESTION, expect.anything())
		const bigOnly = yesnoModel(0.9, 0.9)
		await routeModel(
			{ task, config: { default: DEFAULT, tiers: { big: BIG } } },
			{ model: bigOnly },
		)
		expect(bigOnly.yesno).toHaveBeenCalledTimes(1)
		expect(bigOnly.yesno).toHaveBeenCalledWith(task, ROUTING_BIG_QUESTION, expect.anything())
	})

	it('truncates the task text sent to the decision model', async () => {
		const model = yesnoModel(0.1, 0.1)
		await routeModel({ task: 'x'.repeat(ROUTING_TASK_CHARS * 3), config }, { model })
		const state = (model.yesno as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
		expect(state.length).toBe(ROUTING_TASK_CHARS)
	})

	it('logs one debug line with the reason', async () => {
		const debug = vi.fn()
		await routeModel({ task, config }, { model: yesnoModel(0.9, 0.1), logger: { debug } })
		expect(debug).toHaveBeenCalledTimes(1)
		expect(debug).toHaveBeenCalledWith(
			'auto model routed',
			expect.objectContaining({
				'namzu.routing.tier': 'fast',
				'namzu.routing.reason': 'simple-task',
			}),
		)
	})
})

describe('routeModel (score)', () => {
	const scored: RoutingConfig = { ...config, strategy: 'score' }

	it('maps trivial and small mass to fast', async () => {
		const r = await routeModel(
			{ task, config: scored },
			{ model: scoreModel([0.5, 0.3, 0.1, 0.1]) },
		)
		expect(r).toMatchObject({ tier: 'fast', ...FAST })
		expect(r.confidence).toBeCloseTo(0.8)
	})

	it('maps large mass to big', async () => {
		const r = await routeModel(
			{ task, config: scored },
			{ model: scoreModel([0.05, 0.05, 0.1, 0.8]) },
		)
		expect(r).toMatchObject({ tier: 'big', ...BIG })
	})

	it('keeps medium work on the default', async () => {
		const r = await routeModel(
			{ task, config: scored },
			{ model: scoreModel([0.1, 0.1, 0.6, 0.2]) },
		)
		expect(r.tier).toBe('default')
	})

	it('treats the wrong number of levels or a bad probability as malformed', async () => {
		for (const bad of [
			[0.5, 0.5],
			[0.5, Number.NaN, 0.2, 0.3],
			[0, 0, 0, 0],
			[-1, 1, 1, 1],
		]) {
			const r = await routeModel({ task, config: scored }, { model: scoreModel(bad) })
			expect(r).toMatchObject({ tier: 'default', ...DEFAULT, reason: 'malformed-decision' })
		}
	})
})

describe('routeModel fail-open: only ever the default', () => {
	it('has no decision model', async () => {
		expect(await routeModel({ task, config }, {})).toMatchObject({
			tier: 'default',
			...DEFAULT,
			confidence: 0,
			reason: 'no-decision-model',
		})
	})

	it('survives a DecisionError and any other throw', async () => {
		for (const error of [new DecisionError('boom', 500), new Error('network'), 'a string']) {
			const r = await routeModel({ task, config }, { model: failingModel(error) })
			expect(r).toMatchObject({ tier: 'default', ...DEFAULT, reason: 'decision-unavailable' })
		}
	})

	it('survives a malformed or NaN probability', async () => {
		for (const p of [Number.NaN, 2, -0.1, Number.POSITIVE_INFINITY]) {
			const r = await routeModel({ task, config }, { model: yesnoModel(p, 0.1) })
			expect(r).toMatchObject({ tier: 'default', reason: 'malformed-decision' })
		}
		const missing = {
			yesno: vi.fn(async () => ({})),
		} as unknown as DecisionModel
		expect((await routeModel({ task, config }, { model: missing })).tier).toBe('default')
	})

	it('never lets a half-answered decision pick a tier', async () => {
		let calls = 0
		const model = {
			yesno: vi.fn(async () => {
				calls += 1
				if (calls === 2) throw new DecisionError('second call failed')
				return { p: 0.99 }
			}),
		} as unknown as DecisionModel
		expect((await routeModel({ task, config }, { model })).tier).toBe('default')
	})

	it('survives a logger that throws', async () => {
		const logger = {
			debug: () => {
				throw new Error('sink closed')
			},
		}
		const r = await routeModel({ task, config }, { model: yesnoModel(0.9, 0.1), logger })
		expect(r.tier).toBe('fast')
	})

	it('goes to the default without a model call when no tier is usable here', async () => {
		const model = yesnoModel(0.9, 0.9)
		const r = await routeModel({ task, config }, { model, isAvailable: () => false })
		expect(r).toMatchObject({ tier: 'default', reason: 'no-tier-available' })
		expect(model.yesno).not.toHaveBeenCalled()
	})

	it('drops only the tier whose provider is missing', async () => {
		const model = yesnoModel(0.9, 0.9)
		const r = await routeModel(
			{ task, config },
			{ model, isAvailable: (t) => t.provider !== 'ollama' },
		)
		expect(r).toMatchObject({ tier: 'big', ...BIG })
	})

	it('has no tiers configured', async () => {
		const model = yesnoModel(0.9, 0.9)
		const r = await routeModel({ task, config: { default: DEFAULT } }, { model })
		expect(r.tier).toBe('default')
		expect(model.yesno).not.toHaveBeenCalled()
	})

	it('is aborted by the caller before and during the call', async () => {
		const early = new AbortController()
		early.abort()
		const never = { yesno: vi.fn(() => new Promise(() => {})) } as unknown as DecisionModel
		expect(
			await routeModel({ task, config, signal: early.signal }, { model: never }),
		).toMatchObject({
			tier: 'default',
			reason: 'aborted',
		})
		const late = new AbortController()
		const pending = routeModel({ task, config, signal: late.signal }, { model: never })
		late.abort()
		expect(await pending).toMatchObject({ tier: 'default', reason: 'aborted' })
	})
})

describe('routeModel timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('runs the default once timeoutMs passes, whatever the model is doing', async () => {
		const model = { yesno: vi.fn(() => new Promise(() => {})) } as unknown as DecisionModel
		const pending = routeModel({ task, config: { ...config, timeoutMs: 250 } }, { model })
		await vi.advanceTimersByTimeAsync(249)
		let settled = false
		void pending.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toMatchObject({ tier: 'default', ...DEFAULT, reason: 'timeout' })
	})

	it('aborts the signal it handed the model', async () => {
		let seen: AbortSignal | undefined
		const model = {
			yesno: vi.fn((_s: string, _q: string, opts?: { signal?: AbortSignal }) => {
				seen = opts?.signal
				return new Promise(() => {})
			}),
		} as unknown as DecisionModel
		const pending = routeModel({ task, config }, { model })
		await vi.advanceTimersByTimeAsync(400)
		await pending
		expect(seen?.aborted).toBe(true)
	})

	it('leaves no timer behind when the model answers in time', async () => {
		const answered = await routeModel({ task, config }, { model: yesnoModel(0.9, 0.1) })
		expect(answered.tier).toBe('fast')
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('routeModel heuristic overrides', () => {
	it('an explicit pin wins with no model call', async () => {
		const model = yesnoModel(0.9, 0.9)
		const pin = { provider: 'openai', model: 'gpt-x' }
		const r = await routeModel({ task, config, pin }, { model })
		expect(r).toMatchObject({ provider: 'openai', model: 'gpt-x', reason: 'pinned' })
		expect(model.yesno).not.toHaveBeenCalled()
	})

	it.each([
		['computer use', { usesComputerUse: true }],
		['a Pal', { usesPal: true }],
		['attachments', { attachmentCount: 2 }],
		['a long conversation', { conversationLength: 200 }],
	])('never sends a task needing %s to the fast tier', async (_name, features) => {
		const r = await routeModel({ task, config, features }, { model: yesnoModel(0.99, 0.1) })
		expect(r.tier).toBe('default')
	})

	it('does not even ask the fast question when fast is barred', async () => {
		const model = yesnoModel(0.99, 0.1)
		await routeModel({ task, config, features: { usesPal: true } }, { model })
		expect(model.yesno).toHaveBeenCalledTimes(1)
		expect(model.yesno).toHaveBeenCalledWith(
			expect.any(String),
			ROUTING_BIG_QUESTION,
			expect.anything(),
		)
	})

	it('can still choose big when the fast tier is barred', async () => {
		const r = await routeModel(
			{ task, config, features: { usesComputerUse: true } },
			{ model: yesnoModel(0.1, 0.9) },
		)
		expect(r.tier).toBe('big')
	})

	it('escalates one tier after a failure on fast, with no model call', async () => {
		const model = yesnoModel(0.99, 0.1)
		const r = await routeModel(
			{ task, config, features: { previousTurnFailedOnTier: 'fast' } },
			{ model },
		)
		expect(r).toMatchObject({ tier: 'default', reason: 'escalated-after-failure' })
		expect(model.yesno).not.toHaveBeenCalled()
	})

	it('escalates from default to big after a failure, or stays on default without one', async () => {
		const features = { previousTurnFailedOnTier: 'default' as const }
		expect((await routeModel({ task, config, features }, {})).tier).toBe('big')
		expect(
			(
				await routeModel(
					{ task, config: { default: DEFAULT, tiers: { fast: FAST } }, features },
					{},
				)
			).tier,
		).toBe('default')
	})
})

describe('resolveAutoDefault', () => {
	it('returns the default when its provider is usable, else nothing', () => {
		expect(resolveAutoDefault(config, () => true)).toEqual(DEFAULT)
		expect(resolveAutoDefault(config, () => false)).toBeUndefined()
	})
})
