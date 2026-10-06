import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@namzu/sdk'
import {
	DiskSessionLog,
	type MessageId,
	type SessionLease,
	type SessionLog,
	type TurnId,
	createAssistantMessage,
	createUserMessage,
	generateCheckpointId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import * as storage from '../../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-history-work-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
async function fixture() {
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	const host = createDesktopHostExtensions(runtime, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const log = DiskSessionLog.at(state.paths, { sessionId })
	const lease = await log.claim({ holder: 'test:history-work', ttlMs: 30_000 })
	if (!lease) throw new Error('Expected fixture writer')
	return {
		state,
		sessionId,
		log,
		lease,
		history: () => host['namzu/conversations/history']({ sessionId }),
		close: async () => {
			await log.release(lease)
			closeSessions(state)
			await runtime.close()
		},
	}
}
async function begin(log: SessionLog, lease: SessionLease, prompt = 'Review file.') {
	const turnId = generateTurnId()
	const userMessageId = generateMessageId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId,
		config: { model: 'fixture', timeoutMs: 0, tokenBudget: 0 },
	})
	await log.append(lease, {
		type: 'message',
		turnId,
		messageId: userMessageId,
		role: 'user',
		content: createUserMessage(prompt),
	})
	return { turnId, userMessageId }
}
async function answer(
	log: SessionLog,
	lease: SessionLease,
	turnId: TurnId,
	text = 'Ready.',
	messageId = generateMessageId(),
) {
	await log.append(lease, {
		type: 'message',
		turnId,
		messageId,
		role: 'assistant',
		content: createAssistantMessage(text),
	})
	return messageId
}
async function finish(
	log: SessionLog,
	lease: SessionLease,
	turnId: TurnId,
	status: 'completed' | 'cancelled' | 'failed' = 'completed',
) {
	const settlement = {
		iterations: 1,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		durationMs: 4321,
		resultSource: 'model' as const,
		abandonedTaskIds: [],
		abandonedJobIds: [],
		status,
	}
	if (status === 'failed')
		await log.append(lease, {
			type: 'turn_failed',
			turnId,
			error: 'PRIVATE_PROVIDER_ERROR',
			settlement,
		})
	else
		await log.append(lease, {
			type: 'turn_completed',
			turnId,
			result: 'Ready.',
			settlement,
			...(status === 'cancelled'
				? { stopReason: 'cancelled' as const }
				: { stopReason: 'end_turn' as const }),
		})
}

it('returns only recorded public views and anchored durable work from one strict snapshot', async () => {
	const f = await fixture()
	try {
		const { turnId, userMessageId } = await begin(f.log, f.lease)
		const toolUseId = generateMessageId()
		await f.log.append(f.lease, {
			type: 'tool_executing',
			turnId,
			toolUseId,
			toolName: 'edit',
			input: { SECRET_INPUT: 'private' },
		})
		await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId,
			toolUseId,
			toolName: 'edit',
			result: 'PRIVATE_RAW_OUTPUT',
			isError: false,
			presentation: {
				kind: 'diff',
				path: 'note.txt',
				before: 'Old',
				after: 'New',
				opaqueProviderField: 'PRIVATE_OPAQUE',
			} as never,
			durationMs: 123,
		})
		const steerId = generateMessageId()
		await f.log.append(f.lease, {
			type: 'message',
			turnId,
			messageId: steerId,
			role: 'user',
			content: {
				...createUserMessage('Also check.'),
				source: { type: 'runtime-context', kind: 'steering' },
			},
		})
		const answerId = await answer(f.log, f.lease, turnId)
		await finish(f.log, f.lease, turnId)
		const loaded = vi.spyOn(storage, 'loadConversationSnapshot')
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
		const presenters = vi.spyOn(sdk, 'createToolPresenter')
		const result = await f.history()
		expect(result.messages).toEqual([
			{ role: 'user', text: 'Review file.' },
			{ role: 'user', text: 'Also check.' },
			{ role: 'assistant', text: 'Ready.' },
		])
		expect(result.work?.messages).toMatchObject([
			{ index: 0, messageId: userMessageId, turnId },
			{ index: 1, messageId: steerId, turnId },
			{ index: 2, messageId: answerId, turnId },
		])
		expect(result.work?.turns).toMatchObject([
			{ turnId, userMessageId, status: 'completed', reason: 'end_turn', durationMs: 4321 },
		])
		expect(result.work?.tools).toMatchObject([
			{
				turnId,
				toolUseId,
				status: 'completed',
				durationMs: 123,
				presentation: { kind: 'diff', path: 'note.txt', before: 'Old', after: 'New' },
			},
		])
		expect(result.work?.tools[0]?.order).toBeLessThan(result.work?.messages[1]?.order ?? 0)
		expect(JSON.stringify(result)).not.toContain('PRIVATE_')
		expect(JSON.stringify(result)).not.toContain('SECRET_INPUT')
		expect(loaded).toHaveBeenCalledTimes(1)
		expect(indexed).not.toHaveBeenCalled()
		expect(presenters).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it('invalidates old success after another start, scopes reused call IDs to their actual turn, and accepts standalone completion', async () => {
	const f = await fixture()
	try {
		const first = await begin(f.log, f.lease)
		const toolUseId = generateMessageId()
		await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId: first.turnId,
			toolUseId,
			toolName: 'read',
			result: 'OLD_RESULT',
			isError: false,
			presentation: { kind: 'generic', label: 'OLD_PUBLIC_SUCCESS' },
		})
		await f.log.append(f.lease, {
			type: 'tool_executing',
			turnId: first.turnId,
			toolUseId,
			toolName: 'read',
			input: { PRIVATE_RETRY_INPUT: true },
		})
		await answer(f.log, f.lease, first.turnId)
		await finish(f.log, f.lease, first.turnId)
		const second = await begin(f.log, f.lease, 'Next.')
		await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId: second.turnId,
			toolUseId,
			toolName: 'read',
			result: 'PRIVATE_RESULT',
			isError: true,
			presentation: { kind: 'generic', label: 'Cancelled by user', outcome: 'cancelled' },
		})
		await answer(f.log, f.lease, second.turnId)
		await finish(f.log, f.lease, second.turnId, 'cancelled')
		const result = await f.history()
		expect(result.work?.tools).toMatchObject([
			{ turnId: first.turnId, toolUseId, status: 'interrupted', detailUnavailable: true },
			{
				turnId: second.turnId,
				toolUseId,
				status: 'cancelled',
				presentation: { kind: 'generic', outcome: 'cancelled' },
			},
		])
		expect(result.work?.tools[0]?.presentation).toBeUndefined()
		expect(result.work?.tools[1]?.order).toBeGreaterThan(result.work?.turns[1]?.order ?? 0)
		expect(JSON.stringify(result)).not.toContain('OLD_PUBLIC_SUCCESS')
		expect(JSON.stringify(result)).not.toContain('PRIVATE_')
	} finally {
		await f.close()
	}
})

