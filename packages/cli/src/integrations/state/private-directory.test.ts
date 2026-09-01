import { lstatSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
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
