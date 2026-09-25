import { describe, expect, it } from 'vitest'

import { liveToolset, tool } from './__fixtures__/toolsets.js'
import { ToolsetConflictError, combineToolsets } from './combine.js'
import { ToolManager } from './manager.js'
import { toolset } from './toolset.js'
import { deferred, prefixed } from './wrappers.js'

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

	describe('availability', () => {
		it('has no availability field when combining plain (active) toolsets, same as one alone', () => {
			const combined = combineToolsets('all', [toolset('a', [tool('read')]), toolset('b', [])])
			expect(combined.availability).toBeUndefined()
		})

		it('reports "deferred" when every input agrees it is deferred', () => {
			const combined = combineToolsets('all', [
				deferred(toolset('a', [tool('read')])),
				deferred(toolset('b', [tool('write')])),
			])
			expect(combined.availability).toBe('deferred')
		})

		it('refuses to merge an active toolset with a deferred one', () => {
			// The bug this guards: a merged Toolset has exactly one
			// `availability` field, so silently combining a mix would report
			// the deferred side's tools as active — the read-only floor
			// `ToolManager.availability` provides would then never apply to
			// them. Refusing is what `runtime/query/index.ts` itself relies
			// on combineToolsets doing when a caller reintroduces the mix it
			// deliberately keeps as two separate array entries.
			const a = toolset('a', [tool('read')])
			const b = deferred(toolset('b', [tool('write')]))
			expect(() => combineToolsets('all', [a, b])).toThrow(/"a" is active and "b" is deferred/)
		})

		it('names the umbrella id and both disagreeing sources in the refusal', () => {
			const a = toolset('a', [tool('read')])
			const b = deferred(toolset('b', [tool('write')]))
			expect(() => combineToolsets('mixed-umbrella', [a, b])).toThrow(/mixed-umbrella/)
		})
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
			expect(
				combineToolsets('all', [a])
					.tools()
					.map((t) => t.name),
			).toEqual(['unique_a', 'read'])
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
			const combined = combineToolsets('all', [
				toolset('a', [tool('bash')]),
				prefixed(live.toolset, 'gh__'),
			])
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

		it('rolls back earlier subscriptions if a later source fails to subscribe', () => {
			const live = liveToolset('mcp:a', [tool('a1')])
			const failure = new Error('subscription failed')
			const broken = {
				...toolset('broken', []),
				onChange: () => {
					throw failure
				},
			}
			const combined = combineToolsets('all', [live.toolset, broken])
			let caught: unknown
			try {
				new ToolManager({ toolsets: [combined], messages: () => [] })
			} catch (error) {
				caught = error
			}
			expect(caught).toBe(failure)
			expect(live.listenerCount()).toBe(0)
		})

		it('releases every inner listener even if one unsubscribe throws', () => {
			const live = liveToolset('mcp:a', [tool('a1')])
			const broken = {
				...toolset('broken', []),
				onChange: () => () => {
					throw new Error('unsubscribe failed')
				},
			}
			const manager = new ToolManager({
				toolsets: [combineToolsets('all', [live.toolset, broken])],
				messages: () => [],
			})
			expect(live.listenerCount()).toBe(1)
			expect(() => manager.dispose()).not.toThrow()
			expect(live.listenerCount()).toBe(0)
		})

		it('has no onChange when none of the inner toolsets have one', () => {
			const combined = combineToolsets('all', [
				toolset('a', [tool('a1')]),
				toolset('b', [tool('b1')]),
			])
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
