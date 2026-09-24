import { describe, expect, it } from 'vitest'

import { isTrustedReadOnly } from '../tools/trusted-read-only.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { liveToolset, tool } from './__fixtures__/toolsets.js'
import { combineToolsets } from './combine.js'
import { toolset } from './toolset.js'
import type { ToolSourceRef } from './types.js'
import {
	deferred,
	filtered,
	mapTools,
	prefixed,
	renamed,
	requireApproval,
	withMetadata,
} from './wrappers.js'

describe('prefixed', () => {
	it('prepends the prefix to every tool name', () => {
		const ts = prefixed(toolset('demo', [tool('read'), tool('write')]), 'demo__')
		expect(ts.tools().map((t) => t.name)).toEqual(['demo__read', 'demo__write'])
	})

	it('keeps the inner source', () => {
		const inner = toolset('demo', [tool('read')])
		expect(prefixed(inner, 'demo__').source).toBe(inner.source)
	})

	it('keeps execute identity and every other field', () => {
		const original = tool('read', { tier: 'default', permissions: ['file_read'] })
		const wrapped = prefixed(toolset('demo', [original]), 'demo__').tools()[0]!
		expect(wrapped.execute).toBe(original.execute)
		expect(wrapped.tier).toBe('default')
		expect(wrapped.permissions).toEqual(['file_read'])
		expect(wrapped.name).toBe('demo__read')
	})
})

describe('renamed', () => {
	it('renames only the tools listed, by name', () => {
		const ts = renamed(toolset('demo', [tool('read'), tool('write')]), { read: 'get_file' })
		expect(ts.tools().map((t) => t.name)).toEqual(['get_file', 'write'])
	})

	it('keeps execute identity and every other field on a renamed tool', () => {
		const original = tool('read', { category: 'filesystem' })
		const wrapped = renamed(toolset('demo', [original]), { read: 'get_file' }).tools()[0]!
		expect(wrapped.execute).toBe(original.execute)
		expect(wrapped.category).toBe('filesystem')
	})
})

