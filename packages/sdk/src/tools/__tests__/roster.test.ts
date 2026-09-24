/**
 * A narrower roster is the source minus something, never plus.
 *
 * Read-only is decided by the same predicate the gate uses, so a connected
 * server's tool that only claims to be read-only stays out; an allowlist
 * naming a tool the source does not carry adds nothing.
 */

import { describe, expect, it } from 'vitest'

import { z } from 'zod'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { getBuiltinTools } from '../builtins/index.js'
import { defineTool } from '../defineTool.js'
import { filterReadOnlyTools, filterToolsNamed, matchesToolSelector } from '../roster.js'

function builtins(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(getBuiltinTools())
	return registry
}

describe('filterReadOnlyTools', () => {
	it('keeps the builtins that declare themselves read-only and drops the rest', () => {
		const names = filterReadOnlyTools(builtins()).listNames().sort()
		expect(names).toContain('read')
		expect(names).toContain('grep')
		expect(names).toContain('glob')
		for (const mutating of ['write', 'edit', 'bash']) expect(names).not.toContain(mutating)
	})

	it('does not trust a claim from untrusted provenance', () => {
		const registry = new ToolRegistry()
		const claims = defineTool({
			name: 'remote_peek',
			description: 'says it only reads',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				return { success: true, output: '' }
			},
		})
		registry.register({
			...claims,
			provenance: { server: 'peer', readOnlyHintTrusted: false },
		})
		expect(filterReadOnlyTools(registry).listNames()).toEqual([])
	})
})

describe('filterToolsNamed', () => {
	it('intersects: listed-and-present stays, listed-but-absent adds nothing', () => {
		const names = filterToolsNamed(builtins(), ['read', 'bash', 'not-a-real-tool'])
			.listNames()
			.sort()
		expect(names).toEqual(['bash', 'read'])
	})
})

function toolWithMetadata(metadata?: Readonly<Record<string, unknown>>): ToolDefinition {
	return {
		name: 'search_docs',
		category: 'analysis',
		isReadOnly: () => true,
		isDestructive: () => false,
		isConcurrencySafe: () => true,
		...(metadata !== undefined ? { metadata } : {}),
	} as unknown as ToolDefinition
}

describe('matchesToolSelector', () => {
	it('matches a name list by exact name', () => {
		const tool = toolWithMetadata()
		expect(matchesToolSelector(['search_docs', 'other'], tool)).toBe(true)
		expect(matchesToolSelector(['other'], tool)).toBe(false)
	})

	it('matches a predicate', () => {
		const tool = toolWithMetadata()
		expect(matchesToolSelector((t) => t.name.startsWith('search_'), tool)).toBe(true)
		expect(matchesToolSelector((t) => t.name.startsWith('write_'), tool)).toBe(false)
	})

	it('matches metadata as a partial, deep-equal subset', () => {
		const tool = toolWithMetadata({ tag: 'experimental', source: { team: 'search', tier: 2 } })
		expect(matchesToolSelector({ tag: 'experimental' }, tool)).toBe(true)
		expect(matchesToolSelector({ source: { team: 'search' } }, tool)).toBe(true)
		expect(matchesToolSelector({ source: { team: 'search', tier: 2 } }, tool)).toBe(true)
		// A value that disagrees, or a key the tool's metadata does not carry,
		// fails the match.
		expect(matchesToolSelector({ tag: 'stable' }, tool)).toBe(false)
		expect(matchesToolSelector({ missing: true }, tool)).toBe(false)
		expect(matchesToolSelector({ source: { team: 'search', tier: 3 } }, tool)).toBe(false)
	})

	it('an empty metadata selector matches every tool', () => {
		expect(matchesToolSelector({}, toolWithMetadata())).toBe(true)
		expect(matchesToolSelector({}, toolWithMetadata({ tag: 'x' }))).toBe(true)
	})

	it('a metadata selector never matches a tool with no metadata at all', () => {
		expect(matchesToolSelector({ tag: 'experimental' }, toolWithMetadata())).toBe(false)
	})
})
