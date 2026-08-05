import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

/**
 * What a shell command actually tells the model, measured by running one.
 *
 * The only builtin that runs a shell had no test at all, and what that cost
 * is visible in the code it shipped: the host path called `exec` with no
 * `catch`, and `exec` REJECTS on a non-zero exit. So the two things an agent
 * runs a shell for most — a test run and a build — both threw, and the
 * registry turned the throw into "the tool failed" with none of the stdout,
 * stderr or exit code that explains why. The sandbox path beside it reported
 * all three, so the same command told the model two different amounts
 * depending on where it happened to run.
 *
 * These spawn real processes, so they live in the `proc-test` suite rather
 * than the unit one — measured, running them beside 2594 unit tests flaked
 * four unrelated timing-sensitive tests. The assertions that need no shell
 * stayed behind in `bash.test.ts`.
 *
 * Commands are written to behave identically under `cmd.exe` and `sh`,
 * because `exec` picks the platform shell and a test that only passes on one
 * of them is a test that fails for whoever is on the other.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs) {
		// A killed child can still hold its working directory for a moment —
		// on Windows that surfaces as EBUSY, and it failed the timeout test
		// from the cleanup rather than the assertion, which is the most
		// misleading way for a test to go red. Retry, then let it go: a temp
		// directory that outlives the run is the operating system's problem,
		// not a result worth reporting.
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		} catch {
			// Deliberately swallowed. See above.
		}
	}
	dirs.length = 0
})

function ctx(): ToolContext {
	const workingDirectory = mkdtempSync(join(tmpdir(), 'namzu-bash-'))
	dirs.push(workingDirectory)
	return { workingDirectory } as ToolContext
}

async function run(
	input: Record<string, unknown>,
	context: ToolContext = ctx(),
): Promise<{ success: boolean; output: string; error?: string; data?: Record<string, unknown> }> {
	const parsed = BashTool.inputSchema.parse(input)
	return (await BashTool.execute(parsed as never, context)) as never
}

describe('a command that succeeds', () => {
	it('returns its stdout', async () => {
		const result = await run({ command: 'echo hello' })

		expect(result.success).toBe(true)
		expect(result.output).toContain('hello')
		expect(result.data?.exitCode).toBe(0)
	})

	it('runs in the working directory it was given', async () => {
		const context = ctx()
		writeFileSync(join(context.workingDirectory, 'marker.txt'), 'x')

		const result = await run(
			{ command: `node -e "console.log(require('fs').readdirSync('.'))"` },
			context,
		)

		expect(result.output).toContain('marker.txt')
	})

	it('says so rather than returning an empty string', async () => {
		const result = await run({ command: 'node -e ""' })

		expect(result.output).toBe('(no output)')
	})
})

describe('a command that fails still says what happened', () => {
	it('reports the exit code instead of throwing', async () => {
		// The whole defect: this used to reject out of `execute`.
		const result = await run({ command: 'node -e "process.exit(3)"' })

		expect(result.success).toBe(false)
		expect(result.data?.exitCode).toBe(3)
		expect(result.error).toContain('exited with code 3')
	})

	it('keeps the output a failing command produced', async () => {
		// The reason a model runs a shell at all: a failing test prints WHY it
		// failed, on stdout, before exiting non-zero.
		const result = await run({
			command: `node -e "console.log('3 tests failed'); process.exit(1)"`,
		})

		expect(result.success).toBe(false)
		expect(result.output, 'the failure output was discarded').toContain('3 tests failed')
	})

	it('keeps stderr too', async () => {
		const result = await run({
			command: `node -e "console.error('compiler said no'); process.exit(2)"`,
		})

		expect(result.output).toContain('compiler said no')
		expect(result.data?.exitCode).toBe(2)
	})

	it('reports a missing command as a failure, not as success', async () => {
		const result = await run({ command: 'definitely-not-a-real-command-xyz' })

		expect(result.success).toBe(false)
		expect(result.error).toBeTruthy()
	})
})

describe('a command that runs out of time', () => {
	it('says it timed out rather than that it exited', async () => {
		// "Ran out of time" and "exited 1" are different diagnoses and lead to
		// different next moves, so the message has to distinguish them.
		const result = await run({
			command: `node -e "setTimeout(() => {}, 10000)"`,
			timeout: 300,
		})

		expect(result.success).toBe(false)
		expect(result.data?.timedOut).toBe(true)
		expect(result.error).toContain('timed out')
	}, 20_000)
})
