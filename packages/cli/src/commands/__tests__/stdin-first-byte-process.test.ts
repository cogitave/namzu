import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * A real pipe, in a real process, for the one thing a stream stand-in cannot
 * show: `exec` loads its next module while it waits for the first byte, so
 * the deadline can expire while the process is busy and has not polled its
 * stdin for longer than the deadline. Timers run before the poll phase that
 * reads the pipe, so a deadline that settled the moment it fired would call
 * input that is already in the pipe "silence".
 *
 * Nothing here races the clock. The child blocks its event loop until the
 * parent has written everything and created a flag file, and for at least as
 * long as the deadline, so the deadline has always expired by the time the
 * loop turns.
 */

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-stdin-'))
})

afterEach(() => {
	removeTempDir(dir)
})

function runChild(input: string): Promise<string> {
	const require = createRequire(import.meta.url)
	const stdinModule = fileURLToPath(new URL('../stdin.ts', import.meta.url))
	const flag = join(dir, 'written')
	const script = join(dir, 'child.mts')
	writeFileSync(
		script,
		`import { existsSync } from 'node:fs'
import { readStdin } from ${JSON.stringify(pathToFileURL(stdinModule).href)}
const reading = readStdin({ deadline: true })
const started = Date.now()
while (!existsSync(${JSON.stringify(flag)}) || Date.now() - started < 400) {}
process.stdout.write(JSON.stringify(await reading))
`,
	)
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['--import', pathToFileURL(require.resolve('tsx')).href, script],
			{ stdio: ['pipe', 'pipe', 'inherit'] },
		)
		let out = ''
		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', () => resolve(out))
		child.stdin.end(input, () => writeFileSync(flag, ''))
	})
}

describe('the first-byte deadline in a real process', () => {
	it('reads input that was in the pipe before the deadline expired while the command was busy', async () => {
		expect(JSON.parse(await runChild('material that was already there'))).toBe(
			'material that was already there',
		)
	}, 60_000)
})
