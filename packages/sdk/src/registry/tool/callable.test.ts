import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { testToolset } from '../../test-support/toolset.js'
import { ToolManager } from '../../toolsets/manager.js'
import { deferred } from '../../toolsets/wrappers.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { callableToolNames, formatToolNames } from './callable.js'

function tool(name: string): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		async execute() {
			return { success: true, output: `${name} ran` }
		},
	} as unknown as ToolDefinition
}

function registry(): ToolManager {
	return new ToolManager({
		toolsets: [
			testToolset(tool('read'), tool('write'), tool('bash')),
			deferred(testToolset(tool('deep_search'))),
		],
		messages: () => [],
	})
}

describe('callableToolNames', () => {
	it('is every active tool, in registry order, when nothing narrowed the step', () => {
		expect(callableToolNames(registry(), undefined)).toEqual(['read', 'write', 'bash'])
	})

	it('keeps the registry order, not the order the list was written in', () => {
		expect(callableToolNames(registry(), ['bash', 'read'])).toEqual(['read', 'bash'])
	})

	it('drops a listed name the registry no longer holds', () => {
		// `availability` answers 'active' for a name it has never seen, so
		// filtering the list by availability alone would keep it.
		expect(callableToolNames(registry(), ['read', 'gone'])).toEqual(['read'])
	})

	it('drops a listed tool that is deferred', () => {
		const r = registry()
		expect(callableToolNames(r, ['read', 'deep_search'])).toEqual(['read'])
	})

	it('is empty for a step that may call nothing', () => {
		expect(callableToolNames(registry(), [])).toEqual([])
	})
})

describe('formatToolNames', () => {
	it('joins names, and says "(none)" rather than nothing', () => {
		expect(formatToolNames(['read', 'bash'])).toBe('read, bash')
		expect(formatToolNames([])).toBe('(none)')
	})
})
