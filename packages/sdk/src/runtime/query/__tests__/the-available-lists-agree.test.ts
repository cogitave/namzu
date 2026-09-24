import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Toolset } from '../../../toolsets/types.js'
import { deferred } from '../../../toolsets/wrappers.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * Within one step, every "Available: …" the model is shown names the same
 * tools: the ones it can call right now.
 *
 * There are two such lists. A call to a tool the step withheld is refused
 * with "Tool X is not available on this step. Available: …"; a call to a
 * name the registry does not hold is answered with "Unknown tool X.
 * Available: …". The first used to echo the step's allow-list verbatim, and
 * the allow-list is a snapshot — a connector that disconnected after the
 * request was built leaves its tools on it. The second used to list the
 * whole registry, including every tool the step withholds.
 *
 * A model reading them did the obvious thing and called what it was told
 * was available. The allow-list sent it to a name that was not registered;
 * the unknown-tool error sent it back to a tool the step refused; round it
 * went until someone stopped the run. The first test here is that loop.
 */

const SESSION_ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0' as SessionId
const TURN_ID = '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function tool(name: string, execute?: ToolDefinition['execute']): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		execute: execute ?? (async () => ({ success: true, output: `${name} ran` })),
	} as unknown as ToolDefinition
}

function makeExecutor(registry: ToolManager): ToolExecutor {
	return new ToolExecutor(
		{
			tools: registry,
			sessionId: SESSION_ID,
			turnId: TURN_ID,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		new ActivityStore(TURN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		() => Promise.resolve(),
		makeLogger(),
	)
}

function liveTools(initial: ToolDefinition[], deferredTools: ToolDefinition[] = []) {
	let current = [...initial]
	const listeners = new Set<() => void>()
	const source: Toolset = {
		source: { id: 'live', kind: 'host_tool', name: 'live' },
		tools: () => current,
		onChange(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
	const manager = new ToolManager({
		toolsets: [source, deferred(testToolset(...deferredTools))],
		messages: () => [],
	})
	function update(next: ToolDefinition[]) {
		current = next
		for (const listener of listeners) listener()
		manager.refresh()
	}
	return {
		manager,
		remove: (name: string) => update(current.filter((tool) => tool.name !== name)),
		add: (definition: ToolDefinition) => update([...current, definition]),
	}
}

let callSeq = 0

function response(name: string): ChatCompletionResponse {
	callSeq += 1
	return {
		id: `resp_${callSeq}`,
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: `call_${callSeq}`, type: 'function', function: { name, arguments: '{}' } }],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

/** One model call, down the path a turn takes: prepared for review, then run. */
async function call(
	executor: ToolExecutor,
	name: string,
): Promise<{ output: string; isError: boolean }> {
	const r = response(name)
	const prepared = await executor.prepareBatchForReview(r)
	const batch = await executor.executeBatch(r, undefined, undefined, prepared)
	const result = batch.results[0]
	if (!result) throw new Error('the batch answered nothing')
	return { output: result.output, isError: result.isError === true }
}

/** The names after "Available:" in a result, `[]` for "(none)", `undefined` if there is no list. */
function advertised(output: string): string[] | undefined {
	const match = /Available: ([^\n]*)/.exec(output)
	if (!match?.[1]) return undefined
	const list = match[1].trim().replace(/\.$/, '')
	return list === '(none)' ? [] : list.split(', ')
}

describe('the lists a model is shown agree with each other and with what runs', () => {
	it('does not send a model that follows them round in a circle', async () => {
		const tools = liveTools([tool('danger'), tool('mcp_fetch')])
		const executor = makeExecutor(tools.manager)
		// The step was narrowed to the connector's tool, and the request went
		// out with it. Then the connector disconnected, which unregisters its
		// tools — and the step's list, taken when the request was built, still
		// names it.
		executor.setStepAllowedTools(['mcp_fetch'])
		tools.remove('mcp_fetch')

		// The model calls something, then always the first tool it was told is
		// available, until it is told there is none.
		const called: string[] = []
		let next: string | undefined = 'danger'
		while (next !== undefined && called.length < 6) {
			called.push(next)
			const { output } = await call(executor, next)
			next = advertised(output)?.[0]
		}

		// Nothing is callable on this step, so both answers say "(none)" and
		// the model has nowhere to be sent. Before, the refusal named
		// `mcp_fetch` and the unknown-tool error named `danger`, and the model
		// alternated between them for as long as it was allowed to.
		expect(called).toEqual(['danger'])
	})

	it('advertises the same tools from both errors, and every one of them runs', async () => {
		const tools = liveTools(
			[tool('read_only'), tool('danger'), tool('mcp_fetch')],
			[tool('deep_search')],
		)
		const executor = makeExecutor(tools.manager)
		executor.setStepAllowedTools(['read_only', 'mcp_fetch', 'deep_search'])
		tools.remove('mcp_fetch')
		// Registered after the step's list was taken: in the registry, and not
		// on the list.
		tools.add(tool('late_arrival'))

		const refused = await call(executor, 'danger')
		expect(refused.output).toContain('not available on this step')
		const unknown = await call(executor, 'no_such_tool')
		expect(unknown.output).toContain('Unknown tool "no_such_tool"')

		// `mcp_fetch` is on the step's list and no longer registered;
		// `deep_search` is on it and deferred, which the executor refuses too;
		// `danger` and `late_arrival` are registered and withheld.
		expect(advertised(refused.output)).toEqual(['read_only'])
		expect(advertised(unknown.output)).toEqual(['read_only'])

		for (const name of advertised(unknown.output) ?? []) {
			const followed = await call(executor, name)
			expect(followed.isError, `${name} was advertised and then failed`).toBe(false)
		}
	})

	it('lists every active tool when the step is not narrowed', async () => {
		const tools = liveTools([tool('read_only'), tool('danger')], [tool('deep_search')])
		const executor = makeExecutor(tools.manager)

		const unknown = await call(executor, 'no_such_tool')

		expect(advertised(unknown.output)).toEqual(['read_only', 'danger'])
	})

	it('answers an unknown name the same way on a batch that was not prepared first', async () => {
		const tools = liveTools([tool('read_only'), tool('danger')])
		const executor = makeExecutor(tools.manager)
		executor.setStepAllowedTools(['read_only'])

		const batch = await executor.executeBatch(response('no_such_tool'))

		expect(batch.results[0]?.isError).toBe(true)
		expect(advertised(batch.results[0]?.output ?? '')).toEqual(['read_only'])
	})

	it('answers a nested call to an unknown name with the step list too', async () => {
		let nested = ''
		const tools = liveTools([
			tool('program', async (_input, context) => {
				const result = await context.dispatchTool?.('no_such_tool', {})
				nested = result?.error ?? ''
				return { success: true, output: 'program ran' }
			}),
			tool('read_only'),
			tool('danger'),
		])
		const executor = makeExecutor(tools.manager)
		executor.setStepAllowedTools(['program', 'read_only'])

		await call(executor, 'program')

		expect(nested).toContain('Unknown tool "no_such_tool"')
		expect(advertised(nested)).toEqual(['program', 'read_only'])
	})
})
