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

describe('a decision point asked to choose', () => {
	const options = ['e1 Button "Save"', 'e2 Button "Cancel"', 'e3 Edit "Name"']
	function chooser(probabilities: Record<string, number> | (() => Promise<never>)) {
		const choice = vi.fn(
			typeof probabilities === 'function'
				? probabilities
				: async () => ({ option: options[0], probabilities }),
		)
		return { model: { choice } as unknown as DecisionModel, choice }
	}
	const ask = (chosen?: string) => ({
		point: 'pick' as const,
		state: 'Described action: save the file',
		instructions: 'Choose.',
		options,
		...(chosen ? { chosen } : {}),
	})

	it('asks nothing when it is off', async () => {
		const { model, choice } = chooser({ [options[0]]: 1 })
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({
			model,
			modes: undefined,
			log: (e) => entries.push(e),
		})
		expect(await points.choose(ask())).toBeUndefined()
		expect(choice).not.toHaveBeenCalled()
		expect(entries).toEqual([])
	})

	it('in shadow mode logs how likely the model thought the option already chosen, and whether it agreed', async () => {
		const { model } = chooser({
			[options[0]]: 0.1,
			[options[1]]: 0.8,
			[options[2]]: 0.1,
		})
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({
			model,
			modes: { pick: 'shadow' },
			log: (e) => entries.push(e),
			now: () => 5,
		})
		expect(await points.choose(ask(options[0]))).toBeUndefined()
		expect(entries).toEqual([
			{
				at: 5,
				point: 'pick',
				mode: 'shadow',
				p: 0.1,
				rule: true,
				latencyMs: 0,
				outcome: 'answered',
				chars: 'Described action: save the file'.length,
				options: 3,
				agreed: false,
			},
		])
	})

	it('in on mode hands back the options best first', async () => {
		const { model } = chooser({
			[options[0]]: 0.1,
			[options[1]]: 0.8,
			[options[2]]: 0.1,
		})
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({
			model,
			modes: { pick: 'on' },
			log: (e) => entries.push(e),
		})
		const ranking = await points.choose(ask())
		expect(ranking?.ranked[0]).toEqual({ option: options[1], p: 0.8 })
		expect(ranking?.ranked).toHaveLength(3)
		// Nothing chose before the model, so there is nothing to compare with.
		expect(entries[0]).toMatchObject({ p: 0.8, rule: false })
		expect(entries[0]).not.toHaveProperty('agreed')
	})

	it('gives no answer when the options are too few or too many, or the model fails', async () => {
		const failing = chooser(async () => {
			throw new Error('503')
		})
		const entries: DecisionLogEntry[] = []
		const points = createDecisionPoints({
			model: failing.model,
			modes: { pick: 'on' },
			log: (e) => entries.push(e),
		})
		expect(await points.choose({ ...ask(), options: ['only one'] })).toBeUndefined()
		expect(
			await points.choose({
				...ask(),
				options: Array.from({ length: 256 }, (_, i) => `o${i}`),
			}),
		).toBeUndefined()
		expect(failing.choice).not.toHaveBeenCalled()
		expect(await points.choose(ask())).toBeUndefined()
		expect(entries.map((e) => e.outcome)).toEqual(['error'])
	})

	it('holds no text of the screen in the log', async () => {
		const { model } = chooser({
			[options[0]]: 0.9,
			[options[1]]: 0.05,
			[options[2]]: 0.05,
		})
		const entries: DecisionLogEntry[] = []
		await createDecisionPoints({
			model,
			modes: { pick: 'shadow' },
			log: (e) => entries.push(e),
		}).choose(ask(options[0]))
		expect(JSON.stringify(entries)).not.toMatch(/Save|Cancel|Name|file/)
	})
})
