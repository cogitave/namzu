import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'

// A `#note` is the person's own. A session refused for want of a provider
// still has the folder's stored memory under the Namzu home, so the note goes
// there; it never goes into the repository's `.namzu/MEMORY.md`, which every
// prompt reads and git commits.
const roots: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function workspace() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-refused-note-'))
	roots.push(root)
	const cwd = join(root, 'checkout')
	const home = join(root, 'home')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
	return { root, cwd, home }
}

const unknownProvider = {
	version: 3,
	providers: [{ id: 'no-such-provider' }],
	subagents: { active: [] },
} as unknown as Preferences

it('saves a note of a session refused for its provider in the stored memory, with its type', async () => {
	const { cwd, home } = workspace()
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(unknownProvider, [], {
		cwd,
		sandbox: { enabled: false },
	})
	expect(session.hasProvider).toBe(false)
	expect(session.errorHint).toContain('Unknown provider')
	expect(session.rememberNote).toBeTypeOf('function')

	const saved = await session.rememberNote?.('STAGING_IS_READ_ONLY', 'feedback')
	expect(saved).toMatchObject({ saved: true, type: 'feedback' })
	expect(saved?.path?.startsWith(join(home, 'projects'))).toBe(true)
	expect(saved?.path).toContain(`${join('memory', '')}`)
	expect(readFileSync(saved?.path ?? '', 'utf8')).toContain('STAGING_IS_READ_ONLY')
	expect(existsSync(join(cwd, '.namzu'))).toBe(false)

	const again = await session.rememberNote?.('STAGING_IS_READ_ONLY')
	expect(again).toMatchObject({ saved: false, duplicate: true })
	await session.close()
})

it('has no note saver when the folder itself could not be opened', async () => {
	const { root } = workspace()
	const file = join(root, 'a-file')
	writeFileSync(file, 'not a folder')
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(unknownProvider, [], {
		cwd: file,
		sandbox: { enabled: false },
	})
	expect(session.hasProvider).toBe(false)
	expect(session.rememberNote).toBeUndefined()
})
