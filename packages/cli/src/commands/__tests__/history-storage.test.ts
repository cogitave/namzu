import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	openConversationLog,
	openSessions,
	readConversationFacts,
	refreshIndex,
	resolveConversation,
	startConversation,
} from '../../integrations/sessions/store.js'
import { historyCommand } from '../host-queries.js'
import type { CommandContext } from '../types.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('reads a conversation UUID, the latest conversation, and a host key through the real session logs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-history-database-'))
	roots.push(root)
	const cwd = join(root, 'work')
	const home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	const sessions = await openSessions(cwd)
	const id = await startConversation(sessions)
	await recordTurn(sessions, id, [createUserMessage('UUID history')])
	const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
	const invoke = async (args: string[]) => {
		write.mockClear()
		expect(
			await historyCommand.handler({ rawArgs: ['--cwd', cwd, ...args], ctx: {} as CommandContext }),
		).toBe(0)
		return JSON.parse(write.mock.calls.map(([text]) => String(text)).join(''))
	}
	expect(await invoke(['--session', id])).toEqual([{ role: 'user', content: 'UUID history' }])
	expect(await invoke([])).toEqual([{ role: 'user', content: 'UUID history' }])
	const mapped = await resolveConversation(sessions, 'desktop-window')
	await recordTurn(sessions, mapped, [createUserMessage('host history')])
	expect(await invoke(['--session', 'desktop-window'])).toEqual([
		{ role: 'user', content: 'host history' },
	])
	const other = join(root, 'other-workspace')
	mkdirSync(other)
	write.mockClear()
	await historyCommand.handler({
		rawArgs: ['--cwd', other, '--session', id],
		ctx: {} as CommandContext,
	})
	expect(JSON.parse(write.mock.calls.map(([text]) => String(text)).join(''))).toEqual([])
})

it('shows an answer the runtime replaced, never the raw one', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-history-replaced-'))
	roots.push(root)
	const cwd = join(root, 'work')
	const home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	const sessions = await openSessions(cwd)
	const id = await startConversation(sessions)
	await recordTurn(sessions, id, [
		createUserMessage('what is the key'),
		{ role: 'assistant', content: 'the key is SECRET' } as never,
	])
	const answer = (await readConversationFacts(sessions, id))?.records.find(
		(record) => record.type === 'message' && record.role === 'assistant',
	)
	if (answer?.type !== 'message') throw new Error('fixture expected the assistant record')
	const log = openConversationLog(sessions, id)
	const lease = await log.claim({ holder: 'test-history', ttlMs: 10_000 })
	if (!lease) throw new Error('fixture could not lease the log')
	await log.append(lease, {
		type: 'message_replaced',
		targetMessageId: answer.messageId,
		content: { role: 'assistant', content: 'the key is [redacted]' } as never,
		reason: 'guardrail_rewritten',
	})
	await log.release(lease)
	await refreshIndex(sessions, id)
	const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

	expect(
		await historyCommand.handler({
			rawArgs: ['--cwd', cwd, '--session', id],
			ctx: {} as CommandContext,
		}),
	).toBe(0)

	const printed = write.mock.calls.map(([text]) => String(text)).join('')
	expect(JSON.parse(printed)).toEqual([
		{ role: 'user', content: 'what is the key' },
		{ role: 'assistant', content: 'the key is [redacted]' },
	])
	expect(printed).not.toContain('SECRET')
})
