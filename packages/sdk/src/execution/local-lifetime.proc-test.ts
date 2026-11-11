import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { LocalExecutionContext } from './local.js'

const dirs: string[] = []
const tokens: string[] = []

afterEach(() => {
	// The assertion should prove production killed every process. This is only
	// failure containment so a red process test cannot poison later suites.
	for (const token of tokens.splice(0)) {
		for (const pid of survivorPids(token)) {
			try {
				process.kill(pid, 'SIGKILL')
			} catch {
				// Already gone.
			}
		}
	}
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-local-lifetime-'))
	dirs.push(dir)
	return dir
}

function token(label: string): string {
	const value = `namzu-local-${label}-${process.pid}-${Date.now()}`
	tokens.push(value)
	return value
}

function survivorPids(value: string): number[] {
	const observed = spawnSync('pgrep', ['-f', value], { encoding: 'utf8' })
	return (observed.stdout ?? '')
		.split('\n')
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

// Captured before any test fakes the clock, so waiting for a real process
// keeps working while the product's timers are driven by hand.
const realSetTimeout = globalThis.setTimeout
const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms))

// No wall-clock deadline: a condition that never becomes true is a hang, and
// the per-test timeout reports it. A deadline here would only measure how
// fast the host spawns processes.
async function waitUntil(predicate: () => boolean): Promise<void> {
	while (!predicate()) await sleep(20)
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

describe.skipIf(process.platform === 'win32')(
	'LocalExecutionContext real process ownership',
	() => {
		it('bounds both real stdio streams while retaining their diagnostic tails', async () => {
			const dir = tempDir()
			const context = new LocalExecutionContext({
				id: 'bounded-real-output',
				cwd: dir,
				maxOutputBytes: 8,
			})

			const result = await context.executeCommand(process.execPath, [
				'-e',
				"process.stdout.write('stdout-head-TAIL'); process.stderr.write('stderr-head-END!')",
			])

			expect(result).toMatchObject({
				exitCode: 0,
				stdout: 'ead-TAIL',
				stderr: 'ead-END!',
				stdoutTruncated: true,
				stderrTruncated: true,
			})
		}, 10_000)

		it('ends a descendant which holds inherited pipes after its direct parent exits', async () => {
			const dir = tempDir()
			const processToken = token('deadline')
			const pidFile = join(dir, 'parent-pid')
			const script = join(dir, 'parent-exits.cjs')
			writeFileSync(
				script,
				[
					"const { spawn } = require('node:child_process')",
					"const fs = require('node:fs')",
					"const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[2]], { stdio: 'inherit' })",
					"held.once('spawn', () => { fs.writeFileSync(process.argv[3], String(process.pid)); process.stdout.write('parent-exited\\n'); process.exit(0) })",
				].join('\n'),
			)

			// The deadline is driven by hand, so it fires only after the parent
			// has really exited: no real-millisecond lease for the spawn to beat.
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
			try {
				const context = new LocalExecutionContext({ id: 'deadline', cwd: dir })
				const running = context.executeCommand(process.execPath, [script, processToken, pidFile], {
					timeoutMs: 100,
				})
				await waitUntil(
					() => existsSync(pidFile) && !isAlive(Number(readFileSync(pidFile, 'utf8'))),
				)
				// The descendant still holds the pipes, so only the deadline can end this.
				vi.advanceTimersByTime(100)
				const result = await running

				expect(result.stdout).toContain('parent-exited')
				expect(result.termination).toMatchObject({ origin: 'timeout', admitted: true })
			} finally {
				vi.useRealTimers()
			}
			await waitUntil(() => survivorPids(processToken).length === 0)
			expect(survivorPids(processToken)).toEqual([])
		}, 10_000)

		it('keeps teardown pending until SIGKILL ends a SIGTERM-ignoring descendant', async () => {
			const dir = tempDir()
			const processToken = token('teardown')
			const marker = join(dir, 'stubborn-ready')
			const script = join(dir, 'stubborn-parent.cjs')
			writeFileSync(
				script,
				[
					"const { spawn } = require('node:child_process')",
					"const childScript = \"const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)\"",
					"spawn(process.execPath, ['-e', childScript, process.argv[3], process.argv[2]], { stdio: 'inherit' })",
					'setInterval(() => {}, 1000)',
				].join('\n'),
			)

			const context = new LocalExecutionContext({ id: 'teardown', cwd: dir })
			const running = context.executeCommand(process.execPath, [script, processToken, marker], {
				timeoutMs: 60_000,
			})
			await waitUntil(() => existsSync(marker))

			const started = Date.now()
			await context.teardown()
			const elapsed = Date.now() - started
			await expect(running).resolves.toMatchObject({
				exitCode: null,
				termination: { origin: 'teardown', admitted: true },
			})

			expect(
				elapsed,
				'teardown returned before the escalation boundary closed',
			).toBeGreaterThanOrEqual(2_500)
			expect(survivorPids(processToken)).toEqual([])
		}, 15_000)
	},
)
