import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

/**
 * The `exec --json` contract (docs/cli/exec-json.md): every stdout line is one
 * JSON event with a `kind`; logs, including the `--debug` trace and the
 * NDJSON log records, go to stderr. Run against the built binary because the
 * stream is what a machine reader sees, whatever wrote it.
 */
it('writes only events on stdout and the logs on stderr, with --debug and --verbose on', async () => {
	expect(existsSync(BIN), `${BIN} is missing: run \`pnpm --filter @namzu/cli build\` first`).toBe(
		true,
	)
	const home = mkdtempSync(join(tmpdir(), 'namzu-exec-json-stdout-'))
	try {
		const { stdout, stderr, code } = await new Promise<{
			stdout: string
			stderr: string
			code: number | null
		}>((resolve, reject) => {
			// An unknown provider fails before any network call, after the logging
			// sink is installed, so stderr carries records and stdout the error.
			const child = spawn(
				process.execPath,
				[
					BIN,
					'--debug',
					'--verbose',
					'exec',
					'--trust',
					'--json',
					'--provider',
					'nope',
					'--',
					'hi',
				],
				{
					cwd: home,
					env: { PATH: process.env.PATH ?? '', HOME: home, CI: '1', LANG: 'C.UTF-8' },
				},
			)
			let out = ''
			let err = ''
			child.stdout.on('data', (chunk) => {
				out += chunk
			})
			child.stderr.on('data', (chunk) => {
				err += chunk
			})
			child.on('error', reject)
			child.on('close', (exit) => resolve({ stdout: out, stderr: err, code: exit }))
		})
		expect(code).toBe(0)
		const lines = stdout.split('\n').filter((line) => line.length > 0)
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			const event = JSON.parse(line) as Record<string, unknown>
			expect(typeof event.kind, line).toBe('string')
		}
		expect(JSON.parse(lines.at(-1) as string)).toMatchObject({ kind: 'done' })
		// The logs exist, and they are on the other stream.
		expect(stderr.length).toBeGreaterThan(0)
	} finally {
		removeTempDir(home)
	}
	// A real subprocess: Vitest's per-test timeout is the hang guard, raised for process start-up.
}, 60_000)
