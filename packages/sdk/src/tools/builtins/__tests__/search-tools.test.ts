import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import { deferred } from '../../../toolsets/wrappers.js'
import { type Message, createToolMessage } from '../../../types/message/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
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

function context(toolRegistry: ToolManager, allowedTools?: readonly string[]): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		toolRegistry,
		...(allowedTools !== undefined ? { allowedTools } : {}),
	}
}

function managerWith(...tools: ReturnType<typeof tool>[]) {
	const messages: Message[] = []
	const manager = new ToolManager({
		toolsets: [deferred(testToolset(...tools))],
		messages: () => messages,
	})
	return { manager, messages }
}

describe('search_tools receipts', () => {
	it('reveals only the exact deferred name for a generic tool word', async () => {
		const { manager, messages } = managerWith(
			tool('read'),
			tool('read_something', 'Use read to inspect a record.'),
			tool('unrelated', 'A capability that mentions read.'),
		)
		const result = await SearchToolsTool.execute({ query: ' READ ' }, context(manager))

		expect(result.data).toEqual({ activated: ['read'], count: 1, nearMisses: [] })
		expect(result.reveals).toEqual(['read'])
		expect(manager.availability('read')).toBe('deferred')
		messages.push(createToolMessage(result.output, 'search-read', false, result.reveals))
		expect(manager.availability('read')).toBe('active')
		expect(manager.availability('read_something')).toBe('deferred')
		const second = await SearchToolsTool.execute({ query: 'READ' }, context(manager))
		expect(second.output).toContain('No deferred tools matching')
	})

	it('does not reveal a forbidden deferred tool', async () => {
		const { manager } = managerWith(tool('invoice_lookup'))
		const result = await SearchToolsTool.execute({ query: 'invoice' }, context(manager, []))
		expect(result.output).toContain('No deferred tools matching')
		expect(result.output).not.toContain('invoice_lookup')
		expect(result.reveals).toBeUndefined()
		expect(manager.availability('invoice_lookup')).toBe('deferred')
	})

	it('finds deferred capabilities by description and argument name', async () => {
		const { manager } = managerWith(tool('billing_details', 'Inspect invoices for a customer.'))
		for (const query of ['invoices', 'accountId']) {
			const result = await SearchToolsTool.execute({ query }, context(manager))
			expect(result.reveals).toEqual(['billing_details'])
		}
	})

	it('bounds loaded tools and reports the remaining matches without revealing them', async () => {
		const names = Array.from({ length: 8 }, (_, index) => `invoice_${index}`)
		const { manager } = managerWith(...names.map((name) => tool(name)))
		const result = await SearchToolsTool.execute({ query: 'invoice' }, context(manager))
		expect(result.reveals).toEqual(names.slice(0, 5))
		expect(result.data).toEqual({
			activated: names.slice(0, 5),
			count: 5,
			nearMisses: names.slice(5),
		})
		expect(result.output).toContain('Also matched but NOT loaded')
		expect(manager.availability(names[5] as string)).toBe('deferred')
	})
})
