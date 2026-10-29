import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

import type { ToolContext } from '../../../types/tool/index.js'
import { forgetCarriedDirectories } from '../bash-cwd.js'
import { BashTool } from '../bash.js'

/**
 * The directory a `cd` ends in is where the session's next call starts, inside
 * the turn's roots; outside them the call is put back and says so.
 */

const dirs: string[] = []
afterEach(() => {
	forgetCarriedDirectories()
	for (const dir of dirs) removeTempDir(dir)
	dirs.length = 0
})

function makeRoot(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-cwd-')))
	dirs.push(dir)
	return dir
}

function turn(workingDirectory: string, sessionId = 'session-a', extra: Partial<ToolContext> = {}) {
	return { workingDirectory, sessionId, ...extra } as ToolContext
}

async function run(command: string, context: ToolContext) {
	return BashTool.execute(BashTool.inputSchema.parse({ command }), context)
}

describe('the working directory between bash calls', () => {
	it('starts the next call where a cd ended', async () => {
		const root = makeRoot()
		mkdirSync(join(root, 'sub'))
		const context = turn(root)

		await run('cd sub', context)
		const next = await run('pwd', context)

		expect(next.output).toContain(join(root, 'sub'))
	})

	it('keeps the exit status of the command itself', async () => {
		const root = makeRoot()
		const result = await run('cd . && exit 3', turn(root))

		expect(result.data).toMatchObject({ exitCode: 3 })
	})

	it('carries a directory even when the command failed afterwards', async () => {
		const root = makeRoot()
		mkdirSync(join(root, 'sub'))
		const context = turn(root)

		await run('cd sub && false', context)

		expect((await run('pwd', context)).output).toContain(join(root, 'sub'))
	})

	it('does not carry shell state, only the directory', async () => {
		const root = makeRoot()
		const context = turn(root)

		await run('export NAMZU_CARRY=1', context)

		expect((await run('echo "[$NAMZU_CARRY]"', context)).output).toContain('[]')
	})

	it('keeps sessions apart', async () => {
		const root = makeRoot()
		mkdirSync(join(root, 'sub'))

		await run('cd sub', turn(root, 'session-a'))

		expect((await run('pwd', turn(root, 'session-b'))).output).toContain(root)
		expect((await run('pwd', turn(root, 'session-b'))).output).not.toContain(join(root, 'sub'))
	})

	it('puts a command that left the roots back and says so', async () => {
		const root = makeRoot()
		const outside = makeRoot()
		const context = turn(root)

		const left = await run(`cd '${outside}'`, context)
		const next = await run('pwd', context)

		expect(left.output).toContain(`Shell cwd was reset to ${root}`)
		expect(next.output).toContain(root)
		expect(next.output).not.toContain(outside)
	})

	it('lets a command stay in a directory the session added', async () => {
		const root = makeRoot()
		const added = makeRoot()
		const context = turn(root, 'session-a', { additionalDirectories: [added] })

		const left = await run(`cd '${added}'`, context)

		expect(left.output).not.toContain('Shell cwd was reset')
		expect((await run('pwd', context)).output).toContain(added)
	})

	it('falls back to the working directory when the carried one is gone', async () => {
		const root = makeRoot()
		mkdirSync(join(root, 'gone'))
		const context = turn(root)

		await run('cd gone', context)
		// Removed from under the session by a different one.
		await run('rmdir gone', turn(root, 'session-other'))

		const next = await run('pwd', context)

		expect(next.success).toBe(true)
		expect(next.output).toContain(root)
	})
})
