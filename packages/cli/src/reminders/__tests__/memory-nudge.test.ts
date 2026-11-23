import {
	type Message,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { memoryNudge } from '../memory-nudge.js'

const call = (name: string, id: string) => [
	{ id, type: 'function' as const, function: { name, arguments: '{}' } },
]
const failed = (id: string, text: string): Message[] => [
	createAssistantMessage(null, call('bash', id)),
	createToolMessage(text, id, true),
]
const compaction = (): Message =>
	({
		role: 'system',
		content: 'summary',
		source: { type: 'compaction-summary' },
	}) as unknown as Message

describe('the memory nudge', () => {
	it('stays quiet on one failure', () => {
		const history = [createUserMessage('go'), ...failed('a', 'Command exited with code 127')]
		expect(memoryNudge(history)).toEqual([])
	})

	it('speaks after the same failure twice', () => {
		const history = [
			createUserMessage('go'),
			...failed('a', 'Command exited with code 127'),
			...failed('b', 'Command exited with code 127'),
		]
		const [nudge] = memoryNudge(history)
		expect(nudge).toContain('exit 127')
		expect(nudge).toContain('save_memory')
	})

	it('does not count two different failures', () => {
		const history = [
			createUserMessage('go'),
			...failed('a', 'Command exited with code 127'),
			...failed('b', 'Command exited with code 2'),
		]
		expect(memoryNudge(history)).toEqual([])
	})

	it('is closed by a memory save', () => {
		const history = [
			createUserMessage('go'),
			...failed('a', 'Command exited with code 127'),
			...failed('b', 'Command exited with code 127'),
			createAssistantMessage(null, call('save_memory', 'm')),
		]
		expect(memoryNudge(history)).toEqual([])
	})

	it('speaks once after a compaction that follows a person message', () => {
		expect(memoryNudge([compaction()])).toEqual([])
		expect(memoryNudge([compaction(), createUserMessage('next')])).toHaveLength(1)
	})
})
