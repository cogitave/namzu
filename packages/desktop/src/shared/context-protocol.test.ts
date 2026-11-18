import { describe, expect, it } from 'vitest'

import { readContextReport } from './context-protocol.js'

const good = {
	sessionId: 's',
	detail: 'full',
	measuredBy: 'provider',
	windowTokens: 1_000_000,
	windowSource: 'model-table',
	totalTokens: 77_700,
	percentage: 8,
	autoCompact: { enabled: true, bufferTokens: 33_000, thresholdTokens: 967_000 },
	categories: [
		{ id: 'messages', name: 'Messages', tokens: 19_600, kind: 'used' },
		{ id: 'free', name: 'Free space', tokens: 889_300, kind: 'free' },
	],
	lists: {
		mcpTools: [{ name: 'search', server: 'docs', tokens: 300 }],
		deferredTools: [{ name: 'x', tokens: 1 }],
		skills: [{ name: 'a', source: 'user', tokens: 10 }],
		agents: [],
		memoryFiles: [{ label: 'AGENTS.md', tokens: 900 }],
	},
	approximate: false,
}

describe('readContextReport', () => {
	it('reads a full answer', () => {
		const report = readContextReport(good)
		expect(report?.windowTokens).toBe(1_000_000)
		expect(report?.categories).toHaveLength(2)
		expect(report?.lists?.mcpTools[0]).toEqual({ name: 'search', server: 'docs', tokens: 300 })
		expect(report?.approximate).toBe(false)
		expect(report?.autoCompact.thresholdTokens).toBe(967_000)
	})

	it('is null when the engine has no window yet', () => {
		expect(readContextReport(null)).toBeNull()
		expect(readContextReport({ ...good, windowTokens: 0 })).toBeNull()
		expect(readContextReport('x')).toBeNull()
	})

	it('drops a row that does not read and keeps the rest', () => {
		const report = readContextReport({
			...good,
			categories: [
				...good.categories,
				{ id: 'x', name: 'Bad', tokens: -1, kind: 'used' },
				{ id: 'y', name: 'Bad', tokens: 1, kind: 'weird' },
				'nope',
			],
		})
		expect(report?.categories.map((row) => row.id)).toEqual(['messages', 'free'])
	})

	it('treats an absent flag as an estimate, never as exact', () => {
		const { approximate: _gone, ...rest } = good
		expect(readContextReport(rest)?.approximate).toBe(true)
	})

	it('leaves the lists out on a summary', () => {
		const { lists: _gone, ...rest } = good
		expect(readContextReport({ ...rest, detail: 'summary' })?.lists).toBeUndefined()
	})
})
