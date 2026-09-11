import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	appendMessages,
	openSessions,
	resolveConversation,
	startConversation,
} from '../../integrations/sessions/store.js'
import { historyCommand } from '../run-stream.js'
import type { CommandContext } from '../types.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('reads a conversation UUID, the latest conversation, and a host key through the real database', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-history-database-'))
	roots.push(root)
	const cwd = join(root, 'work')
	const home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	const sessions = await openSessions(cwd)
	const id = await startConversation(sessions)
	await appendMessages(sessions, id, [createUserMessage('UUID history')])
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
	await appendMessages(sessions, mapped, [createUserMessage('host history')])
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
