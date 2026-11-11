import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { DEFAULT_SOFT_TARGET, planSalienceWorkingSet, salienceTargetTokens } from '../plan.js'
import { estimateMessagesTokens } from '../token-estimate.js'

/**
 * `softTargetHeadroom` makes a pass shed to the soft target less a margin,
 * so the next pass is needed only after the margin is used. The default is
 * no margin and must be today's behaviour exactly; with a margin the pass
 * must take the messages today's passes would take, in the same order, only
 * earlier.
 */

/**
 * A small window, so the soft target is reached after about fifteen turns and
 * a run of a few dozen turns already holds many passes. The suite runs under
 * coverage on a shared runner, where a pass over a long history costs ten
 * times what it costs locally; what is asserted here does not need one.
 */
const WINDOW = 10_000
const SOFT = Math.floor(WINDOW * DEFAULT_SOFT_TARGET)

const parse = (extra: Record<string, unknown> = {}) =>
	CompactionConfigSchema.parse({ strategy: 'salience', keepRecentMessages: 6, ...extra })

/**
 * One turn: a user message, a tool call with a small result, and a long
 * narration numbered `n`. Few messages per turn on purpose: what these tests
 * count is passes and the order a pass takes narrations in, and a pass costs
 * by the number of messages it reads.
 */
function turn(n: number, id: { next: number }): Message[] {
	const callId = `call_${id.next++}`
	const call: AssistantMessage = {
		role: 'assistant',
		content: null,
		toolCalls: [
			{
				id: callId,
				type: 'function',
				function: { name: 'bash', arguments: '{"command":"true"}' },
			},
		],
	}
	const result: ToolMessage = { role: 'tool', toolCallId: callId, content: 'ok' }
	// Every narration reads the same, as a model that repeats itself does, so
	// what separates them is their age; the number that names one is its
	// timestamp, which the scorer does not read.
	return [
		{ role: 'user', content: `Continue with step ${n}.` },
		call,
		result,
		{
			role: 'assistant',
			content: `Narration. ${'the code runs fast and the test is ok with line and file edit. '.repeat(18)}`,
			timestamp: n,
		},
	]
}

/** The number that names a narration, stubbed or whole. */
const narrationNumber = (m: Message): number | undefined =>
	m.role === 'assistant' && typeof m.content === 'string' ? m.timestamp : undefined

const isStub = (m: Message) => typeof m.content === 'string' && m.content.includes('… (elided')

/**
 * Grow a conversation turn by turn and run a pass whenever the estimate is at
 * or above the soft target, as the runtime does. Returns what each pass took,
 * in the order it took it, and the estimate right after each pass.
 */
function simulate(turns: number, extra: Record<string, unknown>) {
	const config = parse(extra)
	const id = { next: 0 }
	let messages: Message[] = [{ role: 'system', content: 'You are an agent.' }]
	const order: number[] = []
	const passes: { turn: number; before: number; after: number; stubbed: number[] }[] = []
	for (let n = 1; n <= turns; n += 1) {
		messages.push(...turn(n, id))
		const before = estimateMessagesTokens(messages)
		if (before < SOFT) continue
		const plan = planSalienceWorkingSet({
			messages,
			config,
			contextWindowTokens: WINDOW,
			estimatedTokens: before,
		})
		const stubbed = plan.working.actions.map(
			(a) => narrationNumber(messages[a.index] as Message) as number,
		)
		order.push(...stubbed)
		messages = [...plan.messages]
		passes.push({ turn: n, before, after: estimateMessagesTokens(messages), stubbed })
	}
	return { messages, order, passes }
}