describe('filtered', () => {
	it('keeps only the named tools, by an array selector', () => {
		const ts = filtered(toolset('demo', [tool('read'), tool('write'), tool('bash')]), [
			'read',
			'bash',
		])
		expect(ts.tools().map((t) => t.name)).toEqual(['read', 'bash'])
	})

	it('keeps only tools a predicate admits', () => {
		const ts = filtered(toolset('demo', [tool('read'), tool('write')]), (t) => t.name === 'write')
		expect(ts.tools().map((t) => t.name)).toEqual(['write'])
	})

	it('matches metadata by deep-including the selector pattern', () => {
		const ts = filtered(
			toolset('demo', [
				tool('read', { metadata: { stage: 'experimental', team: 'infra' } }),
				tool('write', { metadata: { stage: 'stable' } }),
				tool('bash'),
			]),
			{ metadata: { stage: 'experimental' } },
		)
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})

	it('matches nested metadata objects recursively', () => {
		const ts = filtered(
			toolset('demo', [
				tool('read', { metadata: { limits: { maxBytes: 10 } } }),
				tool('write', { metadata: { limits: { maxBytes: 20 } } }),
			]),
			{ metadata: { limits: { maxBytes: 10 } } },
		)
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})

	it('matches array-valued metadata elementwise, not by reference', () => {
		const ts = filtered(
			toolset('demo', [
				tool('read', { metadata: { tags: ['experimental', 'infra'] } }),
				tool('write', { metadata: { tags: ['stable'] } }),
			]),
			{ metadata: { tags: ['experimental', 'infra'] } },
		)
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})

	it('rejects arrays of different length or with a mismatched element', () => {
		const ts = filtered(
			toolset('demo', [
				tool('shorter', { metadata: { tags: ['experimental'] } }),
				tool('mismatched', { metadata: { tags: ['stable', 'infra'] } }),
				tool('match', { metadata: { tags: ['experimental', 'infra'] } }),
			]),
			{ metadata: { tags: ['experimental', 'infra'] } },
		)
		expect(ts.tools().map((t) => t.name)).toEqual(['match'])
	})

	it('matches nested objects inside array elements recursively', () => {
		const ts = filtered(
			toolset('demo', [
				tool('read', { metadata: { limits: [{ maxBytes: 10 }] } }),
				tool('write', { metadata: { limits: [{ maxBytes: 20 }] } }),
			]),
			{ metadata: { limits: [{ maxBytes: 10 }] } },
		)
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})

	it("keeps every tool when the toolset's own source id matches a glob, none otherwise", () => {
		const mcpSource = { id: 'mcp:github', kind: 'mcp_server' as const, name: 'GitHub' }
		const kept = filtered(toolset(mcpSource, [tool('a'), tool('b')]), { sourceIdGlob: 'mcp:*' })
		expect(kept.tools().map((t) => t.name)).toEqual(['a', 'b'])

		const droppedSource = { id: 'plugin:acme', kind: 'plugin' as const, name: 'acme' }
		const dropped = filtered(toolset(droppedSource, [tool('a')]), { sourceIdGlob: 'mcp:*' })
		expect(dropped.tools()).toEqual([])
	})

	it('re-derives lazily: a change visible in the inner toolset is visible through the filter without re-wrapping', () => {
		const live = liveToolset('mcp:github', [tool('read')])
		const ts = filtered(live.toolset, ['read', 'write'])
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
		live.setTools([tool('read'), tool('write')])
		expect(ts.tools().map((t) => t.name)).toEqual(['read', 'write'])
	})

	it('hands a function predicate the toolset it was called on, not the tool itself', () => {
		const mcpSource = {
			id: 'mcp:github',
			kind: 'mcp_server' as const,
			name: 'GitHub',
			mcpServer: { name: 'GitHub', readOnlyHintTrusted: true },
		}
		const ts = filtered(toolset(mcpSource, [tool('read')]), (_tool, source) => {
			expect(source).toEqual({
				id: 'mcp:github',
				kind: 'mcp_server',
				server: 'GitHub',
				readOnlyHintTrusted: true,
			})
			return true
		})
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})

	describe('the read-only recipe (tools/roster.ts, agents/explore.ts)', () => {
		// `isTrustedReadOnly(tool, undefined, source)` is what `roster.ts` and
		// `explore.ts` document a host copying to build a read-only-only
		// delegate roster. The regression this guards: applying that recipe
		// to a toolset ALREADY merged from several sources (an untrusted MCP
		// server among them) must not let the untrusted server's own
		// `readOnlyHint: true` through — because a `filtered` predicate is
		// handed the ONE toolset it runs on, `filtered` must run before
		// `combineToolsets`, on each contributing toolset, not after.
		const readOnlyOnly = (t: ToolDefinition, source: ToolSourceRef) =>
			isTrustedReadOnly(t, undefined, source)

		it('excludes an untrusted MCP tool when each source toolset is filtered before combining', () => {
			const hostSource = { id: 'host', kind: 'host_tool' as const, name: 'host' }
			const untrustedMcp = {
				id: 'mcp:untrusted-server',
				kind: 'mcp_server' as const,
				name: 'untrusted-server',
				mcpServer: { name: 'untrusted-server', readOnlyHintTrusted: false },
			}
			const hostToolset = toolset(hostSource, [tool('read_file', { isReadOnly: () => true })])
			const untrustedToolset = toolset(untrustedMcp, [
				tool('mcp_delete_everything', { isReadOnly: () => true }),
			])

			const roster = combineToolsets('delegate', [
				filtered(hostToolset, readOnlyOnly),
				filtered(untrustedToolset, readOnlyOnly),
			])

			expect(roster.tools().map((t) => t.name)).toEqual(['read_file'])
		})

		it('wrongly admits the untrusted tool if filtered runs AFTER combining instead — the anti-pattern this recipe warns against', () => {
			const hostSource = { id: 'host', kind: 'host_tool' as const, name: 'host' }
			const untrustedMcp = {
				id: 'mcp:untrusted-server',
				kind: 'mcp_server' as const,
				name: 'untrusted-server',
				mcpServer: { name: 'untrusted-server', readOnlyHintTrusted: false },
			}
			const combined = combineToolsets('parent', [
				toolset(hostSource, [tool('read_file', { isReadOnly: () => true })]),
				toolset(untrustedMcp, [tool('mcp_delete_everything', { isReadOnly: () => true })]),
			])

			// `combined.source` is the umbrella `parent` source, kind
			// `host_tool` — so the untrusted contributor's own source is
			// invisible here, and this is exactly what `roster.ts` says not
			// to do.
			const roster = filtered(combined, readOnlyOnly)

			expect(roster.tools().map((t) => t.name)).toEqual(['read_file', 'mcp_delete_everything'])
		})
	})
})