it('keeps folded replacements and compaction authoritative without resurrecting removed work', async () => {
	const f = await fixture()
	try {
		const { turnId, userMessageId } = await begin(f.log, f.lease)
		const toolUseId = generateMessageId()
		const executing = await f.log.append(f.lease, {
			type: 'tool_executing',
			turnId,
			toolUseId,
			toolName: 'edit',
			input: {},
		})
		const completed = await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId,
			toolUseId,
			toolName: 'edit',
			result: 'Old',
			isError: false,
			presentation: { kind: 'diff', before: 'Old', after: 'New' },
		})
		const answerId = await answer(f.log, f.lease, turnId, 'Old answer.')
		await finish(f.log, f.lease, turnId)
		await f.log.append(f.lease, {
			type: 'message_replaced',
			targetMessageId: answerId,
			content: createAssistantMessage('Corrected answer.'),
			reason: 'review',
		})
		expect((await f.history()).messages.at(-1)?.text).toBe('Corrected answer.')
		await f.log.append(f.lease, {
			type: 'compaction',
			compactionId: 'fixture-compaction',
			strategy: 'test',
			trigger: 'manual',
			replacesSeqRange: [executing.record.seq, completed.record.seq],
			summary: [createAssistantMessage('Saved summary.')],
			keptMessageIds: [userMessageId, answerId],
			tokensBefore: 100,
			tokensAfter: 50,
		})
		const result = await f.history()
		expect(result.messages).toContainEqual({ role: 'assistant', text: 'Saved summary.' })
		expect(result.messages.at(-1)?.text).toBe('Corrected answer.')
		expect(result.work?.tools).toEqual([])
		expect(result.work?.messages.every((row) => row.messageId !== 'fixture-compaction')).toBe(true)
	} finally {
		await f.close()
	}
})

it('projects paused, resumed incomplete and failed boundaries without returning the private reason or checkpoint', async () => {
	const f = await fixture()
	try {
		const { turnId } = await begin(f.log, f.lease)
		const checkpointId = generateCheckpointId()
		await f.log.append(f.lease, {
			type: 'turn_paused',
			turnId,
			reason: 'PRIVATE_DECISION',
			checkpointId,
		})
		const paused = await f.history()
		expect(paused.work?.turns).toMatchObject([{ status: 'paused', reason: 'paused' }])
		expect(paused.work?.turns[0]?.durationMs).toBeUndefined()
		await f.log.append(f.lease, { type: 'turn_resuming', turnId, fromCheckpointId: checkpointId })
		expect((await f.history()).work?.turns).toMatchObject([
			{ status: 'interrupted', reason: 'interrupted' },
		])
		await finish(f.log, f.lease, turnId, 'failed')
		const failed = await f.history()
		expect(failed.work?.turns).toMatchObject([
			{ status: 'failed', reason: 'error', durationMs: 4321 },
		])
		expect(JSON.stringify(paused)).not.toContain(checkpointId)
		expect(JSON.stringify(paused)).not.toContain('PRIVATE_')
		expect(JSON.stringify(failed)).not.toContain('PRIVATE_')
	} finally {
		await f.close()
	}
})

