/**
 * The background installer runs on its own. These tests start real processes:
 * a parent that begins an install and exits at once, and an installer that only
 * starts working after the parent is gone. Nothing here waits on a clock; each
 * step waits for the event it depends on, and a genuine hang is left to the
 * test runner's own limit.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runNpmUpgrade } from './npm-global.js'

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-installer-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, '..', '..')

const INSTALLER = `
import { existsSync, writeFileSync, writeSync } from 'node:fs'
const [go, done] = process.argv.slice(2)
const wait = () => (existsSync(go) ? finish() : setTimeout(wait, 10))
function finish() {
	try {
		writeSync(1, 'installing\\n')
		writeSync(2, 'EACCES: permission denied\\n')
		writeFileSync(done, 'survived')
	} catch (error) {
		writeFileSync(done, 'died ' + error.code)
	}
}
wait()
`

async function until(path: string): Promise<void> {
	while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('a background install', () => {
	it('keeps running and keeps its log after the process that started it has exited', async () => {
		const installer = join(dir, 'installer.mjs')
		const parent = join(dir, 'parent.mts')
		const go = join(dir, 'go')
		const done = join(dir, 'done')
		const log = join(dir, 'state', 'install.log')
		writeFileSync(installer, INSTALLER)
		writeFileSync(
			parent,
			`import { runNpmUpgrade } from ${JSON.stringify(join(here, 'npm-global.ts'))}
void runNpmUpgrade({
	executable: process.execPath,
	args: [${JSON.stringify(installer)}, ${JSON.stringify(go)}, ${JSON.stringify(done)}],
	prefix: ${JSON.stringify(dir)},
	background: true,
	logFile: ${JSON.stringify(log)},
	onOutput: () => undefined,
	onSpawn: () => process.exit(0),
})
`,
		)
		const exit = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(process.execPath, ['--import', 'tsx', parent], {
				cwd: cliRoot,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			child.once('error', reject)
			child.once('close', resolve)
		})
		expect(exit).toBe(0)

		// The parent and its pipes are gone. Only now may the installer print.
		writeFileSync(go, '')
		await until(done)
		expect(readFileSync(done, 'utf8')).toBe('survived')
		expect(readFileSync(log, 'utf8')).toContain('installing')
		expect(readFileSync(log, 'utf8')).toContain('permission denied')
	}, 60_000)

	it('hands the end of the log back when the install finishes while the caller waits', async () => {
		const script = join(dir, 'noisy.mjs')
		writeFileSync(
			script,
			"process.stdout.write('a'.repeat(40000)); process.stderr.write('last words'); process.exit(3)",
		)
		let seen = ''
		const code = await runNpmUpgrade({
			executable: process.execPath,
			args: [script],
			prefix: dir,
			background: true,
			logFile: join(dir, 'install.log'),
			onOutput: (text) => {
				seen += text
			},
		})
		expect(code).toBe(3)
		expect(seen.endsWith('last words')).toBe(true)
		expect(seen.length).toBeLessThanOrEqual(16_384)
	})

	it('starts the next install with an empty log', async () => {
		const log = join(dir, 'install.log')
		writeFileSync(log, 'from the last run')
		const script = join(dir, 'quiet.mjs')
		writeFileSync(script, 'process.stdout.write("fresh")')
		let seen = ''
		await runNpmUpgrade({
			executable: process.execPath,
			args: [script],
			prefix: dir,
			background: true,
			logFile: log,
			onOutput: (text) => {
				seen += text
			},
		})
		expect(seen).toBe('fresh')
	})

	it('writes nothing to the terminal it was started from', async () => {
		const script = join(dir, 'talk.mjs')
		writeFileSync(script, 'console.log("noise")')
		const code = await runNpmUpgrade({
			executable: process.execPath,
			args: [script],
			prefix: dir,
			background: true,
		})
		expect(code).toBe(0)
	})
})
