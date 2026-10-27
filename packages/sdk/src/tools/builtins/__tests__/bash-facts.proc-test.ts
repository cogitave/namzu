import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

/**
 * What a command tells a host as fields, measured by running one. The model's
 * text keeps its "STDOUT:" labels; the person's view is built from these
 * fields and never from them. Commands are written to run under `sh`.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs) removeTempDir(dir)
	dirs.length = 0
})

function ctx(): ToolContext {
	const workingDirectory = mkdtempSync(join(tmpdir(), 'namzu-bash-facts-'))
	dirs.push(workingDirectory)
	return { workingDirectory } as ToolContext
}

async function run(command: string) {
	const parsed = BashTool.inputSchema.parse({ command, timeout: 20_000 })
	return BashTool.execute(parsed as never, ctx())
}

describe('a command reports its streams and exit code as fields', () => {
	it('keeps stdout apart from stderr and leaves the model labels out of both', async () => {
		const result = await run('echo hello; echo oops >&2')
		expect(result.success).toBe(true)
		expect(result.output).toContain('STDOUT:')
		expect(result.facts).toMatchObject({
			kind: 'command',
			exitCode: 0,
			stdout: { head: 'hello', totalLines: 1 },
			stderr: { head: 'oops', totalLines: 1 },
		})
	})

	it('reports a failing exit code and never the withheld-variable note', async () => {
		const previous = process.env.OPENAI_API_KEY
		process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'
		try {
			const result = await run('echo oops >&2; exit 3')
			expect(result.success).toBe(false)
			// The withheld count travels in `data`; the kernel tells the model in
			// a notice of its own, so the result carries no note.
			expect((result.data as { withheldEnv?: number }).withheldEnv).toBeGreaterThanOrEqual(1)
			expect(result.output).not.toContain('NOTE:')
			expect(result.facts).toMatchObject({ kind: 'command', exitCode: 3 })
			expect(JSON.stringify(result.facts)).not.toContain('withheld')
			expect(JSON.stringify(result.facts)).not.toContain('OPENAI_API_KEY')
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
			else process.env.OPENAI_API_KEY = previous
		}
	})

	it('windows a long output and counts the lines it leaves out', async () => {
		const result = await run('seq 1 600')
		const facts = result.facts as {
			stdout: {
				head: string
				tail: string
				omittedLines: number
				totalLines: number
			}
		}
		expect(facts.stdout.totalLines).toBe(600)
		expect(facts.stdout.head.split('\n')[0]).toBe('1')
		expect(facts.stdout.tail.split('\n').at(-1)).toBe('600')
		expect(facts.stdout.omittedLines).toBeGreaterThan(400)
	})

	it('does not carry the bytes of binary output, only their size', async () => {
		const result = await run('head -c 3000 /dev/urandom')
		const facts = result.facts as {
			binary?: { bytes: number }
			stdout?: unknown
		}
		expect(facts.binary?.bytes).toBe(3000)
		expect(facts.stdout).toBeUndefined()
	})

	it('keeps ANSI escapes in the field for the host to render', async () => {
		const result = await run("printf '\\033[31mred\\033[0m\\n'")
		expect(result.facts).toMatchObject({
			stdout: { head: '\u001b[31mred\u001b[0m' },
		})
	})
})

describe('a command that answers with its exit status', () => {
	it('reads a grep with no match as a result, not a failure', async () => {
		const result = await run('printf "a\\n" | grep zzz')
		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		expect(result.output).toBe('(no output)')
		expect(result.data).toMatchObject({
			exitCode: 1,
			exitNote: 'No matches found',
		})
		expect(result.facts).toMatchObject({
			kind: 'command',
			exitCode: 1,
			exitNote: 'No matches found',
		})
	})

	it('reads differing files as a result and keeps their output', async () => {
		const result = await run('printf a > a.txt; printf b > b.txt; diff a.txt b.txt')
		expect(result.success).toBe(true)
		expect(result.output).toContain('STDOUT:')
		expect(result.facts).toMatchObject({
			exitCode: 1,
			exitNote: 'Files differ',
		})
	})

	it('still fails a grep that could not run, and any other command', async () => {
		const missing = await run('grep x /nonexistent-namzu-file')
		expect(missing.success).toBe(false)
		expect(missing.facts).toMatchObject({ exitCode: 2 })
		expect(JSON.stringify(missing.facts)).not.toContain('exitNote')
		const other = await run('exit 1')
		expect(other.success).toBe(false)
		expect(other.error).toBe('Command exited with code 1')
	})
})
