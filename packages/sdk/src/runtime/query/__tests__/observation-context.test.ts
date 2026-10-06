import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { estimateMessagesTokens } from '../../../compaction/token-estimate.js'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Message, ToolCall, ToolMessage } from '../../../types/message/index.js'
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
function registry(
	readOnly: boolean | undefined = true,
	destructive = false,
	inputSchema: z.ZodType = z.object({}),
) {
	const tools = testToolset({
		name: 'read',
		description: 'observe',
		inputSchema,
		isReadOnly: () => readOnly === true,
		isDestructive: () => destructive,
		execute: async () => ({ success: true, output: body }),
	})
	return new ToolManager({ toolsets: [tools], messages: () => [] })
}

/** Models an executor-owned record of the direct calls this fixture completed. */
function recordedExecution(
	history: Message[],
): (call: ToolCall, message: ToolMessage) => string | undefined {
	const records = new Map<string, { call: ToolCall; message: ToolMessage }>()
	for (let index = 0; index + 1 < history.length; index += 2) {
		const assistant = history[index]
		const message = history[index + 1]
		const call = assistant?.role === 'assistant' ? assistant.toolCalls?.[0] : undefined
		if (call && message?.role === 'tool' && message.toolCallId === call.id && !message.isError) {
			records.set(call.id, { call, message })
		}
	}
	return (call, message) => {
		const record = records.get(call.id)
		return record?.call === call && record.message === message
			? JSON.stringify(['fixture execution input', call.function.arguments])
			: undefined
	}
}

function projectRecorded(
	history: Message[],
	tools: Pick<ToolManager, 'get'> = registry(),
	preserveToolResultsFrom: readonly string[] = [],
): Message[] {
	return projectObservationContext(
		history,
		tools,
		preserveToolResultsFrom,
		recordedExecution(history),
	)
}

