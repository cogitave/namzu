import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import { deferred } from '../../../toolsets/wrappers.js'
import { type Message, createToolMessage } from '../../../types/message/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { defineTool } from '../../defineTool.js'
import { SearchToolsTool } from '../search-tools.js'

function tool(name: string, description = 'Fixture capability.', loadsWith?: readonly string[]) {
	return defineTool({
		name,
		...(loadsWith ? { loadsWith } : {}),
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

		expect(result.data).toEqual({
			activated: ['read'],
			count: 1,
			nearMisses: [],
		})
		expect(result.reveals).toEqual(['read'])
		expect(manager.availability('read')).toBe('deferred')
		messages.push(
			createToolMessage(
				result.output,
				'search-read',
				false,
				result.reveals?.map((name) => manager.revealReceipt(name)),
			),
		)
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

	describe('companions', () => {
		const pair = () =>
			managerWith(
				tool('page_look', 'Look at the page.', ['page_act']),
				tool('page_act', 'Act on the page.', ['page_look']),
				tool('solo_tool', 'Works alone.'),
			)

		it('loads the companion with the tool and names it', async () => {
			const { manager } = pair()
			const result = await SearchToolsTool.execute({ query: 'page_look' }, context(manager))
			expect(result.reveals).toEqual(['page_look', 'page_act'])
			expect(result.output).toContain('page_act (loaded with page_look)')
			expect(result.data).toMatchObject({ companions: ['page_act'], count: 2 })
		})

		it('loads the pair from either side', async () => {
			const { manager } = pair()
			const result = await SearchToolsTool.execute({ query: 'page_act' }, context(manager))
			expect(result.reveals).toEqual(['page_act', 'page_look'])
		})

		it('loads a tool with no companion alone', async () => {
			const { manager } = pair()
			const result = await SearchToolsTool.execute({ query: 'solo_tool' }, context(manager))
			expect(result.reveals).toEqual(['solo_tool'])
			expect(result.data).not.toHaveProperty('companions')
		})

		it('is harmless when the companion is already loaded', async () => {
			const { manager, messages } = pair()
			const first = await SearchToolsTool.execute({ query: 'page_act' }, context(manager))
			messages.push(
				createToolMessage(
					first.output,
					'search-1',
					false,
					first.reveals?.map((name) => manager.revealReceipt(name)),
				),
			)
			expect(manager.availability('page_look')).toBe('active')
			const again = await SearchToolsTool.execute({ query: 'page_look' }, context(manager))
			expect(again.output).toContain('No deferred tools matching')
		})

		it('does not load a companion outside the allow-list', async () => {
			const { manager } = pair()
			const result = await SearchToolsTool.execute(
				{ query: 'page_look' },
				context(manager, ['page_look']),
			)
			expect(result.reveals).toEqual(['page_look'])
		})

		it('says in the catalogue that a tool loads with its companion', () => {
			const { manager } = pair()
			expect(manager.toPromptSection()).toContain(
				'- page_look: Look at the page. (loads with page_act)',
			)
		})
	})
})

describe('search_tools query forms', () => {
	const roster = () =>
		managerWith(
			tool('web_search', 'Look things up on the internet.'),
			tool('web_fetch', 'Fetch a page.'),
			tool('save_memory', 'Save one memory.'),
			tool('browser', 'Open pages.', ['browser_act']),
			tool('browser_act', 'Act on a page.'),
			tool('web_a', 'a'),
			tool('web_b', 'b'),
			tool('web_c', 'c'),
			tool('web_d', 'd'),
		)

	it('select loads exactly the named tools, no more', async () => {
		const { manager } = roster()
		const result = await SearchToolsTool.execute(
			{ query: 'select: save_memory , web_fetch ,' },
			context(manager),
		)
		expect(result.reveals).toEqual(['save_memory', 'web_fetch'])
		expect(result.output).toContain('Activated 2 tool(s):')
		expect(result.output).not.toContain('web_search')
	})

	it('select does not pull in companions, and says they exist', async () => {
		const { manager } = roster()
		const result = await SearchToolsTool.execute({ query: 'select:browser' }, context(manager))
		expect(result.reveals).toEqual(['browser'])
		expect(result.output).toContain('Related tools that are not loaded: browser_act')
	})

	it('select reports loaded, unknown and refused names', async () => {
		const { manager, messages } = roster()
		const first = await SearchToolsTool.execute({ query: 'select:web_fetch' }, context(manager))
		messages.push(
			createToolMessage(
				first.output,
				'c1',
				false,
				first.reveals?.map((name) => manager.revealReceipt(name)),
			),
		)
		const result = await SearchToolsTool.execute(
			{ query: 'select:web_fetch,save_memory,nope,web_search' },
			context(manager, ['web_fetch', 'save_memory']),
		)
		expect(result.reveals).toEqual(['save_memory'])
		expect(result.output).toContain('Already loaded, call directly: web_fetch.')
		expect(result.output).toContain('No tool named: nope, web_search.')
	})

	it('select with no names says so and loads nothing', async () => {
		const { manager } = roster()
		const result = await SearchToolsTool.execute({ query: 'select:  , ' }, context(manager))
		expect(result.success).toBe(true)
		expect(result.reveals).toBeUndefined()
	})

	it('select keeps to 64 names', async () => {
		const many = Array.from({ length: 70 }, (_, i) => tool(`bulk_${String(i).padStart(2, '0')}`))
		const { manager } = managerWith(...many)
		const names = many.map((t) => t.name).join(',')
		const result = await SearchToolsTool.execute({ query: `select:${names}` }, context(manager))
		expect(result.reveals).toHaveLength(64)
	})

	it('an exact name loads that tool alone, with its companions', async () => {
		const { manager } = roster()
		const result = await SearchToolsTool.execute({ query: 'browser' }, context(manager))
		expect(result.reveals).toEqual(['browser', 'browser_act'])
	})

	it('max_results bounds what a keyword search loads; the rest are suggestions', async () => {
		const { manager } = roster()
		const two = await SearchToolsTool.execute({ query: 'web', max_results: 2 }, context(manager))
		expect(two.reveals).toHaveLength(2)
		expect(two.output).toContain('Also matched but NOT loaded')
		const def = await SearchToolsTool.execute({ query: 'web' }, context(manager))
		expect(def.reveals).toHaveLength(5)
		const bad = SearchToolsTool.inputSchema.safeParse({ query: 'web', max_results: 0 })
		expect(bad.success).toBe(false)
	})

	it('a +term narrows the results', async () => {
		const { manager } = roster()
		const result = await SearchToolsTool.execute({ query: '+memory web' }, context(manager))
		expect(result.reveals).toEqual(['save_memory'])
	})

	it('the description teaches the three forms', () => {
		expect(SearchToolsTool.description).toContain('select:')
		expect(SearchToolsTool.description).toContain('keywords')
		expect(SearchToolsTool.description).toContain('"+slack send"')
	})
})

describe('search_tools select reporting', () => {
	it('names the entries past the cap instead of dropping them silently', async () => {
		const names = Array.from({ length: 66 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)
		const { manager } = managerWith(...names.map((name) => tool(name)))
		const result = await SearchToolsTool.execute(
			{ query: `select:${names.join(',')}` },
			context(manager),
		)
		expect(result.output).toContain('at most 64 names: tool_64, tool_65')
		expect(result.reveals).toHaveLength(64)
		expect(result.data).toMatchObject({ notSelected: ['tool_64', 'tool_65'] })
	})

	it('says when a short name loaded more than one tool', async () => {
		const messages: Message[] = []
		const mcp = (server: string) =>
			deferred({
				...testToolset(tool(`mcp__${server}__create_issue`)),
				source: { id: `mcp:${server}`, kind: 'mcp_server', name: server },
			})
		const manager = new ToolManager({ toolsets: [mcp('a'), mcp('b')], messages: () => messages })
		const result = await SearchToolsTool.execute({ query: 'select:create_issue' }, context(manager))
		expect(result.reveals).toEqual(['mcp__a__create_issue', 'mcp__b__create_issue'])
		expect(result.output).toContain('matched more than one tool, and all of them are loaded')
	})
})
