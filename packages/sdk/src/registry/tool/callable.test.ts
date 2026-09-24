import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolDefinition } from '../../types/tool/index.js'
import { callableToolNames, formatToolNames } from './callable.js'
import { ToolRegistry } from './execute.js'

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

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	r.register([tool('read'), tool('write'), tool('bash')])
	r.register([tool('deep_search')], 'deferred')
	return r
}

describe('callableToolNames', () => {
	it('is every active tool, in registry order, when nothing narrowed the step', () => {
		expect(callableToolNames(registry(), undefined)).toEqual(['read', 'write', 'bash'])
	})

	it('keeps the registry order, not the order the list was written in', () => {
		expect(callableToolNames(registry(), ['bash', 'read'])).toEqual(['read', 'bash'])
	})

	it('drops a listed name the registry no longer holds', () => {
		// `getAvailability` answers 'active' for a name it has never seen, so
		// filtering the list by availability alone would keep it.
		expect(callableToolNames(registry(), ['read', 'gone'])).toEqual(['read'])
	})

	it('drops a listed tool that is deferred or suspended', () => {
		const r = registry()
		expect(callableToolNames(r, ['read', 'deep_search'])).toEqual(['read'])
		r.suspendAll()
		expect(callableToolNames(r, ['read', 'deep_search'])).toEqual([])
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
