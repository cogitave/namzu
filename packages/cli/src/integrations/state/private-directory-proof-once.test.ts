/** On Windows a state folder is proved private once per process, and again when it is another folder. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => ({ whoami: 0, grants: [] as string[], saves: 0 }))

vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	platform: () => 'win32' as const,
}))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return {
		...actual,
		execFileSync: (file: string, args: readonly string[]) => {
			if (file.endsWith('whoami.exe')) {
				windows.whoami += 1
				return '"runner","S-1-5-21-123"\r\n'
			}
			if (!file.endsWith('icacls.exe')) throw new Error(`unexpected executable: ${file}`)
			if (args[1] === '/save') {
				windows.saves += 1
				writeFileSync(String(args[2]), 'D:P(A;OICI;FA;;;S-1-5-21-123)', 'utf16le')
				return ''
			}
			windows.grants.push(String(args[0]))
			return ''
		},
	}
})

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { restrictToOwner } from '../providers/credential-store.js'
import { ensurePrivateStateDirectory } from './private-directory.js'

const roots: string[] = []
afterEach(() => {
	windows.whoami = 0
	windows.saves = 0
	windows.grants.length = 0
	for (const root of roots.splice(0)) removeTempDir(root)
})
const root = () => {
	const path = mkdtempSync(join(tmpdir(), 'namzu-proof-once-'))
	roots.push(path)
	return path
}

it('proves a state folder private once, not at every open', () => {
	const state = root()
	const first = ensurePrivateStateDirectory(state, 'projects')
	expect(windows.grants).toHaveLength(1)
	const spawned = windows.whoami + windows.grants.length + windows.saves
	for (let open = 0; open < 5; open += 1)
		expect(ensurePrivateStateDirectory(state, 'projects')).toBe(first)
	// Five more opens started nothing.
	expect(windows.whoami + windows.grants.length + windows.saves).toBe(spawned)
})

it('proves a folder again when the same path now names a different folder', () => {
	const state = root()
	const path = ensurePrivateStateDirectory(state, 'projects')
	expect(windows.grants).toHaveLength(1)
	rmSync(path, { recursive: true })
	mkdirSync(path)
	ensurePrivateStateDirectory(state, 'projects')
	expect(windows.grants).toHaveLength(2)
})

it('asks who the account is once per process', () => {
	const state = root()
	ensurePrivateStateDirectory(state, 'projects')
	ensurePrivateStateDirectory(state, 'other')
	ensurePrivateStateDirectory(join(state, 'other'), 'nested')
	expect(windows.grants).toHaveLength(3)
	expect(windows.whoami).toBeLessThanOrEqual(1)
})

it('never skips the proof for a credential directory', () => {
	const state = root()
	const directory = join(state, 'credentials')
	mkdirSync(directory)
	restrictToOwner(directory)
	restrictToOwner(directory)
	expect(windows.grants).toEqual([directory, directory])
})
