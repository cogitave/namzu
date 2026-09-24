/**
 * A narrower roster is the source minus something, never plus.
 *
 * Read-only is decided by the same predicate the gate uses, so a connected
 * server's tool that only claims to be read-only stays out; an allowlist
 * naming a tool the source does not carry adds nothing.
 */

import { describe, expect, it } from 'vitest'

import { z } from 'zod'
import { testToolset } from '../../test-support/toolset.js'
import { toolset } from '../../toolsets/toolset.js'
import type { Toolset } from '../../toolsets/types.js'
import { filtered } from '../../toolsets/wrappers.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { getBuiltinTools } from '../builtins/index.js'
import { defineTool } from '../defineTool.js'
import { matchesToolSelector } from '../roster.js'
import { isTrustedReadOnly } from '../trusted-read-only.js'

function builtins(): Toolset {
	return testToolset(...getBuiltinTools())
}

describe('read-only toolset filtering', () => {
	it('keeps the builtins that declare themselves read-only and drops the rest', () => {
		const names = filtered(builtins(), (tool, source) => isTrustedReadOnly(tool, undefined, source))
			.tools()
			.map((tool) => tool.name)
			.sort()
		expect(names).toContain('read')
		expect(names).toContain('grep')
		expect(names).toContain('glob')
		for (const mutating of ['write', 'edit', 'bash']) expect(names).not.toContain(mutating)
	})

	it('does not trust a claim from untrusted provenance', () => {
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
		const source = toolset(
			{
				id: 'peer',
				kind: 'mcp_server',
				name: 'peer',
				mcpServer: { name: 'peer', readOnlyHintTrusted: false },
			},
			[claims],
		)
		expect(
			filtered(source, (tool, owner) => isTrustedReadOnly(tool, undefined, owner)).tools(),
		).toEqual([])
	})
})

describe('name filtering', () => {
	it('intersects: listed-and-present stays, listed-but-absent adds nothing', () => {
		const names = filtered(builtins(), ['read', 'bash', 'not-a-real-tool'])
			.tools()
			.map((tool) => tool.name)
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
