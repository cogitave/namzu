import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

let project: string | undefined

afterEach(() => {
	if (project) removeTempDir(project)
	project = undefined
})

describe('namzu acp bootstrap', () => {
	it('does not parse project config before a protocol session crosses trust', async () => {
		project = mkdtempSync(join(tmpdir(), 'namzu-acp-untrusted-'))
		writeFileSync(join(project, 'namzu.config.json'), '{ "sandbox": ')
		const previousCwd = process.cwd()
		try {
			process.chdir(project)
			const { runCli } = await import('../cli.js')
			const running = runCli({ argv: ['node', 'namzu', 'acp'] })
			// Let the command attach its stdio owner, then emulate the client
			// closing the pipe without ever opening a session. If ACP were still
			// dispatched through the project-aware context, the malformed attacker
			// config above would win before this point with EXIT_BAD_CONFIG.
			await new Promise((resolve) => setImmediate(resolve))
			process.stdin.emit('end')

			expect(await running).toBe(0)
		} finally {
			process.chdir(previousCwd)
		}
	})
})