describe('deferred', () => {
	it('sets availability to deferred without touching the tools', () => {
		const ts = deferred(toolset('demo', [tool('read')]))
		expect(ts.availability).toBe('deferred')
		expect(ts.tools().map((t) => t.name)).toEqual(['read'])
	})
})

describe('requireApproval', () => {
	it('sets requiresApproval on every tool when no selector is given', () => {
		const ts = requireApproval(toolset('demo', [tool('read'), tool('write')]))
		expect(ts.tools().every((t) => t.requiresApproval?.(undefined) === true)).toBe(true)
	})

	it('sets requiresApproval only on the tools a selector admits', () => {
		const ts = requireApproval(toolset('demo', [tool('read'), tool('write')]), ['write'])
		const byName = Object.fromEntries(ts.tools().map((t) => [t.name, t.requiresApproval]))
		expect(byName.read).toBeUndefined()
		expect(byName.write?.(undefined)).toBe(true)
	})

	it('keeps a mapped definition stable until the source replaces it', () => {
		let current = tool('write')
		const live = {
			source: { id: 'demo', kind: 'host_tool' as const, name: 'demo' },
			tools: () => [current],
		}
		const wrapped = requireApproval(live)
		const first = wrapped.tools()[0]
		expect(wrapped.tools()[0]).toBe(first)
		current = tool('write')
		expect(wrapped.tools()[0]).not.toBe(first)
	})
})

describe('withMetadata', () => {
	it('merges metadata onto every tool, keeping what was already there', () => {
		const ts = withMetadata(toolset('demo', [tool('read', { metadata: { team: 'infra' } })]), {
			stage: 'experimental',
		})
		expect(ts.tools()[0]!.metadata).toEqual({ team: 'infra', stage: 'experimental' })
	})

	it('a later key overwrites an earlier one with the same name', () => {
		const ts = withMetadata(toolset('demo', [tool('read', { metadata: { stage: 'stable' } })]), {
			stage: 'experimental',
		})
		expect(ts.tools()[0]!.metadata).toEqual({ stage: 'experimental' })
	})
})

describe('mapTools', () => {
	it('applies an arbitrary transform to every tool', () => {
		const ts = mapTools(toolset('demo', [tool('read')]), (t) => ({ ...t, description: 'x' }))
		expect(ts.tools()[0]!.description).toBe('x')
	})
})

describe('composition order', () => {
	it('applies wrappers in the order they are written', () => {
		const base = toolset('demo', [tool('read')])
		const ts = prefixed(renamed(base, { read: 'get_file' }), 'demo__')
		expect(ts.tools().map((t) => t.name)).toEqual(['demo__get_file'])
	})

	it('the reverse order produces a different name', () => {
		const base = toolset('demo', [tool('read')])
		const ts = renamed(prefixed(base, 'demo__'), { read: 'get_file' })
		// renamed's map key is the ORIGINAL name "read", which prefixed already
		// changed to "demo__read" by the time renamed sees it, so it misses.
		expect(ts.tools().map((t) => t.name)).toEqual(['demo__read'])
	})
})

describe('onChange propagation through a wrapper', () => {
	it('forwards a change from the inner toolset to a listener on the wrapped one', () => {
		const live = liveToolset('mcp:github', [tool('read')])
		const wrapped = prefixed(live.toolset, 'gh__')
		let notified = 0
		const unsubscribe = wrapped.onChange?.(() => {
			notified += 1
		})
		expect(typeof unsubscribe).toBe('function')
		live.setTools([tool('read'), tool('write')])
		expect(notified).toBe(1)
		expect(wrapped.tools().map((t) => t.name)).toEqual(['gh__read', 'gh__write'])
	})

	it('unsubscribing at the wrapper cleans up the inner subscription', () => {
		const live = liveToolset('mcp:github', [tool('read')])
		const wrapped = deferred(live.toolset)
		const unsubscribe = wrapped.onChange?.(() => {})
		expect(live.listenerCount()).toBe(1)
		unsubscribe?.()
		expect(live.listenerCount()).toBe(0)
	})

	it('has no onChange when the inner toolset has none', () => {
		const ts = prefixed(toolset('demo', [tool('read')]), 'x__')
		expect(ts.onChange).toBeUndefined()
	})
})

describe('close', () => {
	it('forwards close to the inner toolset', async () => {
		const live = liveToolset('mcp:github', [tool('read')])
		const wrapped = prefixed(live.toolset, 'gh__')
		await wrapped.close?.()
		expect(live.closeCalls()).toBe(1)
	})
})
