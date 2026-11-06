import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionModel } from '@namzu/decision'
import { describe, expect, it, vi } from 'vitest'

import { notifyWorthyQuestion } from '../notify.js'
import {
	CONFIDENT_NO,
	CONFIDENT_YES,
	type DecisionLogEntry,
	appendDecisionLog,
	createDecisionPoints,
	verdictOf,
} from '../points.js'

function modelAnswering(p: number | (() => Promise<{ p: number }>)): {
	model: DecisionModel
	yesno: ReturnType<typeof vi.fn>
} {
	const yesno = vi.fn(typeof p === 'number' ? async () => ({ p }) : p)
	return { model: { yesno } as unknown as DecisionModel, yesno }
}

const question = notifyWorthyQuestion({
	reply: 'Which of the two do you want?',
	turnMs: 4000,
	rule: false,
})

describe('a decision point', () => {
	it('asks nothing when it is off, which is every point until the operator names it', async () => {
		const { model, yesno } = modelAnswering(0.9)
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({ model, modes: undefined, log: (e) => entries.push(e) })
		expect(points.mode('notify')).toBe('off')
		expect(await points.ask(question)).toBeUndefined()
		expect(yesno).not.toHaveBeenCalled()
		expect(entries).toEqual([])
	})

	it('is off without a model, whatever the config says', async () => {
		const points = createDecisionPoints({ model: undefined, modes: { notify: 'on' } })
		expect(points.mode('notify')).toBe('off')
		expect(await points.ask(question)).toBeUndefined()
	})

	it('in shadow mode asks, records what it said beside the rule, and gives the caller nothing', async () => {
		const { model, yesno } = modelAnswering(0.9)
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({
			model,
			modes: { notify: 'shadow' },
			log: (e) => entries.push(e),
			now: () => 1000,
		})
		expect(await points.ask(question)).toBeUndefined()
		expect(yesno).toHaveBeenCalledTimes(1)
		expect(entries).toEqual([
			{
				at: 1000,
				point: 'notify',
				mode: 'shadow',
				p: 0.9,
				rule: false,
				latencyMs: 0,
				outcome: 'answered',
				chars: question.state.length,
			},
		])
	})

	it('in on mode hands the probability back', async () => {
		const { model } = modelAnswering(0.12)
		const points = createDecisionPoints({ model, modes: { notify: 'on' }, log: () => {} })
		expect(await points.ask(question)).toBe(0.12)
	})

	it('gives no answer, and records why, when the model is too slow, fails or answers nonsense', async () => {
		vi.useFakeTimers()
		try {
			const entries: DecisionLogEntry[] = []
			const slow = modelAnswering(() => new Promise(() => {}))
			const pending = createDecisionPoints({
				model: slow.model,
				modes: { notify: 'on' },
				timeoutMs: 200,
				log: (e) => entries.push(e),
			}).ask(question)
			await vi.advanceTimersByTimeAsync(250)
			expect(await pending).toBeUndefined()

			const broken = modelAnswering(async () => {
				throw new Error('503')
			})
			expect(
				await createDecisionPoints({
					model: broken.model,
					modes: { notify: 'on' },
					log: (e) => entries.push(e),
				}).ask(question),
			).toBeUndefined()

			const nonsense = modelAnswering(async () => ({ p: 7 }))
			expect(
				await createDecisionPoints({
					model: nonsense.model,
					modes: { notify: 'on' },
					log: (e) => entries.push(e),
				}).ask(question),
			).toBeUndefined()
			expect(entries.map((e) => e.outcome)).toEqual(['timeout', 'error', 'error'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('survives a log that cannot be written', async () => {
		const { model } = modelAnswering(0.9)
		const points = createDecisionPoints({
			model,
			modes: { notify: 'on' },
			log: () => {
				throw new Error('disk full')
			},
		})
		expect(await points.ask(question)).toBe(0.9)
	})
})

describe('the decision log', () => {
	it('holds sizes and probabilities, never the text the model was shown', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-decision-'))
		const secret = 'the password is hunter2'
		const q = notifyWorthyQuestion({ reply: secret, turnMs: 1000, rule: true })
		appendDecisionLog(
			{
				at: 1,
				point: 'notify',
				mode: 'shadow',
				p: 0.5,
				rule: q.rule,
				latencyMs: 3,
				outcome: 'answered',
				chars: q.state.length,
			},
			home,
		)
		const text = readFileSync(join(home, 'decision', 'points.jsonl'), 'utf8')
		expect(text).not.toContain('hunter2')
		expect(JSON.parse(text.trim())).toMatchObject({
			point: 'notify',
			mode: 'shadow',
			p: 0.5,
		})
	})
})

describe('verdictOf', () => {
	it('acts only on a confident answer', () => {
		expect(verdictOf(CONFIDENT_YES)).toBe('yes')
		expect(verdictOf(CONFIDENT_NO)).toBe('no')
		expect(verdictOf(0.5)).toBe('unsure')
		expect(verdictOf(undefined)).toBe('unsure')
	})
})

describe('the notify question', () => {
	it('shows the end of the reply, where a question sits, and drops control characters', () => {
		const long = `${'x'.repeat(5000)}\u0007\u001b[31mWhich one?`
		const q = notifyWorthyQuestion({ reply: long, turnMs: 12_300, rule: true })
		expect(q.state).toContain('Which one?')
		expect(q.state.includes('\u0007')).toBe(false)
		expect(q.state.includes('\u001b')).toBe(false)
		expect(q.state.length).toBeLessThan(1400)
		expect(q.state).toContain('[the turn took 12s]')
		expect(q.rule).toBe(true)
	})
})