describe('the headroom', () => {
	it('is zero unless set, and then the target is the soft target, computed as before', () => {
		expect(parse().softTargetHeadroom).toBeUndefined()
		for (const softTarget of [undefined, 0.3, 0.5, 0.7]) {
			const base = parse(softTarget === undefined ? {} : { softTarget })
			const zero = parse({
				...(softTarget === undefined ? {} : { softTarget }),
				softTargetHeadroom: 0,
			})
			for (const window of [1_000, 20_000, 128_000, 1_000_000, 200_003]) {
				const original = Math.floor(window * (base.softTarget ?? DEFAULT_SOFT_TARGET))
				expect(salienceTargetTokens(base, window)).toBe(original)
				expect(salienceTargetTokens(zero, window)).toBe(original)
			}
		}
	})

	it('takes the target from the soft target less the headroom, never below nothing', () => {
		expect(salienceTargetTokens(parse({ softTargetHeadroom: 0.1 }), 100_000)).toBe(40_000)
		expect(salienceTargetTokens(parse({ softTarget: 0.2, softTargetHeadroom: 0.5 }), 100_000)).toBe(
			0,
		)
	})

	it('is a probability of the window: below 0 or above 1 is refused', () => {
		expect(() => parse({ softTargetHeadroom: -0.1 })).toThrow()
		expect(() => parse({ softTargetHeadroom: 1.1 })).toThrow()
		expect(parse({ softTargetHeadroom: 0.15 }).softTargetHeadroom).toBe(0.15)
	})

	it('changes nothing about a pass when it is zero: the plan is the same, message for message', () => {
		const a = simulate(40, {})
		const b = simulate(40, { softTargetHeadroom: 0 })
		expect(b.order).toEqual(a.order)
		expect(b.passes).toEqual(a.passes)
		expect(b.messages).toEqual(a.messages)
	})

	it('sheds the same messages in the same order, only earlier, and runs far fewer passes', () => {
		const turns = 45
		const margin = 0.2
		const today = simulate(turns, {})
		const roomy = simulate(turns, { softTargetHeadroom: margin })
		// Today: a pass on every turn once the soft target is reached.
		expect(today.passes.length).toBeGreaterThan(25)
		expect(today.passes.every((p) => p.after <= SOFT)).toBe(true)
		// With headroom: a pass sheds to the target less the margin.
		expect(roomy.passes.every((p) => p.after <= SOFT - Math.floor(WINDOW * margin) + 1)).toBe(true)
		// ... and the next one is needed only after the margin is used.
		for (const p of roomy.passes) expect(p.before).toBeGreaterThanOrEqual(SOFT)
		expect(roomy.passes.length).toBeLessThan(today.passes.length / 4)
		// The order is the order: everything today's passes took, in the order
		// they took it, is a prefix of what the margin took.
		expect(roomy.order.slice(0, today.order.length)).toEqual(today.order)
		// And what is stubbed after the run is a superset of today's, never different.
		const stubbed = (messages: Message[]) =>
			new Set(messages.filter(isStub).map((m) => narrationNumber(m)))
		const todaySet = stubbed(today.messages)
		const roomySet = stubbed(roomy.messages)
		for (const n of todaySet) expect(roomySet.has(n)).toBe(true)
	})

	it('takes, from any state, what a pass without headroom would take and then goes on down the same list', () => {
		// Scores drift as a conversation grows (the goal follows the latest turn),
		// so "the same order over the following turns" is exact when what is
		// compared is the pass: at one state the pass with headroom walks the
		// list a pass without it walks, and stops later.
		const id = { next: 0 }
		const messages: Message[] = [{ role: 'system', content: 'You are an agent.' }]
		const words = ['the', 'code', 'file', 'runs', 'edit', 'line', 'test', 'build', 'src/a.ts', 'ok']
		for (let n = 1; n <= 120; n += 1) {
			messages.push(...turn(n, id))
			// Make the narrations differ, so the list has a real order to walk.
			const last = messages[messages.length - 1] as AssistantMessage
			messages[messages.length - 1] = {
				...last,
				content:
					`${(last.content as string).slice(0, 200)} ${words[(n * 7) % 10]} ${words[(n * 3) % 10]} ${'x'.repeat(n % 40)}`.repeat(
						3,
					),
			}
			if (n % 20 !== 0) continue
			const estimatedTokens = estimateMessagesTokens(messages)
			const run = (softTargetHeadroom?: number) =>
				planSalienceWorkingSet({
					messages,
					config: parse(softTargetHeadroom === undefined ? {} : { softTargetHeadroom }),
					contextWindowTokens: Math.floor(estimatedTokens / 0.6),
					estimatedTokens,
				}).working
			const today = run()
			const roomy = run(0.15)
			expect(today.actions.length).toBeGreaterThan(0)
			expect(roomy.actions.length).toBeGreaterThan(today.actions.length)
			expect(roomy.actions.slice(0, today.actions.length)).toEqual(today.actions)
		}
	})

	it('never lets the context exceed the soft target at the point a pass has run', () => {
		for (const headroom of [0, 0.05, 0.1, 0.15]) {
			const run = simulate(40, { softTargetHeadroom: headroom })
			for (const p of run.passes) expect(p.after).toBeLessThanOrEqual(SOFT)
		}
	})
})
