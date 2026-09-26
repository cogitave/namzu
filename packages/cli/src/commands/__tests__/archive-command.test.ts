import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import {
	archiveConversation,
	closeSessions,
	listRecent,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'

const originalCwd = process.cwd()
const roots: string[] = []

afterEach(() => {
	process.chdir(originalCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('lists and restores only this project through the real CLI, then allows resume', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-archive-command-'))
	roots.push(root)
	const cwd = join(root, 'here')
	const otherCwd = join(root, 'other')
	const stateRoot = join(root, 'state')
	const { mkdirSync } = await import('node:fs')
	mkdirSync(cwd)
	mkdirSync(otherCwd)
	mkdirSync(stateRoot)
	vi.stubEnv('NAMZU_HOME', stateRoot)
	const sessions = await openSessions(cwd, { stateRoot })
	const id = await startConversation(sessions)
	await recordTurn(sessions, id, [createUserMessage('resume this work')])
	await archiveConversation(sessions, id)
	closeSessions(sessions)

	let stdout = ''
	let stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
	const invoke = async (...args: string[]) => {
		stdout = ''
		stderr = ''
		const code = await runCli({ argv: ['node', 'namzu', '--format', 'json', 'archive', ...args] })
		return { code, output: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null, stderr }
	}

	process.chdir(otherCwd)
	const otherList = await invoke('list')
	expect(otherList).toMatchObject({ code: 0, output: { conversations: [] } })
	const otherRestore = await invoke('restore', id)
	expect(otherRestore.code).toBe(64)
	expect(otherRestore.stderr).toContain('was not found')

	process.chdir(cwd)
	const listed = await invoke('list')
	expect(listed.code).toBe(0)
	expect(listed.output?.conversations).toMatchObject([{ id }])
	const nextPage = await invoke('list', '--page', '2')
	expect(nextPage).toMatchObject({ code: 0, output: { page: 2, conversations: [] } })
	const invalidPage = await invoke('list', '--page', 'nope')
	expect(invalidPage.code).toBe(64)
	const restored = await invoke('restore', id)
	expect(restored).toMatchObject({ code: 0, output: { id } })
	const reopened = await openSessions(cwd, { stateRoot })
	expect((await listRecent(reopened)).map((row) => row.id)).toEqual([id])
	closeSessions(reopened)
	const again = await invoke('restore', id)
	expect(again.code).toBe(64)
	expect(again.stderr).toContain('already active')
	const invalid = await invoke('restore', '../escape')
	expect(invalid.code).toBe(64)
	expect(invalid.stderr).toContain('Invalid session id')
})
