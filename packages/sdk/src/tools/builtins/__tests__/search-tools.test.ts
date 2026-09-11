import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { ToolContext, ToolRegistryRef } from '../../../types/tool/index.js'
import { defineTool } from '../../defineTool.js'
import { SearchToolsTool } from '../search-tools.js'

function tool(name: string, description = 'Fixture capability.') {
	return defineTool({
		name,
		description,
		inputSchema: z.object({ accountId: z.string() }),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			return { success: true, output: 'ok' }
		},
	})
}

function context(toolRegistry: ToolRegistryRef, allowedTools?: readonly string[]): ToolContext {
	return {
		runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['runId'],
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		toolRegistry,
		...(allowedTools !== undefined ? { allowedTools } : {}),
	}
}

describe('search_tools receipts', () => {
	it('does not mistake an unknown name for an already-active tool', async () => {
		const registry = new ToolRegistry()
		registry.register(tool('inspect_document'))
		registry.register(tool('edit_document'), 'deferred')
		// Availability alone cannot establish existence: unknown names default to active.
		expect(registry.getAvailability('nonexistent_capability')).toBe('active')
		const result = await SearchToolsTool.execute(
			{ query: 'nonexistent_capability' },
			context(registry),
		)
		expect(result).toMatchObject({ success: true })
		expect(result.output).toContain('No matching active tools were found.')
		expect(result.output).not.toContain('already active')
		expect(registry.getAvailability('edit_document')).toBe('deferred')
	})

	it.each(['read', 'ls'])(
		'recognizes the exact active name %s without broad generic matching',
		async (name) => {
			const registry = new ToolRegistry()
			registry.register(tool(name))
			registry.register(tool(`${name}_something`))
			const result = await SearchToolsTool.execute({ query: name.toUpperCase() }, context(registry))
			expect(result.output).toContain(`Already active matching tools (up to 5):\n- ${name}`)
			expect(result.output).not.toContain(`${name}_something`)
		},
	)

	it.each(['read', 'ls', 'search'])(
		'loads the exact deferred name %s without activating generic matches',
		async (name) => {
			const registry = new ToolRegistry()
			registry.register(tool(name), 'deferred')
			registry.register(tool(`${name}_something`, `Use ${name} to inspect a record.`), 'deferred')
			registry.register(tool('unrelated', `A capability that mentions ${name}.`), 'deferred')
			const result = await SearchToolsTool.execute(
				{ query: ` ${name.toUpperCase()} ` },
				context(registry),
			)
			expect(result.data).toEqual({ activated: [name], count: 1, nearMisses: [] })
			expect(registry.getAvailability(name)).toBe('active')
			expect(registry.getAvailability(`${name}_something`)).toBe('deferred')
			expect(registry.getAvailability('unrelated')).toBe('deferred')
		},
	)

	it('does not reveal or activate a forbidden exact deferred name', async () => {
		const registry = new ToolRegistry()
		registry.register(tool('read'), 'deferred')
		registry.register(tool('permitted'))
		const result = await SearchToolsTool.execute(
			{ query: 'read' },
			context(registry, ['permitted']),
		)
		expect(result.output).toContain('No matching active tools were found.')
		expect(result.data).toBeUndefined()
		expect(registry.getAvailability('read')).toBe('deferred')
	})

	it.each(['invoices', 'accountId'])(
		'finds active capabilities by description or schema: %s',
		async (query) => {
			const registry = new ToolRegistry()
			registry.register(tool('billing_details', 'Inspect invoices for a customer.'))
			const activate = vi.spyOn(registry, 'activate')
			const result = await SearchToolsTool.execute({ query }, context(registry))
			expect(result.output).toContain('Already active matching tools (up to 5):\n- billing_details')
			expect(activate).not.toHaveBeenCalled()
		},
	)

	it('does not reveal forbidden active/deferred matches or suspended matches', async () => {
		const registry = new ToolRegistry()
		registry.register(tool('private_active', 'Needle capability.'))
		registry.register(tool('private_deferred', 'Needle capability.'), 'deferred')
		registry.register(tool('unavailable', 'Needle capability.'), 'suspended')
		registry.register(tool('permitted', 'Unrelated capability.'))
		const activate = vi.spyOn(registry, 'activate')
		const result = await SearchToolsTool.execute(
			{ query: 'needle' },
			context(registry, ['permitted', 'unavailable']),
		)
		expect(result.output).toContain('No matching active tools were found.')
		for (const name of ['private_active', 'private_deferred', 'unavailable']) {
			expect(result.output).not.toContain(name)
		}
		expect(activate).not.toHaveBeenCalled()
		expect(registry.getAvailability('private_deferred')).toBe('deferred')
		expect(registry.getAvailability('unavailable')).toBe('suspended')
	})

	it('treats an explicit empty allowlist as no tool access', async () => {
		const registry = new ToolRegistry()
		registry.register(tool('invoice_active'))
		registry.register(tool('invoice_deferred'), 'deferred')
		const activate = vi.spyOn(registry, 'activate')
		const result = await SearchToolsTool.execute({ query: 'invoice' }, context(registry, []))
		expect(result.output).toContain('No matching active tools were found.')
		expect(result.output).not.toContain('invoice_active')
		expect(result.output).not.toContain('invoice_deferred')
		expect(activate).not.toHaveBeenCalled()
	})

	it('reports an activated tool as active on the next search', async () => {
		const registry = new ToolRegistry()
		registry.register(tool('invoice_lookup'), 'deferred')
		const activate = vi.spyOn(registry, 'activate')
		const first = await SearchToolsTool.execute({ query: 'invoice' }, context(registry))
		const second = await SearchToolsTool.execute({ query: 'invoice' }, context(registry))
		expect(first.data).toMatchObject({ activated: ['invoice_lookup'], count: 1, nearMisses: [] })
		expect(second.output).toContain('Already active matching tools (up to 5):\n- invoice_lookup')
		expect(activate).toHaveBeenCalledTimes(1)
	})

	it('bounds active results after filtering the permitted roster', async () => {
		const registry = new ToolRegistry()
		const names = Array.from({ length: 8 }, (_, index) => `invoice_${index}`)
		registry.register(names.map((name) => tool(name)))
		const result = await SearchToolsTool.execute(
			{ query: 'invoice' },
			context(registry, names.slice(1)),
		)
		expect(result.output.split('\n').slice(1)).toEqual(names.slice(1, 6).map((name) => `- ${name}`))
	})

	it('states the limitation when a custom registry cannot search active tools', async () => {
		const registry: ToolRegistryRef = {
			searchDeferred: () => [],
			activate: vi.fn(),
			getAvailability: () => 'active',
		}
		const result = await SearchToolsTool.execute({ query: 'invoice' }, context(registry))
		expect(result.output).toContain('This registry cannot search active tools.')
		expect(result.output).not.toContain('already active')
	})
})
