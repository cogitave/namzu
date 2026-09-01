import { existsSync } from 'node:fs'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

/**
 * A sandbox handle and the workspace it exposes have different owners.
 *
 * The CLI creates one handle per SDK run, while a coding session spans many
 * runs. A caller-owned working directory must therefore survive handle
 * teardown; only provider-created temporary roots may be removed.
 */

const workspaces: string[] = []

afterEach(async () => {
	await removeTempDirs(workspaces)
	workspaces.length = 0
})

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'namzu-local-workspace-'))
	workspaces.push(path)
	return path
}

describe('LocalSandboxProvider working-directory ownership', () => {
	it('keeps write and exec results across two sandbox allocations', async () => {
		const cwd = await workspace()
		const provider = new LocalSandboxProvider(NOOP_LOGGER)

		const first = await provider.create({ workingDirectory: cwd })
		await first.writeFile('from-write.txt', 'written in the first run')
		const executed = await first.exec(process.execPath, [
			'-e',
			"require('node:fs').writeFileSync('from-exec.txt', 'executed in the first run')",
		])
		expect(executed.exitCode).toBe(0)
		await first.destroy()

		const second = await provider.create({ workingDirectory: cwd })
		expect((await second.readFile('from-write.txt')).toString()).toBe('written in the first run')
		expect((await second.readFile('from-exec.txt')).toString()).toBe('executed in the first run')
		await second.writeFile('from-second-run.txt', 'still the same workspace')
		await second.destroy()

		expect(await readFile(join(cwd, 'from-second-run.txt'), 'utf8')).toBe(
			'still the same workspace',
		)
	})

	it('still removes a provider-owned ephemeral root', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		const root = sandbox.rootDir
		await sandbox.writeFile('temporary.txt', 'temporary')

		await sandbox.destroy()

		expect(existsSync(root)).toBe(false)
	})

	it('refuses a missing working directory before creating a handle', async () => {
		const parent = await workspace()
		const provider = new LocalSandboxProvider(NOOP_LOGGER)

		await expect(provider.create({ workingDirectory: join(parent, 'missing') })).rejects.toThrow(
			/does not exist/,
		)
	})

	it('refuses a file where a working directory was required', async () => {
		const parent = await workspace()
		const file = join(parent, 'not-a-directory')
		await writeFile(file, 'file')
		const provider = new LocalSandboxProvider(NOOP_LOGGER)

		await expect(provider.create({ workingDirectory: file })).rejects.toThrow(/not a directory/)
	})

	it('refuses a filesystem root because it provides no confinement boundary', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER)

		await expect(provider.create({ workingDirectory: parse(tmpdir()).root })).rejects.toThrow(
			/filesystem root/,
		)
	})

	it('refuses read, write, and exec cwd paths that escape through a symlink', async () => {
		const cwd = await workspace()
		const outside = await workspace()
		await writeFile(join(outside, 'secret.txt'), 'outside')
		try {
			await symlink(outside, join(cwd, 'escape'), 'dir')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return
			throw error
		}
		const sandbox = await new LocalSandboxProvider(NOOP_LOGGER).create({
			workingDirectory: cwd,
		})

		await expect(sandbox.readFile('escape/secret.txt')).rejects.toThrow(/outside/)
		await expect(sandbox.writeFile('escape/new.txt', 'no')).rejects.toThrow(/outside/)
		await expect(sandbox.exec(process.execPath, ['-e', '0'], { cwd: 'escape' })).rejects.toThrow(
			/outside/,
		)
		expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside')
		expect(existsSync(join(outside, 'new.txt'))).toBe(false)
		await sandbox.destroy()
	})
})
