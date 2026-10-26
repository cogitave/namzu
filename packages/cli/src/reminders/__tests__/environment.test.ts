import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { type EnvironmentFacts, composeEnvironmentPrompt } from '../../context/environment.js'
import { environmentReminders } from '../environment.js'
import { createCliReminderSource } from '../index.js'

type Facts = Pick<EnvironmentFacts, 'today' | 'branch' | 'isRepository'>
const monday: Facts = { today: '2026-10-26', branch: 'main', isRepository: true }

/** The conversation after the host owed a reminder and sent it. */
function told(facts: Facts, history: Message[] = []): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of environmentReminders({ messages: out, facts })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

describe('the environment reminder', () => {
	it('tells a conversation the date and the branch once, as facts about right now', () => {
		const [first, ...rest] = environmentReminders({
			messages: [createUserMessage('go')],
			facts: monday,
		})
		expect(rest).toEqual([])
		expect(first).toContain("Today's date is 2026-10-26.")
		expect(first).toContain('`main`')
		expect(first).toContain('facts about right now')
	})

	it('stays quiet while the date and the branch are what it last said, however many turns pass', () => {
		let messages = told(monday)
		for (let turn = 0; turn < 6; turn++) {
			messages = told(monday, messages)
		}
		expect(environmentReminders({ messages, facts: monday })).toEqual([])
		expect(
			messages.filter((m) => typeof m.content === 'string' && m.content.includes('environment')),
		).toHaveLength(1)
	})

	it('says a new day needs no announcement', () => {
		const messages = told(monday)
		const [notice] = environmentReminders({ messages, facts: { ...monday, today: '2026-10-27' } })
		expect(notice).toContain("Today's date is 2026-10-27.")
		expect(notice).toContain('needs no announcement')
		expect(notice).not.toContain('2026-10-26')
	})

	it('says a branch change the same way, and a directory that stopped being a repository', () => {
		const messages = told(monday)
		const [onBranch] = environmentReminders({ messages, facts: { ...monday, branch: 'fix/x' } })
		expect(onBranch).toContain('`fix/x`')
		expect(onBranch).toContain('needs no announcement')
		const [bare] = environmentReminders({
			messages,
			facts: { today: monday.today, branch: null, isRepository: false },
		})
		expect(bare).toContain('not a git repository')
	})

	it('says it again when a compaction dropped the earlier reminder', () => {
		const compacted: Message[] = [createUserMessage('summary of the work so far')]
		expect(environmentReminders({ messages: compacted, facts: monday })).toHaveLength(1)
	})
})

describe('the cached environment block', () => {
	const stable = (facts: Facts) =>
		composeEnvironmentPrompt(
			{
				...facts,
				boundary: { escape: 'ask', interactive: true },
				additionalDirectories: ['/srv/data'],
			},
			{ stable: true },
		)

	it('is byte-identical across a day change and a checkout', () => {
		const base = stable(monday)
		expect(stable({ ...monday, today: '2026-10-27' })).toBe(base)
		expect(stable({ ...monday, branch: 'fix/x' })).toBe(base)
		expect(base).not.toMatch(/\d{4}-\d{2}-\d{2}/)
		expect(base).not.toContain('`main`')
		expect(base).toContain('/srv/data')
	})

	it('does not command "may ask the user" whatever mode the turn is in', () => {
		expect(stable(monday)).not.toContain('may ask the user')
	})
})

describe('the reminder source', () => {
	it('sends the environment reminder on the first request when the host provides the facts', async () => {
		const source = createCliReminderSource({ mode: () => 'prompt', environment: () => monday })
		const out = await source({ messages: [createUserMessage('go')] } as never)
		expect(out?.some((text) => text.includes("Today's date is 2026-10-26."))).toBe(true)
	})
})
