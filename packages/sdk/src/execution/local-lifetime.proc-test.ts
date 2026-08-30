import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('condition did not become true before deadline')
		await sleep(20)
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
			const script = join(dir, 'parent-exits.cjs')
			writeFileSync(
				script,
				[
					"const { spawn } = require('node:child_process')",
					"const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[2]], { stdio: 'inherit' })",
					"held.once('spawn', () => { process.stdout.write('parent-exited\\n'); process.exit(0) })",
				].join('\n'),
			)

			const context = new LocalExecutionContext({ id: 'deadline', cwd: dir })
			const started = Date.now()
			const result = await context.executeCommand(process.execPath, [script, processToken], {
				timeoutMs: 100,
			})
			const elapsed = Date.now() - started

			expect(result.stdout).toContain('parent-exited')
			expect(elapsed, 'the promise waited for the descendant instead of its deadline').toBeLessThan(
				2_000,
			)
			await waitUntil(() => survivorPids(processToken).length === 0, 1_000)
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
			await waitUntil(() => existsSync(marker), 2_000)

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
			expect(elapsed, 'teardown did not deliver the bounded SIGKILL escalation').toBeLessThan(8_000)
			expect(survivorPids(processToken)).toEqual([])
		}, 15_000)
	},
)