// Real fsync-backed records exercise both bounds without allocating arbitrary raw tool results.
it('bounds selected receipts and saved public view bytes and rejects hostile metadata', async () => {
	const f = await fixture()
	try {
		const { turnId } = await begin(f.log, f.lease)
		for (let index = 0; index < 102; index++) {
			const presentation =
				index < 9
					? { kind: 'generic', label: 'v'.repeat(index === 2 ? 32768 : 31000) }
					: index === 9
						? { kind: 'terminal', output: { PRIVATE_OBJECT: true } }
						: index === 10
							? { kind: 'generic', label: '', visibility: 'hidden' }
							: { kind: 'generic', label: 'Saved observation', privateField: 'PRIVATE_EXTRA' }
			await f.log.append(f.lease, {
				type: 'tool_completed',
				turnId,
				toolUseId: generateMessageId(),
				toolName: 'read',
				result: 'PRIVATE_RESULT',
				isError: false,
				presentation: presentation as never,
			})
		}
		await answer(f.log, f.lease, turnId)
		await finish(f.log, f.lease, turnId)
		const result = await f.history()
		expect(result.work?.tools).toHaveLength(100)
		expect(result.work?.partial).toBe(true)
		const views =
			result.work?.tools.flatMap((tool) => (tool.presentation ? [tool.presentation] : [])) ?? []
		expect(views.every((view) => Buffer.byteLength(JSON.stringify(view)) <= 32768)).toBe(true)
		expect(
			views.reduce((sum, view) => sum + Buffer.byteLength(JSON.stringify(view)), 0),
		).toBeLessThanOrEqual(128 * 1024)
		expect(
			result.work?.tools.filter((tool) => tool.detailUnavailable).length,
		).toBeGreaterThanOrEqual(4)
		expect(
			views.filter((view) => view.kind === 'generic' && view.label.length === 31000),
		).toHaveLength(4)
		expect(JSON.stringify(result)).not.toContain('PRIVATE_')
	} finally {
		await f.close()
	}
}, 30_000)

it('does not reuse an ambiguous message or a renamed tool identity', async () => {
	const f = await fixture()
	try {
		const first = await begin(f.log, f.lease)
		const reused: MessageId = await answer(f.log, f.lease, first.turnId)
		await finish(f.log, f.lease, first.turnId)
		const second = await begin(f.log, f.lease, 'Next.')
		const toolUseId = generateMessageId()
		await f.log.append(f.lease, {
			type: 'tool_executing',
			turnId: second.turnId,
			toolUseId,
			toolName: 'read',
			input: {},
		})
		await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId: second.turnId,
			toolUseId,
			toolName: 'write',
			result: 'PRIVATE_WRONG_CALL',
			isError: false,
			presentation: { kind: 'generic', label: 'WRONG_PUBLIC_VIEW' },
		})
		await answer(f.log, f.lease, second.turnId, 'Reused message.', reused)
		await finish(f.log, f.lease, second.turnId)
		const result = await f.history()
		expect(result.work?.messages.some((row) => row.messageId === reused)).toBe(false)
		expect(result.work?.tools).toEqual([])
		expect(JSON.stringify(result)).not.toContain('WRONG_PUBLIC_VIEW')
	} finally {
		await f.close()
	}
})

it('does not regroup retained work across a visible user whose reused identity is ambiguous', async () => {
	const f = await fixture()
	try {
		const first = await begin(f.log, f.lease, 'Prompt A')
		const reused = generateMessageId()
		await f.log.append(f.lease, {
			type: 'message',
			turnId: first.turnId,
			messageId: reused,
			role: 'user',
			content: {
				...createUserMessage('Steering A'),
				source: { type: 'runtime-context', kind: 'steering' },
			},
		})
		await f.log.append(f.lease, {
			type: 'tool_completed',
			turnId: first.turnId,
			toolUseId: generateMessageId(),
			toolName: 'read',
			result: 'Private output',
			isError: false,
			presentation: { kind: 'generic', label: 'Old observation' },
		})
		await answer(f.log, f.lease, first.turnId, 'Answer A')
		await finish(f.log, f.lease, first.turnId)
		const turnId = generateTurnId()
		await f.log.beginTurn(f.lease, {
			turnId,
			userMessageId: reused,
			config: { model: 'fixture', timeoutMs: 0, tokenBudget: 0 },
		})
		await f.log.append(f.lease, {
			type: 'message',
			turnId,
			messageId: reused,
			role: 'user',
			content: createUserMessage('Prompt B'),
		})
		await finish(f.log, f.lease, turnId)
		const result = await f.history()
		expect(result.messages).toEqual([
			{ role: 'user', text: 'Prompt A' },
			{ role: 'user', text: 'Prompt B' },
			{ role: 'assistant', text: 'Answer A' },
		])
		expect(result.work?.turns).toEqual([])
		expect(result.work?.tools).toEqual([])
	} finally {
		await f.close()
	}
})
