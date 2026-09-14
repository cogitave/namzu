import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import { describeVisibleFileEvidence } from '../file-evidence-context.js'

const cwd = resolve('workspace')
const body = 'Merhaba!\n'
function history(id = 'write-1', path = 'note.txt'): Message[] {
	return [
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id,
					type: 'function',
					function: { name: 'write', arguments: JSON.stringify({ path, content: body }) },
				},
			],
		},
		{ role: 'tool', toolCallId: id, content: 'Created file', isError: false },
	]
}
function fixture() {
	const tracker = createFileReadTracker()
	tracker.recordRead(resolve(cwd, 'note.txt'), body, 'write-1')
	return {
		tracker,
		describe: (messages: Message[]) => describeVisibleFileEvidence(messages, tracker, cwd, false),
	}
}

describe('visible file evidence', () => {
	it('joins visible complete input with successful receipt and the current observation without copying content', () => {
		const f = fixture()
		const messages = history()
		const original = structuredClone(messages)
		expect(f.describe(messages)).toContain('"bodyInCall":"write-1"')
		expect(f.describe(messages)).not.toContain(body)
		expect(messages).toEqual(original)
		f.tracker.recordRead(resolve(cwd, 'note.txt'), body)
		expect(f.describe(messages)).toContain('"bodyInCall":"write-1"')
		f.tracker.recordRead(resolve(cwd, 'note.txt'), 'another version')
		expect(f.tracker.writeCallId?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.describe(messages)).toBeUndefined()
		f.tracker.recordRead(resolve(cwd, 'note.txt'), body)
		expect(f.describe(messages)).toBeUndefined()
	})
	it('invalidates the fingerprint on a later observation with no content', () => {
		const f = fixture()
		f.tracker.recordRead(resolve(cwd, 'note.txt'))
		expect(f.tracker.hasRead(resolve(cwd, 'note.txt'))).toBe(true)
		expect(f.tracker.fingerprint?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.tracker.writeCallId?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.describe(history())).toBeUndefined()
	})
	it('withholds evidence after compaction, error, ambiguous IDs or missing call/result', () => {
		const f = fixture()
		const messages = history()
		const receipt = messages[1] as ToolMessage
		for (const variant of [
			[messages[0], clearToolResult(receipt, 'write').message],
			[messages[0], { ...receipt, isError: true }],
			[...messages, ...messages],
			messages.slice(0, 1),
			messages.slice(1),
		] as Message[][])
			expect(f.describe(variant)).toBeUndefined()
		const call = messages[0]
		if (call?.role !== 'assistant' || !call.toolCalls?.[0]) throw new Error('fixture')
		call.toolCalls[0].metadata = { inputTruncated: true }
		expect(f.describe(messages)).toBeUndefined()
	})
	it('requires an execution witness, not merely a matching read; uses sandbox keys without host path resolution', () => {
		const f = fixture()
		expect(
			describeVisibleFileEvidence(history(), { recordRead() {}, hasRead: () => true }, cwd, false),
		).toBeUndefined()
		f.tracker.recordRead('note.txt', body, 'write-1')
		expect(describeVisibleFileEvidence(history(), f.tracker, cwd, true)).toContain('write-1')
		const readOnlyObservation = createFileReadTracker()
		readOnlyObservation.recordRead(resolve(cwd, 'note.txt'), body)
		expect(describeVisibleFileEvidence(history(), readOnlyObservation, cwd, false)).toBeUndefined()
		readOnlyObservation.recordRead(resolve(cwd, 'note.txt'), body, 'another-write')
		expect(describeVisibleFileEvidence(history(), readOnlyObservation, cwd, false)).toBeUndefined()
	})
	it('bounds output to six paths and excludes oversized or invalid input', () => {
		const f = fixture()
		const messages: Message[] = []
		for (let i = 0; i < 20; i++) {
			f.tracker.recordRead(resolve(cwd, `n${i}`), body, `w${i}`)
			messages.push(...history(`w${i}`, `n${i}`))
		}
		const output = f.describe(messages) as string
		expect(JSON.parse(output.split('\n').at(-1) as string)).toHaveLength(6)
		const invalid = history()
		if (invalid[0]?.role === 'assistant' && invalid[0].toolCalls?.[0])
			invalid[0].toolCalls[0].function.arguments = '{'
		expect(f.describe(invalid)).toBeUndefined()
		expect(f.describe(history('x'.repeat(257)))).toBeUndefined()
	})
})
