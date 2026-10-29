import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { createCliReminderSource } from '../index.js'
import { type MemoryIndexSection, memoryIndexReminders } from '../memory-index.js'

const curated = (text: string | null): MemoryIndexSection => ({
	key: 'curated',
	label: 'curated memory',
	text,
})
const stored = (text: string | null): MemoryIndexSection => ({
	key: 'stored',
	label: 'stored memory index',
	text,
})

/** The conversation after the host owed the memory and sent it. */
function told(sections: MemoryIndexSection[], history: Message[] = []): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of memoryIndexReminders({ messages: out, sections })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

describe('the memory index reminder', () => {
	it('says every part in full the first time', () => {
		const [first, ...rest] = memoryIndexReminders({
			messages: [createUserMessage('go')],
			sections: [curated('Prefers small diffs.'), stored('- [deploy](deploy.md) - how to ship')],
		})
		expect(rest).toEqual([])
		expect(first).toContain('kind="memory-index"')
		expect(first).toContain('Prefers small diffs.')
		expect(first).toContain('- [deploy](deploy.md) - how to ship')
	})

	it('says nothing when there is no memory at all', () => {
		expect(
			memoryIndexReminders({
				messages: [createUserMessage('go')],
				sections: [curated(null), stored('  ')],
			}),
		).toEqual([])
	})

	it('says nothing again while the memory is unchanged', () => {
		const sections = [curated('Prefers small diffs.'), stored('- [a](a.md) - one')]
		expect(memoryIndexReminders({ messages: told(sections), sections })).toEqual([])
	})

	it('repeats only the part that changed, and says it replaces its earlier copy', () => {
		const messages = told([curated('Prefers small diffs.'), stored('- [a](a.md) - one')])
		const [changed] = memoryIndexReminders({
			messages,
			sections: [curated('Prefers small diffs.'), stored('- [a](a.md) - one\n- [b](b.md) - two')],
		})
		expect(changed).toContain('- [b](b.md) - two')
		expect(changed).not.toContain('Prefers small diffs.')
		expect(changed).toContain('replaces its earlier copy')
	})

	it('says a part is gone once, when it was announced and then removed', () => {
		const messages = told([curated('Prefers small diffs.'), stored('- [a](a.md) - one')])
		const sections = [curated('Prefers small diffs.'), stored(null)]
		const [gone] = memoryIndexReminders({ messages, sections })
		expect(gone).toContain('No longer present: stored memory index')
		const after = [...messages, createRuntimeContextMessage(gone ?? '', 'reminder')]
		expect(memoryIndexReminders({ messages: after, sections })).toEqual([])
	})

	it('says the whole memory again when a compaction dropped the earlier reminder', () => {
		const sections = [curated('Prefers small diffs.')]
		const [again] = memoryIndexReminders({ messages: [createUserMessage('go')], sections })
		expect(again).toContain('Prefers small diffs.')
		expect(again).toContain('carried over from earlier sessions')
	})

	it('is part of what the reminder source feeds a request when the host supplies the memory', async () => {
		const source = createCliReminderSource({
			mode: () => 'default' as never,
			memory: () => [curated('Prefers small diffs.')],
		})
		const out = await source({
			sessionId: 's' as never,
			turnId: 't' as never,
			iteration: 1,
			messages: [createUserMessage('go')],
		})
		expect((out ?? []).join('\n')).toContain('Prefers small diffs.')
	})
})
