import { expect, it, vi } from 'vitest'
import type { ResidentHistorySource } from '../../manager/resident/history.js'
import { testToolset } from '../../test-support/toolset.js'
import { ToolManager } from '../../toolsets/manager.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { buildResidentHistoryTools } from '../resident-history.js'

function context(): ToolContext {
	return {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

it('rejects model-selected scope and malformed addresses before consulting the host', async () => {
	const resolve = vi.fn<() => ResidentHistorySource>()
	const registry = new ToolManager({
		toolsets: [testToolset(...buildResidentHistoryTools(resolve))],
		messages: () => [],
	})
	for (const input of [
		{ query: 'DELTA', pursuitId: 'another' },
		{ path: '/elsewhere' },
		{ limit: 9 },
		{ cursor: 0 },
	]) {
		expect((await registry.execute('search_resident_history', input, context())).success).toBe(
			false,
		)
	}
	for (const input of [
		{ revision: 2, part: 17 },
		{ revision: 2, part: 0, offset: -1 },
		{ revision: 2, part: 0, tenantId: 'another' },
	]) {
		expect((await registry.execute('read_resident_history', input, context())).success).toBe(false)
	}
	expect(resolve).not.toHaveBeenCalled()
})

it('resolves ownership on every call and does not expose a rejected source or its error details', async () => {
	const owner = context()
	const search = vi.fn().mockResolvedValue({
		matches: [],
		nextCursor: null,
		scannedRevisions: 2,
		scannedBytes: 1024,
		unavailableRevisions: [2],
		incomplete: true,
	})
	const read = vi.fn()
	const registry = new ToolManager({
		toolsets: [
			testToolset(
				...buildResidentHistoryTools((ctx) => {
					if (ctx.turnId !== owner.turnId) throw new Error('secret host path or tenant detail')
					return {
						scope: {
							tenantId: 'tenant',
							agentKey: 'resident',
							pursuitId: 'pursuit',
							throughRevision: 2,
						},
						search,
						read,
					}
				}),
			),
		],
		messages: () => [],
	})
	const [own, foreign] = await Promise.all([
		registry.execute('search_resident_history', { query: 'DELTA' }, owner),
		registry.execute('search_resident_history', { query: 'DELTA' }, context()),
	])
	expect(own.success).toBe(true)
	expect(JSON.parse(own.output)).toMatchObject({ incomplete: true, unavailableRevisions: [2] })
	expect(foreign.success).toBe(false)
	expect(JSON.stringify(foreign)).not.toContain('secret host')
	expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'DELTA' }, owner.abortSignal)
	expect(read).not.toHaveBeenCalled()
})

it('forwards exact-page continuation and the invocation cancellation signal to the backend', async () => {
	const owner = context()
	const read = vi.fn().mockResolvedValue({
		entry: {
			revision: 9,
			part: 1,
			text: 'later page',
			offset: 6000,
			totalChars: 6010,
			nextOffset: null,
		},
		scannedRevisions: 2,
		scannedBytes: 1000,
		unavailableRevisions: [],
	})
	const registry = new ToolManager({
		toolsets: [
			testToolset(
				...buildResidentHistoryTools(() => ({
					scope: {
						tenantId: 'tenant',
						agentKey: 'resident',
						pursuitId: 'pursuit',
						throughRevision: 9,
					},
					search: vi.fn(),
					read,
				})),
			),
		],
		messages: () => [],
	})
	const result = await registry.execute(
		'read_resident_history',
		{ revision: 9, part: 1, offset: 6000 },
		owner,
	)
	expect(result.success).toBe(true)
	expect(JSON.parse(result.output).entry.text).toBe('later page')
	expect(read).toHaveBeenCalledExactlyOnceWith(
		{ revision: 9, part: 1, offset: 6000 },
		owner.abortSignal,
	)
})
