import { describe, expect, it } from 'vitest'

import type { ContextReport } from '../shared/context-protocol.js'
import { contextPanelModel, formatShare, formatSize } from './context-panel-model.js'

const report = (over: Partial<ContextReport> = {}): ContextReport => ({
	detail: 'summary',
	measuredBy: 'provider',
	windowTokens: 1_000_000,
	totalTokens: 77_700,
	percentage: 8,
	autoCompact: { enabled: true, bufferTokens: 33_000, thresholdTokens: 967_000 },
	categories: [
		{ id: 'system-prompt', name: 'System prompt', tokens: 10_700, kind: 'used' },
		{ id: 'system-tools', name: 'System tools', tokens: 28_200, kind: 'used' },
		{ id: 'mcp-tools', name: 'MCP tools', tokens: 14_100, kind: 'used' },
		{ id: 'skills', name: 'Skills', tokens: 5_100, kind: 'used' },
		{ id: 'messages', name: 'Messages', tokens: 19_600, kind: 'used' },
		{ id: 'deferred-mcp-tools', name: 'MCP tools (deferred)', tokens: 61_500, kind: 'deferred' },
		{ id: 'deferred-tools', name: 'System tools (deferred)', tokens: 25_300, kind: 'deferred' },
		{ id: 'buffer', name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
		{ id: 'free', name: 'Free space', tokens: 889_300, kind: 'free' },
	],
	approximate: false,
	...over,
})

describe('sizes and shares', () => {
	it('writes sizes with one decimal at most', () => {
		expect(formatSize(412)).toBe('412')
		expect(formatSize(19_600)).toBe('19.6k')
		expect(formatSize(889_300)).toBe('889.3k')
		expect(formatSize(33_000)).toBe('33k')
		expect(formatSize(1_000_000)).toBe('1M')
		expect(formatSize(999_990)).toBe('1M')
		expect(formatSize(0)).toBe('0')
	})

	it('writes shares: a decimal under 10%, whole above, and a sliver as under 0.1%', () => {
		expect(formatShare(28_200, 1_000_000)).toBe('2.8%')
		expect(formatShare(889_300, 1_000_000)).toBe('89%')
		expect(formatShare(10, 1_000_000)).toBe('<0.1%')
		expect(formatShare(0, 1_000_000)).toBe('0%')
	})
})

describe('the panel for a measured conversation', () => {
	const model = contextPanelModel({ report: report() })

	it('says percent and size in plain words', () => {
		expect(model.headline).toBe('8% used')
		expect(model.size).toBe('77.7k / 1M')
		expect(model.tag?.text).toBe('Exact total')
		expect(model.sentence).toBe('About 889.3k left before Namzu shortens this conversation.')
	})

	it('draws the sentence only from 80% used and keeps it as hover text before that', () => {
		expect(model.showSentence).toBe(false)
		expect(model.estimated).toBe(false)
		const near = contextPanelModel({
			report: report({ windowTokens: 200_000, totalTokens: 164_000 }),
		})
		expect(near.showSentence).toBe(true)
		expect(contextPanelModel({ report: report(), compacting: true }).showSentence).toBe(true)
	})

	it('lists used rows biggest first, with plain names', () => {
		expect(model.used.map((row) => row.name)).toEqual([
			'Built-in tools',
			'Messages',
			'Tool server tools',
			'Namzu’s instructions',
			'Skills',
		])
		expect(model.used[0]).toMatchObject({ size: '28.2k', share: '2.8%' })
	})

	it('shows the tools that load only when needed with a dash, not a share', () => {
		expect(model.deferred.map((row) => [row.name, row.size, row.share])).toEqual([
			['More tool server tools', '61.5k', '-'],
			['More built-in tools', '25.3k', '-'],
		])
		expect(model.deferredNote).toContain('Namzu loads them if it needs them')
	})

	it('keeps the reserve and the free space apart from the used rows', () => {
		expect(model.reserve.map((row) => [row.name, row.size])).toEqual([
			['Kept free for the next answer', '33k'],
			['Free space', '889.3k'],
		])
	})

	it('draws a bar of the used rows then the reserve, the rest being the track', () => {
		expect(model.bar.segments.map((segment) => segment.kind)).toEqual([
			'used',
			'used',
			'used',
			'used',
			'used',
			'reserve',
		])
		const sum = model.bar.segments.reduce((n, segment) => n + segment.width, 0)
		expect(sum).toBeCloseTo(11.07, 1)
		expect(model.bar.label).toContain('8% used')
	})

	it('says the total comes from the AI service', () => {
		expect(model.footnote).toContain('comes from your AI service')
	})

	it('never says token in a label, a sentence or a tag', () => {
		const words = [
			model.headline,
			model.size,
			model.sentence,
			model.tag?.text ?? '',
			model.tag?.title ?? '',
			model.bar.label,
			model.deferredNote ?? '',
			...[...model.used, ...model.deferred, ...model.reserve].map((row) => row.name),
		]
		for (const word of words) expect(word.toLowerCase()).not.toContain('token')
	})
})

describe('an estimate', () => {
	it('says about, tags it as an estimate and warns near the end', () => {
		const model = contextPanelModel({
			report: report({
				measuredBy: 'estimate',
				approximate: true,
				windowTokens: 200_000,
				totalTokens: 182_000,
				autoCompact: { enabled: true, bufferTokens: 33_000, thresholdTokens: 167_000 },
			}),
		})
		expect(model.headline).toBe('about 91% used')
		expect(model.size).toBe('~182k / 200k')
		expect(model.estimated).toBe(true)
		expect(model.tag?.text).toBe('Estimate')
		expect(model.sentence).toBe('Namzu will shorten this conversation soon.')
		expect(model.tone).toBe('full')
		expect(model.footnote).toContain('may be off by a few percent')
	})

	it('says nothing about who counted when the engine did not say', () => {
		const { measuredBy: _gone, ...rest } = report()
		expect(contextPanelModel({ report: rest }).tag).toBeUndefined()
	})

	it('says the sizes are out of date after a shortening', () => {
		const model = contextPanelModel({
			report: report({ sizeOutOfDate: true, measuredBy: 'estimate', approximate: true }),
		})
		expect(model.footnote).toContain('out of date until your next message')
		expect(model.tag?.text).toBe('Estimate')
	})

	it('says it is shortening while it runs', () => {
		expect(contextPanelModel({ report: report(), compacting: true }).sentence).toBe(
			'Namzu is shortening this conversation…',
		)
	})
})

describe('lists', () => {
	const lists = {
		mcpTools: [
			{ name: 'create_issue', server: 'github', tokens: 212 },
			{ name: 'list_pull_requests', server: 'github', tokens: 198 },
			{ name: 'read', server: 'files', tokens: 90 },
		],
		deferredTools: [{ name: 'search', server: 'files', tokens: 300 }],
		skills: [
			{ name: 'a', source: 'user', tokens: 10 },
			{ name: 'b', source: 'project', tokens: 40 },
		],
		agents: [],
		memoryFiles: [],
	}

	it('opens skills in place, biggest first', () => {
		const model = contextPanelModel({ report: report({ lists }) })
		const skills = model.used.find((row) => row.id === 'skills')
		expect(skills?.items?.map((item) => item.name)).toEqual(['b', 'a'])
		expect(model.used.find((row) => row.id === 'messages')?.items).toBeUndefined()
	})

	it('folds the tool servers with their tool counts', () => {
		const model = contextPanelModel({ report: report({ lists }) })
		expect(model.servers?.total).toBe('4 tools')
		expect(model.servers?.list.map((server) => [server.name, server.count])).toEqual([
			['github', 2],
			['files', 2],
		])
		expect(model.servers?.list[1]?.tools.at(-1)?.note).toBe('loads when needed')
	})

	it('keeps lists from an earlier full answer when a short one has none', () => {
		const model = contextPanelModel({ report: report(), lists })
		expect(model.servers).toBeDefined()
	})

	it('shows no list or servers before the lists are read', () => {
		const model = contextPanelModel({ report: report() })
		expect(model.servers).toBeUndefined()
		expect(model.used.every((row) => row.items === undefined)).toBe(true)
	})
})

describe('a window with no reserve and an overflowing conversation', () => {
	it('lets the bar be the conversation when it no longer fits', () => {
		const model = contextPanelModel({
			report: report({
				windowTokens: 100,
				totalTokens: 150,
				categories: [{ id: 'messages', name: 'Messages', tokens: 150, kind: 'used' }],
				autoCompact: { enabled: false, bufferTokens: 0 },
			}),
		})
		expect(model.bar.segments[0]?.width).toBeCloseTo(100)
		expect(model.sentence).toBe('This conversation is past what Namzu can read at once.')
	})
})