describe('dynamic exact observation policy', () => {
	it('keeps the first full observation and all call/result pairs, without changing history', () => {
		const history = [...turn('a'), ...turn('b'), ...turn('c')]
		const original = structuredClone(history)
		const projected = projectRecorded(history)
		expect(projected).toHaveLength(history.length)
		expect(projected[1]?.content).toBe(body)
		expect(projected[3]?.content).toContain('"a"')
		expect(projected[5]?.content).toContain('"a"')
		expect(estimateMessagesTokens(projected)).toBeLessThan(estimateMessagesTokens(history) / 2)
		expect(history).toEqual(original)
	})

	it('leaves the existing request prefix stable when another duplicate is appended', () => {
		const history = [...turn('a'), ...turn('b')]
		const before = projectRecorded(history)
		const after = projectRecorded([...history, ...turn('c')])
		expect(after.slice(0, before.length)).toEqual(before)
	})

	it('rehydrates a surviving original when its former representative disappears', () => {
		const history = [...turn('a'), ...turn('b')]
		expect(projectRecorded(history)[3]?.content).not.toBe(body)
		const surviving = history.slice(2)
		expect(projectRecorded(surviving)).toBe(surviving)
		expect(surviving[1]?.content).toBe(body)
	})

	it('does not reference a representative whose content was cleared by compaction', () => {
		const history = [...turn('a'), ...turn('b')]
		history[1] = clearToolResult(history[1] as ToolMessage, 'read').message
		expect(projectRecorded(history)).toBe(history)
	})

	it.each([
		['changed content', `${body}changed`, '{"path":"a.ts"}'],
		['another file', body, '{"path":"b.ts"}'],
		['another range', body, '{"path":"a.ts","offset":20}'],
		['small result', 'small', '{"path":"a.ts"}'],
	])('preserves %s', (_label, content, args) => {
		const history = [...turn('a', content), ...turn('b', content, args)]
		if (_label === 'changed content') history[1] = { role: 'tool', toolCallId: 'a', content: body }
		expect(projectRecorded(history)).toBe(history)
	})

	it('preserves full observations without a trusted execution classification', () => {
		const history = [...turn('a'), ...turn('b')]
		expect(projectObservationContext(history, registry())).toBe(history)
		expect(projectObservationContext(history, registry(), [], () => undefined)).toBe(history)
		expect(
			projectObservationContext(history, registry(), [], () => {
				throw new Error('classification unavailable')
			}),
		).toBe(history)
	})

	it('never re-runs schema effects or tool predicates while projecting history', () => {
		const effects = { defaults: 0, refinements: 0, transforms: 0, predicates: 0 }
		const syncSchema = z
			.object({
				path: z.string().default(() => {
					effects.defaults++
					return 'a.ts'
				}),
			})
			.refine(() => {
				effects.refinements++
				return true
			})
			.transform((value) => {
				effects.transforms++
				return value
			})
		const asyncSchema = z
			.object({
				path: z.string().default(() => {
					effects.defaults++
					return 'a.ts'
				}),
			})
			.superRefine(async () => {
				effects.refinements++
			})
			.transform(async (value) => {
				effects.transforms++
				return value
			})
		const history = [...turn('a', body, '{}'), ...turn('b', body, '{}')]
		for (const schema of [syncSchema, asyncSchema]) {
			const tools = registry(true, false, schema)
			const tool = tools.get('read')
			if (!tool) throw new Error('Expected the read tool')
			tool.isReadOnly = () => {
				effects.predicates++
				return true
			}
			tool.isDestructive = () => {
				effects.predicates++
				return false
			}
			for (let request = 0; request < 2; request++) {
				expect(projectObservationContext(history, tools)).toBe(history)
				expect(projectRecorded(history, tools)[3]?.content).not.toBe(body)
			}
		}
		expect(effects).toEqual({ defaults: 0, refinements: 0, transforms: 0, predicates: 0 })
	})

	it('preserves retained, failed, destructive and rich results', () => {
		const retained = [...turn('a'), ...turn('b')]
		retained[3] = { ...retained[3]!, retain: true }
		expect(projectRecorded(retained)).toBe(retained)
		const failed = [...turn('a'), ...turn('b')]
		failed[1] = { ...(failed[1] as ToolMessage), isError: true }
		expect(projectRecorded(failed)).toBe(failed)
		const rich = [...turn('a'), ...turn('b')]
		for (const index of [1, 3])
			rich[index] = { ...(rich[index] as ToolMessage), content: [{ type: 'text', text: body }] }
		expect(projectRecorded(rich)).toBe(rich)
		const destructive = [...turn('a'), ...turn('b')]
		// The executor never records a destructive result as an observation.
		expect(projectObservationContext(destructive, registry(true, true), [], () => undefined)).toBe(
			destructive,
		)
	})

	it('keeps equal raw calls and outputs when the executed inputs differ', () => {
		const messages = [...turn('a'), ...turn('b')]
		const projected = projectObservationContext(messages, registry(), [], (call) =>
			call.id === 'a' ? 'prepared path a.ts' : 'prepared path b.ts',
		)
		expect(projected).toBe(messages)
		expect(projected[1]?.content).toBe(body)
		expect(projected[3]?.content).toBe(body)
	})

	it('honors named preservation and declines malformed arguments without execution evidence', () => {
		const history = [...turn('a'), ...turn('b')]
		const tools = registry()
		expect(projectRecorded(history, tools, ['read'])).toBe(history)
		const malformed = [...turn('a', body, 'invalid'), ...turn('b', body, 'invalid')]
		expect(projectObservationContext(malformed, registry(), [], () => undefined)).toBe(malformed)
	})

	it('declines ambiguous call IDs and unknown tools', () => {
		const ambiguous = [...turn('a'), ...turn('a')]
		expect(projectRecorded(ambiguous)).toBe(ambiguous)
		const unknown = [...turn('a', body, '{}', 'unknown'), ...turn('b', body, '{}', 'unknown')]
		expect(projectRecorded(unknown)).toBe(unknown)
	})
})
