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
import { getBuiltinTools } from '../builtins/index.js'
import { defineTool } from '../defineTool.js'
import { filterReadOnlyTools, filterToolsNamed } from '../roster.js'

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
