import { type Message, type PrepareStepContext, generateRunId } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { createContextInventoryStep } from './context-inventory.js'

function context(messages: Message[], remainingTokens = 10_000): PrepareStepContext {
	return {
		runId: generateRunId(),
		stepNumber: 1,
		messages,
		steps: [],
		prepared: { system: 'Existing recalled memory' },
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
it('preserves earlier guidance and reports bounded metadata without copying payloads', async () => {
	const output = await createContextInventoryStep()(
		context(Array.from({ length: 20 }, () => tool('secret-payload'.repeat(2000)))),
	)
	expect(output?.system).toContain('Existing recalled memory')
	expect(output?.system).not.toContain('secret-payload')
	expect(output?.system?.length).toBeLessThan(1500)
	expect(output?.system).toContain('read_conversation')
	const data = JSON.parse(output!.system!.split('\n').at(-1)!)
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
	expect(output?.system).toContain('"visibleToolTextChars":3')
	expect(output?.system).toContain('"visibleNonTextBlocks":1')
	expect(output?.system?.length).toBeLessThan(1500)
	expect(await step(context([], 90_000))).toBeUndefined()
})
