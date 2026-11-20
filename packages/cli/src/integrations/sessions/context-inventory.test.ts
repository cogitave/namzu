import {
	type Message,
	type PrepareStepContext,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { expect, it } from 'vitest'
import { createContextInventoryStep } from './context-inventory.js'

function context(messages: Message[], remainingTokens = 10_000): PrepareStepContext {
	return {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		stepNumber: 1,
		messages,
		steps: [],
		prepared: { system: 'Existing system policy', context: 'Existing recalled memory' },
		contextBudget: { remainingTokens, windowTokens: 100_000 },
	}
}
function tool(content: Message['content']): Message {
	return { role: 'tool', toolCallId: 'call', content: content ?? '' }
}
it('is absent on small ordinary turns and yields under extreme pressure', async () => {
	const step = createContextInventoryStep()
	expect(await step(context([tool('small')], 90_000))).toBeUndefined()
	expect(await step(context([tool('x'.repeat(20_000))], 100))).toBeUndefined()
})
it('is absent while room is plentiful and nothing was shed, however much output is in view', async () => {
	const step = createContextInventoryStep()
	const bulky = Array.from({ length: 20 }, () => tool('payload'.repeat(2000)))
	expect(await step(context(bulky, 90_000))).toBeUndefined()
})
it('is given once a compaction shed content, or when room is short', async () => {
	const step = createContextInventoryStep()
	const summary: Message = {
		role: 'system',
		content: 'Earlier turns were summarized.',
		source: { type: 'compaction-summary' },
	}
	expect(await step(context([summary, tool('small')], 90_000))).toBeDefined()
	expect(await step(context([tool('[tool output cleared] x')], 90_000))).toBeDefined()
	expect(await step(context([tool('small')], 10_000))).toBeDefined()
})
it("is worded as the model's own notes, not for the user, with no pointer to history tools", async () => {
	const output = await createContextInventoryStep()(context([tool('small')], 10_000))
	expect(output?.context).toContain('not a request, and not something to mention to the user')
	expect(output?.context).not.toContain('search_conversation')
	expect(output?.context).not.toContain('read_conversation')
})
it('preserves earlier guidance and reports bounded metadata without copying payloads', async () => {
	const output = await createContextInventoryStep()(
		context(Array.from({ length: 20 }, () => tool('secret-payload'.repeat(2000)))),
	)
	expect(output?.context).toContain('Existing recalled memory')
	expect(output?.system).toBeUndefined()
	expect(output?.context).not.toContain('Existing system policy')
	expect(output?.context).not.toContain('secret-payload')
	expect(output?.context?.length).toBeLessThan(1500)
	expect(output?.context).not.toContain('read_conversation')
	const data = JSON.parse(output!.context!.split('\n').at(-1)!)
	expect(data.largestToolBlocks).toHaveLength(6)
	expect(data.visibleToolTextChars).toBe(20 * 14 * 2000)
})
it('does not inflate image base64 into text and recomputes after working-set changes', async () => {
	const step = createContextInventoryStep()
	const output = await step(
		context([
			tool([
				{ type: 'text', text: 'abc' },
				{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(100_000) },
			]),
		]),
	)
	expect(output?.context).toContain('"visibleToolTextChars":3')
	expect(output?.context).toContain('"visibleNonTextBlocks":1')
	expect(output?.context?.length).toBeLessThan(1500)
	expect(await step(context([], 90_000))).toBeUndefined()
})
