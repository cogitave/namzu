import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHarnessExecutable } from './native-executable.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

describe('external engine executable ownership', () => {
	it('resolves an explicitly authored absolute executable instead of PATH wrappers', async () => {
		expect(await resolveHarnessExecutable('codex', { executable: process.execPath })).toBe(
			process.execPath,
		)
		await expect(
			resolveHarnessExecutable('codex', { executable: 'codex.cmd', platform: 'win32' }),
		).rejects.toThrow('unavailable')
		await expect(
			resolveHarnessExecutable('claude', {
				executable: 'C:\\custom\\claude.ps1',
				platform: 'win32',
			}),
		).rejects.toThrow('unavailable')
	})
	it('uses executable PATH candidates and refuses a nonexecutable replacement', async () => {
		if (process.platform === 'win32') return
		const directory = await mkdtemp(join(tmpdir(), 'namzu-harness-executable-'))
		directories.push(directory)
		const executable = join(directory, 'codex')
		await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o700 })
		expect(
			await resolveHarnessExecutable('codex', { env: { PATH: directory, HOME: directory } }),
		).toBe(executable)
		await chmod(executable, 0o600)
		await expect(
			resolveHarnessExecutable('codex', { env: { PATH: directory, HOME: directory } }),
		).rejects.toThrow('not found')
	})
})
