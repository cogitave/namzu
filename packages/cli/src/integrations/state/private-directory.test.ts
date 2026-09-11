import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { currentUserSid, readAclSddl } from '../providers/credential-store.js'
import { ensurePrivateStateDirectory } from './private-directory.js'

const dirs: string[] = []

afterEach(() => {
	for (const path of dirs) removeTempDir(path)
	dirs.length = 0
})

function root(): string {
	const path = mkdtempSync(join(tmpdir(), 'namzu-private-state-'))
	dirs.push(path)
	return path
}

describe('generated CLI state privacy boundary', () => {
	it.runIf(process.platform === 'win32')(
		'accepts explicit LocalSystem access while refusing an explicit Everyone grant',
		() => {
			const stateRoot = root()
			const path = join(stateRoot, 'cli')
			mkdirSync(path)
			const sid = currentUserSid()
			if (!sid) throw new Error('Native Windows account SID was not available')
			const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
			execFileSync(icacls, [path, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], {
				stdio: 'ignore',
			})

			expect(ensurePrivateStateDirectory(stateRoot, 'cli')).toBe(path)
			expect(readAclSddl(path)).toContain(';;;SY)')
			expect(ensurePrivateStateDirectory(stateRoot, 'cli')).toBe(path)

			execFileSync(icacls, [path, '/grant:r', '*S-1-1-0:F'], { stdio: 'ignore' })
			expect(() => ensurePrivateStateDirectory(stateRoot, 'cli')).toThrow(
				/grants access to an account other than yours/,
			)
		},
	)

	it('refuses a partition name that could leave the state root', () => {
		expect(() => ensurePrivateStateDirectory(join(root(), '.namzu'), '../outside')).toThrow(
			/safe path segment/,
		)
	})

	it.runIf(process.platform !== 'win32')('tightens an existing partition to owner-only', () => {
		const stateRoot = join(root(), '.namzu')
		const memory = join(stateRoot, 'memory')
		mkdirSync(memory, { recursive: true, mode: 0o755 })

		expect(ensurePrivateStateDirectory(stateRoot, 'memory')).toBe(memory)
		expect(lstatSync(memory).mode & 0o777).toBe(0o700)
	})

	it('refuses a project-controlled state-root symlink', () => {
		const cwd = root()
		const outside = root()
		const stateRoot = join(cwd, '.namzu')
		symlinkSync(outside, stateRoot, 'dir')

		expect(() => ensurePrivateStateDirectory(stateRoot, 'projects')).toThrow(/real directory/)
	})

	it('refuses a project-controlled partition symlink', () => {
		const cwd = root()
		const outside = root()
		const stateRoot = join(cwd, '.namzu')
		mkdirSync(stateRoot)
		symlinkSync(outside, join(stateRoot, 'memory'), 'dir')

		expect(() => ensurePrivateStateDirectory(stateRoot, 'memory')).toThrow(/real directory/)
	})
})
