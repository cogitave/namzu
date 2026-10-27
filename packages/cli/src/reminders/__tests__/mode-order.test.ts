import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import { createCliReminderSource } from '../index.js'

/** Runs one operator turn through the real source and returns the kinds it sent, in order. */
async function run(history: Message[], mode: PermissionMode, planExists = true) {
	const current = { mode }
	const source = createCliReminderSource({
		mode: () => current.mode,
		planPath: () => '/work/plan.md',
		planExists: () => planExists,
		interactive: true,
	})
	const out = [...history, createUserMessage('go')]
	const sent = (await source({ messages: out } as never)) ?? []
	for (const text of sent) out.push(createRuntimeContextMessage(text, 'reminder'))
	return { messages: out, sent }
}

const kinds = (sent: readonly string[]) =>
	sent.map((text) => /kind="([a-z-]+)"/.exec(text)?.[1] ?? '?')

describe('the whole cycle of notices', () => {
	it('reads plan on, plan left and bypass on, bypass ended and plan on again', async () => {
		const one = await run([], 'plan')
		expect(kinds(one.sent)).toEqual(['plan-mode'])
		const two = await run(one.messages, 'bypass')
		expect(kinds(two.sent)).toEqual(['plan-exit', 'mode-bypass'])
		expect(two.sent[0]).toContain('You have left plan mode.')
		expect(two.sent[1]).toContain('The bypass permission mode is on.')
		const three = await run(two.messages, 'plan')
		expect(kinds(three.sent)).toEqual(['mode-exit', 'plan-mode', 'plan-reentry'])
		expect(three.sent[0]).toContain('The bypass permission mode has ended.')
		expect(three.sent[0]).toContain('Plan mode is on')
	})
})

describe('one mode replacing another reads ended first, then begun', () => {
	it('puts the end of plan mode ahead of the bypass notice', async () => {
		let { messages } = await run([], 'plan')
		const next = await run(messages, 'bypass')
		expect(kinds(next.sent)).toEqual(['plan-exit', 'mode-bypass'])
		expect(next.sent[0]).toContain('You have left plan mode.')
		expect(next.sent[1]).toContain('The bypass permission mode is on.')
		expect(next.sent[1]).not.toContain('Plan mode')
		expect(next.sent[1]).not.toContain('has ended')
		messages = next.messages
		expect(kinds((await run(messages, 'bypass')).sent)).toEqual([])
	})

	it('puts the end of the old mode ahead of plan mode', async () => {
		const first = await run([], 'bypass')
		const next = await run(first.messages, 'plan')
		expect(kinds(next.sent)).toEqual(['mode-exit', 'plan-mode'])
		expect(next.sent[0]).toContain('The bypass permission mode has ended.')
		expect(next.sent[0]).toContain('Plan mode is on')
	})

	it('says the same shape for every announced change out of auto and bypass', async () => {
		const first = await run([], 'bypass')
		const toAuto = await run(first.messages, 'classify')
		expect(kinds(toAuto.sent)).toEqual(['mode-auto'])
		expect(toAuto.sent[0]).toContain(
			'The bypass permission mode has ended and the auto permission mode is on.',
		)
		const toPrompt = await run(toAuto.messages, 'prompt')
		expect(kinds(toPrompt.sent)).toEqual(['mode-exit'])
		expect(toPrompt.sent[0]).toContain('The auto permission mode has ended.')
	})
})
