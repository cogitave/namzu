import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shellEscalations } from '../../../runtime/query/path-escalation.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	bashWorkingDirectoryForExecution,
	effectiveBashWorkingDirectory,
	forgetCarriedDirectories,
	pinBashWorkingDirectory,
	recordDirectory,
} from '../bash-cwd.js'

const directories: string[] = []
afterEach(async () => {
	forgetCarriedDirectories()
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function carried() {
	const base = await mkdtemp(join(tmpdir(), 'namzu-effective-cwd-'))
	directories.push(base)
	const cwd = join(base, '.git', 'hooks')
	await mkdir(cwd, { recursive: true })
	const file = join(base, 'capture')
	await writeFile(file, cwd)
	const context = { sessionId: 'cwd-test', workingDirectory: base } as ToolContext
	await recordDirectory(context.sessionId, file, context)
	return { base, cwd, context }
}

const posixShell = { path: '/bin/bash' }

describe('bash cwd shared by authorization and execution', () => {
	it('resolves the same carried cwd for a POSIX host and never carries into a sandbox or Windows', async () => {
		const { base, cwd } = await carried()
		expect(effectiveBashWorkingDirectory('cwd-test', base, { shell: posixShell })).toBe(cwd)
		expect(
			effectiveBashWorkingDirectory('cwd-test', base, { shell: posixShell, sandboxed: true }),
		).toBe(base)
		expect(
			effectiveBashWorkingDirectory('cwd-test', base, {
				shell: { ...posixShell, windows: true as const },
			}),
		).toBe(base)
		expect(effectiveBashWorkingDirectory(undefined, base, { shell: posixShell })).toBe(base)
	})

	it('drops a removed carried cwd instead of executing in an unrelated directory', async () => {
		const { base, cwd } = await carried()
		await rm(cwd, { recursive: true })
		expect(effectiveBashWorkingDirectory('cwd-test', base, { shell: posixShell })).toBe(base)
	})

	it('checks protected and outside paths from the effective cwd without replacing the root', async () => {
		const { base, cwd } = await carried()
		const found = await shellEscalations('echo x > pre-commit; cat ../../../outside', 'bash', {
			roots: [base],
			cwd,
			reviewOutside: true,
		})
		expect(found.protectedPaths).toContain(join(cwd, 'pre-commit'))
		expect(found.outsidePaths).toContain(join(base, '..', 'outside'))
	})

	it('retains the original cwd removal floor after a move into an added directory', async () => {
		const { base } = await carried()
		const added = await mkdtemp(join(tmpdir(), 'namzu-added-cwd-'))
		directories.push(added)
		const found = await shellEscalations(`rm -rf '${base}'`, 'bash', {
			roots: [base, added],
			cwd: added,
			reviewOutside: true,
		})
		expect(found.dangerousRemoval).toBeDefined()
	})

	it('preserves the internal authorization pin across context copies and refuses cwd drift', async () => {
		const { context, base } = await carried()
		pinBashWorkingDirectory(context, base)
		// A sandbox does not carry cwd: use it to check the no-drift copy case on
		// every host, including Windows, without launching a process.
		expect(bashWorkingDirectoryForExecution({ ...context, sandbox: {} })).toBe(base)
		pinBashWorkingDirectory(context, join(base, 'not-the-reviewed-cwd'))
		expect(() => bashWorkingDirectoryForExecution({ ...context })).toThrow(
			'changed after this call was reviewed',
		)
	})
})
