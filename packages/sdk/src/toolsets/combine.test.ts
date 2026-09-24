import { describe, expect, it } from 'vitest'

import { liveToolset, tool } from './__fixtures__/toolsets.js'
import { ToolsetConflictError, combineToolsets } from './combine.js'
import { toolset } from './toolset.js'
import { prefixed } from './wrappers.js'

describe('combineToolsets', () => {
	it('merges tools from every toolset, in toolset order then tool order', () => {
		const a = toolset('a', [tool('read'), tool('write')])
		const b = toolset('b', [tool('bash')])
		const combined = combineToolsets('all', [a, b])
		expect(combined.tools().map((t) => t.name)).toEqual(['read', 'write', 'bash'])
	})

	it('is deterministic across repeated calls', () => {
		const a = toolset('a', [tool('read'), tool('write')])
		const b = toolset('b', [tool('bash')])
		const combined = combineToolsets('all', [a, b])
		expect(combined.tools().map((t) => t.name)).toEqual(combined.tools().map((t) => t.name))
	})

	it('takes a string as shorthand for a host_tool umbrella source', () => {
		const combined = combineToolsets('all', [toolset('a', [])])
		expect(combined.source).toEqual({ id: 'all', kind: 'host_tool', name: 'all' })
	})

	it('keeps a full ToolSource exactly as given', () => {
		const source = { id: 'mcp:all', kind: 'mcp_server' as const, name: 'All' }
		const combined = combineToolsets(source, [toolset('a', [])])
		expect(combined.source).toBe(source)
	})

	describe('conflict detection', () => {
		it('throws ToolsetConflictError when two different toolsets contribute the same name', () => {
			const a = toolset('a', [tool('read')])
			const b = toolset('b', [tool('read')])
			const combined = combineToolsets('all', [a, b])
			expect(() => combined.tools()).toThrow(ToolsetConflictError)
		})

		it('names both sources in the error', () => {
			const a = toolset('a', [tool('read')])
			const b = toolset('b', [tool('read')])
			try {
				combineToolsets('all', [a, b]).tools()
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(ToolsetConflictError)
				const conflict = error as ToolsetConflictError
				expect(conflict.toolName).toBe('read')
				expect(conflict.firstSource.id).toBe('a')
				expect(conflict.secondSource.id).toBe('b')
				expect(conflict.message).toContain('"a"')
				expect(conflict.message).toContain('"b"')
				expect(conflict.message).toContain('prefixed')
			}
		})

		it('throws when ONE toolset contributes the same name twice (within, not just across)', () => {
			const a = toolset('a', [tool('read'), tool('read')])
			expect(() => combineToolsets('all', [a]).tools()).toThrow(ToolsetConflictError)
		})

		it('is atomic: a conflict leaves no partial merge for the caller to see', () => {
			const a = toolset('a', [tool('unique_a'), tool('read')])
			const b = toolset('b', [tool('read')])
			const combined = combineToolsets('all', [a, b])
			expect(() => combined.tools()).toThrow(ToolsetConflictError)
			// The thrown call produced nothing observable; a fresh call over
			// non-conflicting inputs proves the combinator itself still works.
			expect(combineToolsets('all', [a]).tools().map((t) => t.name)).toEqual(['unique_a', 'read'])
		})

		it('a conflict is avoided by prefixing one contributor first', () => {
			const a = toolset('a', [tool('read')])
			const b = toolset('b', [tool('read')])
			const combined = combineToolsets('all', [a, prefixed(b, 'b__')])
			expect(combined.tools().map((t) => t.name)).toEqual(['read', 'b__read'])
		})
	})

	describe('onChange propagation through combine', () => {
		it('notifies the outer listener when an inner toolset (one layer deeper still) changes', () => {
			const live = liveToolset('mcp:github', [tool('read')])
			const combined = combineToolsets('all', [toolset('a', [tool('bash')]), prefixed(live.toolset, 'gh__')])
			let notified = 0
			combined.onChange?.(() => {
				notified += 1
			})
			live.setTools([tool('read'), tool('write')])
			expect(notified).toBe(1)
			expect(combined.tools().map((t) => t.name)).toEqual(['bash', 'gh__read', 'gh__write'])
		})

		it('unsubscribing at combine cleans up every inner subscription', () => {
			const liveA = liveToolset('mcp:a', [tool('a1')])
			const liveB = liveToolset('mcp:b', [tool('b1')])
			const combined = combineToolsets('all', [liveA.toolset, liveB.toolset])
			const unsubscribe = combined.onChange?.(() => {})
			expect(liveA.listenerCount()).toBe(1)
			expect(liveB.listenerCount()).toBe(1)
			unsubscribe?.()
			expect(liveA.listenerCount()).toBe(0)
			expect(liveB.listenerCount()).toBe(0)
		})

		it('has no onChange when none of the inner toolsets have one', () => {
			const combined = combineToolsets('all', [toolset('a', [tool('a1')]), toolset('b', [tool('b1')])])
			expect(combined.onChange).toBeUndefined()
		})
	})

	describe('close', () => {
		it('closes every closable inner toolset', async () => {
			const liveA = liveToolset('mcp:a', [tool('a1')])
			const liveB = liveToolset('mcp:b', [tool('b1')])
			const combined = combineToolsets('all', [liveA.toolset, liveB.toolset])
			await combined.close?.()
			expect(liveA.closeCalls()).toBe(1)
			expect(liveB.closeCalls()).toBe(1)
		})

		it('has no close when none of the inner toolsets have one', () => {
			const combined = combineToolsets('all', [toolset('a', [tool('a1')])])
			expect(combined.close).toBeUndefined()
		})
	})
})
