/**
 * A generated image is the turn's output: live it is drawn after the answer text, so a
 * resumed conversation draws it there too and not where the call sits in the saved messages.
 */
import {
	type Message,
	type SessionRecord,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { trailFromRecords } from '../restored-rows.js'

const SESSION = '00000000-0000-4000-8000-0000000000bb'
const TURN = '00000000-0000-4000-8000-000000000201'

const SAVED = [
	'Image generated and already shown to the person.',
	'Prompt: a red fox on a hill',
	'Saved to: /home/someone/.namzu/generated_images/s1/call_1.png',
].join('\n')

function restored(options: { failed?: boolean } = {}): string[] {
	const user = { ...createUserMessage('draw a fox'), id: 'u' } as Message
	const call = {
		...createAssistantMessage('', [
			{
				id: 'call_1',
				type: 'function',
				function: {
					name: 'generate_image',
					arguments: '{"prompt":"a red fox on a hill"}',
				},
			},
		]),
		id: 'a1',
	} as Message
	const result = {
		...createToolMessage(
			options.failed ? 'image generation failed: the plan is used up' : SAVED,
			'call_1',
			options.failed === true,
		),
		id: 't1',
	} as Message
	const answer = {
		...createAssistantMessage('Here is your fox.'),
		id: 'a2',
	} as Message
	const messages = [user, call, result, answer]
	const records: SessionRecord[] = []
	let seq = 0
	const push = (r: Record<string, unknown>) =>
		records.push({
			v: 1,
			id: `r-${seq}`,
			seq: seq++,
			ts: '2026-11-24T10:00:00.000Z',
			sessionId: SESSION,
			...r,
		} as unknown as SessionRecord)
	push({ type: 'turn_started', turnId: TURN })
	for (const m of messages)
		push({
			type: 'message',
			turnId: TURN,
			messageId: m.id,
			role: m.role,
			content: m,
		})
	push({ type: 'turn_completed', turnId: TURN, result: '' })
	let n = 0
	return projectConversation(messages, () => `row-${++n}`, [], {
		trail: trailFromRecords(records),
	}).map((row) => row.content)
}

describe('a restored generated image', () => {
	it('is drawn after the answer, as it was live', () => {
		const rows = restored()
		const answer = rows.indexOf('Here is your fox.')
		const heading = rows.indexOf('Generated image')
		expect(answer).toBeGreaterThanOrEqual(0)
		expect(heading).toBeGreaterThan(answer)
		expect(rows[heading + 1]).toBe('  a red fox on a hill')
		expect(rows[heading + 2]).toMatch(/^ {2}└ Saved to .*call_1\.png$/)
	})

	it('keeps a failure where the call was, as live', () => {
		const rows = restored({ failed: true })
		expect(rows.indexOf('Image generation failed')).toBeLessThan(rows.indexOf('Here is your fox.'))
	})
})
