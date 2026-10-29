import {
	type Message,
	type Skill,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { createCliReminderSource } from '../index.js'
import { SKILL_LISTING_DESCRIPTION_MAX_CHARS, skillListingReminders } from '../skills.js'

function skill(name: string, description: string, invocation?: 'user'): Skill {
	return {
		metadata: { name, description, ...(invocation ? { invocation } : {}) },
		dirPath: `/skills/${name}`,
	} as Skill
}

/** The conversation after the host owed a listing and sent it. */
function told(described: Skill[], nameOnly: string[] = [], history: Message[] = []): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of skillListingReminders({ messages: out, described, nameOnly })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

const review = skill('review', 'Review a change before it merges.')
const deploy = skill('deploy', 'Ship a build to staging.')

describe('the skill listing reminder', () => {
	it('lists every skill the first time, with how to load one', () => {
		const [first, ...rest] = skillListingReminders({
			messages: [createUserMessage('go')],
			described: [review, deploy],
			nameOnly: [],
		})
		expect(rest).toEqual([])
		expect(first).toContain('kind="skill-listing"')
		expect(first).toContain('- review: Review a change before it merges.')
		expect(first).toContain('- deploy: Ship a build to staging.')
		expect(first).toContain('skill tool')
	})

	it('says nothing when there is nothing to list', () => {
		expect(
			skillListingReminders({ messages: [createUserMessage('go')], described: [], nameOnly: [] }),
		).toEqual([])
	})

	it('stays quiet while the list is what it last said, however many turns pass', () => {
		let messages = told([review, deploy])
		for (let turn = 0; turn < 5; turn++) messages = told([review, deploy], [], messages)
		expect(skillListingReminders({ messages, described: [review, deploy], nameOnly: [] })).toEqual(
			[],
		)
		expect(messages.filter((m) => String(m.content).includes('skill-listing'))).toHaveLength(1)
	})

	it('names only a skill that arrived mid-session', () => {
		const messages = told([review])
		const [added] = skillListingReminders({ messages, described: [review, deploy], nameOnly: [] })
		expect(added).toContain('- deploy: Ship a build to staging.')
		expect(added).not.toContain('- review')
		expect(added).not.toContain('available through the skill tool')
	})

	it('names only a skill whose description changed', () => {
		const messages = told([review, deploy])
		const edited = skill('review', 'Review a change and its tests.')
		const [changed] = skillListingReminders({ messages, described: [edited, deploy], nameOnly: [] })
		expect(changed).toContain('- review: Review a change and its tests.')
		expect(changed).not.toContain('- deploy')
	})

	it('withdraws only removed skills, including name-only entries, once', () => {
		const messages = told([review, deploy], ['lint'])
		const [removed] = skillListingReminders({ messages, described: [review], nameOnly: [] })
		expect(removed).toContain('no longer available through the skill tool')
		expect(removed).toContain('- deploy (withdrawn)')
		expect(removed).toContain('- lint (withdrawn)')
		expect(removed).not.toContain('- review')
		const history = told([review], [], messages)
		expect(skillListingReminders({ messages: history, described: [review], nameOnly: [] })).toEqual(
			[],
		)
	})

	it('withdraws the final skill and stays quiet on repeated empty catalogues', () => {
		const messages = told([review])
		const [removed] = skillListingReminders({ messages, described: [], nameOnly: [] })
		expect(removed).toContain('- review (withdrawn)')
		expect(removed).not.toContain('These skills are available')
		let history = told([], [], messages)
		for (let turn = 0; turn < 3; turn++) history = told([], [], history)
		expect(history.filter((m) => String(m.content).includes('skill-listing'))).toHaveLength(2)
		expect(skillListingReminders({ messages: history, described: [], nameOnly: [] })).toEqual([])
	})

	it('announces additions and withdrawals together without repeating surviving skills', () => {
		const messages = told([review, deploy])
		const lint = skill('lint', 'Lint changed files.')
		const [changed] = skillListingReminders({ messages, described: [review, lint], nameOnly: [] })
		expect(changed).toContain('- lint: Lint changed files.')
		expect(changed).toContain('- deploy (withdrawn)')
		expect(changed).not.toContain('- review')
		expect(
			skillListingReminders({
				messages: told([review, lint], [], messages),
				described: [review, lint],
				nameOnly: [],
			}),
		).toEqual([])
	})

	it.each([false, true])('announces an unchanged re-added skill after removal (all: %s)', (all) => {
		const messages = told(all ? [] : [review], [], told([review, deploy]))
		const [added] = skillListingReminders({ messages, described: [review, deploy], nameOnly: [] })
		expect(added).toContain('- deploy: Ship a build to staging.')
		expect(added).not.toContain('(withdrawn)')
		expect(
			skillListingReminders({
				messages: told([review, deploy], [], messages),
				described: [review, deploy],
				nameOnly: [],
			}),
		).toEqual([])
	})

	it('replays retained withdrawals after compaction and re-announces dropped entries', () => {
		const history = told([review], [], told([review, deploy]))
		// Compaction retained the withdrawal but dropped the initial catalogue.
		const messages = history.filter(
			(m) => !String(m.content).includes('These skills are available'),
		)
		const [again] = skillListingReminders({ messages, described: [review], nameOnly: [] })
		expect(again).toContain('- review: Review a change before it merges.')
		expect(again).not.toContain('deploy')
		const replayed = told([review], [], messages)
		expect(
			skillListingReminders({ messages: replayed, described: [review], nameOnly: [] }),
		).toEqual([])
		const [added] = skillListingReminders({
			messages: replayed,
			described: [review, deploy],
			nameOnly: [],
		})
		expect(added).toContain('- deploy: Ship a build to staging.')
	})

	it('withdraws a skill that becomes operator-only', () => {
		const [removed] = skillListingReminders({
			messages: told([review]),
			described: [skill('review', review.metadata.description, 'user')],
			nameOnly: [],
		})
		expect(removed).toContain('- review (withdrawn)')
	})

	it('leaves out a skill only the operator may invoke', () => {
		const [first] = skillListingReminders({
			messages: [createUserMessage('go')],
			described: [review, skill('rotate-keys', 'Rotate the deploy key.', 'user')],
			nameOnly: [],
		})
		expect(first).toContain('- review')
		expect(first).not.toContain('rotate-keys')
	})

	it('lists a skill the budget left without room by name, and says how to read its description', () => {
		const [first] = skillListingReminders({
			messages: [createUserMessage('go')],
			described: [review],
			nameOnly: ['lint', 'docs'],
		})
		expect(first).toContain('\n- lint\n')
		expect(first).toContain('\n- docs')
		expect(first).toContain('call the skill tool without a name')
	})

	it('describes a skill once the budget has room for it, after it was named only', () => {
		const messages = told([review], ['lint'])
		const [described] = skillListingReminders({
			messages,
			described: [review, skill('lint', 'Lint the changed files.')],
			nameOnly: [],
		})
		expect(described).toContain('- lint: Lint the changed files.')
	})

	it('says the whole list again once a compaction dropped the earlier reminder', () => {
		const messages = told([review, deploy]).filter((m) => !String(m.content).includes('skill-'))
		const [again] = skillListingReminders({ messages, described: [review, deploy], nameOnly: [] })
		expect(again).toContain('- review')
		expect(again).toContain('- deploy')
		expect(again).toContain('available through the skill tool')
	})

	it('puts a long description on one line and cuts it', () => {
		const long = skill('wide', `${'word '.repeat(600)}\nsecond line`)
		const [first] = skillListingReminders({
			messages: [createUserMessage('go')],
			described: [long],
			nameOnly: [],
		})
		const line = String(first)
			.split('\n')
			.find((l) => l.startsWith('- wide'))
		expect(line).toBeDefined()
		expect((line as string).length).toBeLessThanOrEqual(
			'- wide: '.length + SKILL_LISTING_DESCRIPTION_MAX_CHARS,
		)
		expect(line).toMatch(/…$/)
	})

	it('is fed through the terminal reminder source beside the other reminders', async () => {
		const source = createCliReminderSource({
			mode: () => 'auto',
			skills: () => ({ described: [review], nameOnly: [] }),
		})
		const messages = [createUserMessage('go')]
		const out = (await source({
			sessionId: 's' as never,
			turnId: 't' as never,
			iteration: 1,
			messages,
		})) as string[]
		expect(out.join('\n')).toContain('- review')
	})
})
