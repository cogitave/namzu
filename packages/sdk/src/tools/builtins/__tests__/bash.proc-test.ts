import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

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
	// A killed child can still hold its working directory for a moment — on
	// Windows that surfaces as EBUSY, and it failed the timeout test from the
	// cleanup rather than the assertion, which is the most misleading way for a
	// test to go red. This file worked that out on its own and grew its own
	// retry-and-swallow; the helper is the same remedy, and it names the path
	// on the way out instead of swallowing in silence.
	for (const dir of dirs) removeTempDir(dir)
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

describe('what the command inherits from the host', () => {
	// `node -e` rather than `env` or `set`: this suite's commands have to behave
	// the same under `cmd.exe` and `sh`, and node is the one interpreter both
	// are guaranteed to reach.
	const READ = (name: string) => `node -e "console.log(process.env.${name} || 'UNSET')"`

	it('does not hand the model a credential it inherited', async () => {
		// The defect this closes: the host path spawned with `...process.env`,
		// so a command that printed its environment returned the operator's
		// provider keys into a transcript that is persisted and re-sent to the
		// provider on every later turn of the run.
		process.env.NAMZU_PROC_FAKE_API_KEY = 'sk-must-not-appear'
		try {
			const result = await run({ command: READ('NAMZU_PROC_FAKE_API_KEY') })

			expect(result.success).toBe(true)
			expect(result.output, 'an inherited credential reached the model').not.toContain(
				'sk-must-not-appear',
			)
			expect(result.output).toContain('UNSET')
		} finally {
			delete process.env.NAMZU_PROC_FAKE_API_KEY
		}
	})

	it('still inherits the variables a build needs', async () => {
		// The complement, and the one that fails if the denylist is ever
		// tightened into an allowlist: withholding everything would pass the
		// test above while breaking every `pnpm test` an agent runs.
		process.env.NAMZU_PROC_PLAIN_VAR = 'inherited-ok'
		try {
			const result = await run({ command: READ('NAMZU_PROC_PLAIN_VAR') })

			expect(result.output).toContain('inherited-ok')
		} finally {
			delete process.env.NAMZU_PROC_PLAIN_VAR
		}
	})

	it('lets a host hand over a credential on purpose', async () => {
		// The asymmetry is the design: inheritance is implicit and therefore
		// scrubbed, an explicit `context.env` entry is a decision someone made
		// and is passed through even though its name is credential-shaped.
		const context = ctx()
		;(context as { env?: Record<string, string> }).env = { NAMZU_PROC_GIVEN_TOKEN: 'handed-over' }

		const result = await run({ command: READ('NAMZU_PROC_GIVEN_TOKEN') }, context)

		expect(result.output).toContain('handed-over')
	})

	it('names what it withheld when the command fails', async () => {
		// A command that wanted the variable otherwise reports an
		// authentication error pointing nowhere. The note is on the failure
		// path only, so a successful command is not made noisy to buy nothing.
		process.env.NAMZU_PROC_WITHHELD_TOKEN = 'nope'
		try {
			const failing = await run({ command: 'node -e "process.exit(3)"' })
			const succeeding = await run({ command: 'echo fine' })

			expect(failing.success).toBe(false)
			// Asserted on the note rather than on this variable's name: the
			// preview is the first ten names alphabetically, and a developer
			// machine with ten credential-shaped variables sorting before `N`
			// would push this one into the "and N more" tail. A test that only
			// passes on a tidy environment is a test that fails for whoever has
			// a busy one.
			expect(failing.output).toContain('credential-shaped environment variable')
			expect(failing.output, 'the withheld value was printed').not.toContain('nope')
			expect(succeeding.output, 'a successful command was made noisy').not.toContain('withheld')
		} finally {
			delete process.env.NAMZU_PROC_WITHHELD_TOKEN
		}
	})
})
