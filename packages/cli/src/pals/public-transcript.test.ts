import { type AssistantMessage, createAssistantMessage } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { palPublicAssistantText } from './public-transcript.js'

it('projects only delivered public text without modifying replay messages', () => {
	const parts = [
		{ id: 'working', text: 'Opening a private internal path', phase: 'commentary' as const },
		{ id: 'final', text: 'Your report is ready.', phase: 'final_answer' as const },
	]
	const message: AssistantMessage = {
		...createAssistantMessage('Your report is ready.'),
		textParts: parts,
	}
	expect(palPublicAssistantText(message)).toBe('Your report is ready.')
	expect(message.textParts).toBe(parts)
	expect(
		palPublicAssistantText({ ...message, textParts: [parts[0]!], content: parts[0]!.text }),
	).toBeUndefined()
	expect(
		palPublicAssistantText({
			...message,
			toolCalls: [
				{ id: 'owned-call', type: 'function', function: { name: 'read', arguments: '{}' } },
			],
		}),
	).toBeUndefined()
})

it('preserves authored unphased answers and superseding edits instead of reviving old text', () => {
	expect(palPublicAssistantText(createAssistantMessage('Plain delivered answer'))).toBe(
		'Plain delivered answer',
	)
	const message = {
		...createAssistantMessage('New edited answer'),
		textParts: [{ id: 'old', text: 'Old answer', phase: 'final_answer' as const }],
	}
	expect(palPublicAssistantText(message)).toBe('New edited answer')
	expect(
		palPublicAssistantText({
			...message,
			textParts: [{ id: 'old-note', text: 'Old commentary', phase: 'commentary' }],
		}),
	).toBe('New edited answer')
	expect(palPublicAssistantText(createAssistantMessage(' '))).toBeUndefined()
})
