/**
 * `ToolContext.workingDirectoryChanged`: told once per real change of the
 * folder the session's shell commands start in, never when it did not move.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { forgetCarriedDirectories, recordDirectory } from '../bash-cwd.js'

const directories: string[] = []
afterEach(async () => {
	forgetCarriedDirectories()
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function project() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'namzu-cwd-change-')))
	directories.push(base)
	await mkdir(join(base, 'sub'))
	await mkdir(join(base, 'other'))
	const context = { sessionId: 'cwd-change', workingDirectory: base } as ToolContext
	const changes: Array<{ from: string; to: string }> = []
	const ran = async (endedIn: string) => {
		const file = join(base, `capture-${Math.random().toString(36).slice(2)}`)
		await writeFile(file, endedIn)
		await recordDirectory(context.sessionId, file, context, (change) => {
			changes.push(change)
		})
	}
	return { base, ran, changes }
}

describe('a change of the shell folder', () => {
	it('is not told when the command ended where it started', async () => {
		const { base, ran, changes } = await project()
		await ran(base)
		await ran(base)
		expect(changes).toEqual([])
	})

	it('is told once for a cd, and not again while the shell stays there', async () => {
		const { base, ran, changes } = await project()
		await ran(join(base, 'sub'))
		await ran(join(base, 'sub'))
		expect(changes).toEqual([{ from: base, to: join(base, 'sub') }])
	})

	it('names the folder left and the folder entered each time it moves', async () => {
		const { base, ran, changes } = await project()
		await ran(join(base, 'sub'))
		await ran(join(base, 'other'))
		await ran(base)
		expect(changes).toEqual([
			{ from: base, to: join(base, 'sub') },
			{ from: join(base, 'sub'), to: join(base, 'other') },
			{ from: join(base, 'other'), to: base },
		])
	})

	it('is not told for a link to the same folder (the shell reports its physical path)', async () => {
		const real = await realpath(await mkdtemp(join(tmpdir(), 'namzu-cwd-real-')))
		directories.push(real)
		const link = `${real}-link`
		await symlink(real, link)
		directories.push(link)
		const context = { sessionId: 'cwd-link', workingDirectory: link } as ToolContext
		const file = join(real, 'capture')
		await writeFile(file, real)
		const changes: unknown[] = []
		await recordDirectory(context.sessionId, file, context, (change) => {
			changes.push(change)
		})
		expect(changes).toEqual([])
	})

	it('is told when the shell was put back at the working directory for leaving the allowed folders', async () => {
		const { base, ran, changes } = await project()
		await ran(join(base, 'sub'))
		await ran(await realpath(tmpdir()))
		expect(changes.at(-1)).toEqual({ from: join(base, 'sub'), to: base })
	})

	it('does not fail the command when the observer throws', async () => {
		const { base } = await project()
		const context = { sessionId: 'cwd-throw', workingDirectory: base } as ToolContext
		const file = join(base, 'capture')
		await writeFile(file, join(base, 'sub'))
		await expect(
			recordDirectory(context.sessionId, file, context, () => {
				throw new Error('observer broke')
			}),
		).resolves.toBeUndefined()
	})
})
