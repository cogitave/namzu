import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { testToolset } from '../../test-support/toolset.js'
import { ToolManager } from '../../toolsets/manager.js'
import { deferred } from '../../toolsets/wrappers.js'
import type { Message } from '../../types/message/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { clearStaleToolResults } from '../tool-result-editing.js'

/**
 * A model that loaded a tool and then lost the result that said so searched
 * for it again ("Already loaded"). The load is recorded on the message, so
 * clearing output never unloads a tool; and a search result is never cleared.
 */

const lateTool: ToolDefinition = {
	name: 'late_tool',
	description: 'Do the late thing.',
	inputSchema: z.object({}),
	execute: async () => ({ success: true, output: 'ok' }),
}

function history(): Message[] {
	return [
		{ role: 'user', content: 'go' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: 's1', type: 'function', function: { name: 'search_tools', arguments: '{}' } },
			],
		},
		{
			role: 'tool',
			toolCallId: 's1',
			content: `Activated 1 tool(s):\n- late_tool: ${'Do the late thing. '.repeat(120)}`,
			revealedTools: [{ name: 'late_tool', sourceId: 'test', sourceKind: 'host_tool' }],
		},
		{ role: 'user', content: 'next' },
	] as Message[]
}

describe('an activated tool after clearing', () => {
	it('keeps the search result as it was and the tool loaded', () => {
		const messages = history()
		const out = clearStaleToolResults(messages, { keepRecentToolResults: 0, minCharsToClear: 100 })
		expect(out.clearedCount).toBe(0)
		expect(out.messages[2]).toBe(messages[2])
	})

	it('stays loaded even when its result is cleared by another rule', () => {
		const messages = history()
		const manager = new ToolManager({
			toolsets: [deferred(testToolset(lateTool))],
			messages: () => messages,
		})
		expect(manager.availability('late_tool')).toBe('active')
		const bare = new ToolManager({
			toolsets: [deferred(testToolset(lateTool))],
			messages: () => [],
		})
		expect(bare.availability('late_tool')).toBe('deferred')
	})
})
