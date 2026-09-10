import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { estimateMessagesTokens } from '../../../compaction/token-estimate.js'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import { projectObservationContext } from '../observation-context.js'

const body = 'exact observation with important evidence\n'.repeat(200)
function turn(id: string, content = body, args = '{"path":"a.ts"}', name = 'read'): Message[] {
	return [
		{
			role: 'assistant',
			content: null,
			toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
		},
		{ role: 'tool', toolCallId: id, content },
	]
}
function registry(readOnly: boolean | undefined = true, destructive = false) {
	const tools = new ToolRegistry()
	tools.register({
		name: 'read',
		description: 'observe',
		inputSchema: z.object({}),
		isReadOnly: () => readOnly === true,
		isDestructive: () => destructive,
		execute: async () => ({ success: true, output: body }),
	})
	return tools
}

describe('dynamic exact observation policy', () => {
	it('keeps the first full observation and all call/result pairs, without changing history', () => {
		const history = [...turn('a'), ...turn('b'), ...turn('c')]
		const original = structuredClone(history)
		const projected = projectObservationContext(history, registry())
		expect(projected).toHaveLength(history.length)
		expect(projected[1]?.content).toBe(body)
		expect(projected[3]?.content).toContain('"a"')
		expect(projected[5]?.content).toContain('"a"')
		expect(estimateMessagesTokens(projected)).toBeLessThan(estimateMessagesTokens(history) / 2)
		expect(history).toEqual(original)
	})

	it('leaves the existing request prefix stable when another duplicate is appended', () => {
		const history = [...turn('a'), ...turn('b')]
		const before = projectObservationContext(history, registry())
		const after = projectObservationContext([...history, ...turn('c')], registry())
		expect(after.slice(0, before.length)).toEqual(before)
	})

	it('rehydrates a surviving original when its former representative disappears', () => {
		const history = [...turn('a'), ...turn('b')]
		expect(projectObservationContext(history, registry())[3]?.content).not.toBe(body)
		const surviving = history.slice(2)
		expect(projectObservationContext(surviving, registry())).toBe(surviving)
		expect(surviving[1]?.content).toBe(body)
	})

	it('does not reference a representative whose content was cleared by compaction', () => {
		const history = [...turn('a'), ...turn('b')]
		history[1] = clearToolResult(history[1] as ToolMessage, 'read').message
		expect(projectObservationContext(history, registry())).toBe(history)
	})

	it.each([
		['changed content', `${body}changed`, '{"path":"a.ts"}'],
		['another file', body, '{"path":"b.ts"}'],
		['another range', body, '{"path":"a.ts","offset":20}'],
		['small result', 'small', '{"path":"a.ts"}'],
	])('preserves %s', (_label, content, args) => {
		const history = [...turn('a', content), ...turn('b', content, args)]
		if (_label === 'changed content') history[1] = { role: 'tool', toolCallId: 'a', content: body }
		expect(projectObservationContext(history, registry())).toBe(history)
	})

	it.each([false, undefined])(
		'preserves tools without explicit read-only admission (%s)',
		(readOnly) => {
			const tools = registry(false)
			tools.get('read')!.isReadOnly = readOnly === undefined ? undefined : () => readOnly
			const history = [...turn('a'), ...turn('b')]
			expect(projectObservationContext(history, tools)).toBe(history)
		},
	)

	it('preserves retained, failed, destructive and rich results', () => {
		const retained = [...turn('a'), ...turn('b')]
		retained[3] = { ...retained[3]!, retain: true }
		expect(projectObservationContext(retained, registry())).toBe(retained)
		const failed = [...turn('a'), ...turn('b')]
		failed[1] = { ...(failed[1] as ToolMessage), isError: true }
		expect(projectObservationContext(failed, registry())).toBe(failed)
		const rich = [...turn('a'), ...turn('b')]
		for (const index of [1, 3])
			rich[index] = { ...(rich[index] as ToolMessage), content: [{ type: 'text', text: body }] }
		expect(projectObservationContext(rich, registry())).toBe(rich)
		const normal = [...turn('a'), ...turn('b')]
		expect(projectObservationContext(normal, registry(true, true))).toBe(normal)
	})

	it('honors named preservation and declines broken classification or malformed arguments', () => {
		const history = [...turn('a'), ...turn('b')]
		const tools = registry()
		expect(projectObservationContext(history, tools, ['read'])).toBe(history)
		tools.get('read')!.isReadOnly = () => {
			throw new Error('broken classifier')
		}
		expect(projectObservationContext(history, tools)).toBe(history)
		const malformed = [...turn('a', body, 'invalid'), ...turn('b', body, 'invalid')]
		expect(projectObservationContext(malformed, registry())).toBe(malformed)
	})

	it('declines ambiguous call IDs and unknown tools', () => {
		const ambiguous = [...turn('a'), ...turn('a')]
		expect(projectObservationContext(ambiguous, registry())).toBe(ambiguous)
		const unknown = [...turn('a', body, '{}', 'unknown'), ...turn('b', body, '{}', 'unknown')]
		expect(projectObservationContext(unknown, registry())).toBe(unknown)
	})
})
