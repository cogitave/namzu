import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A background job is stopped when the host process ends by `process.exit` or
 * an uncaught exception.
 *
 * Measured before the finalizer existed: a host that started a job running
 * `sleep` and then exited left the shell and its sleeps running, reparented to
 * init, with no id left that could stop them. Real processes on both sides,
 * because a mock child proves nothing about what survives an exit. A host killed
 * by a signal it does not handle runs no exit listener at all, which is outside
 * what this can cover and is not asserted.
 */

const ROOT = new URL('../../../../dist/index.js', import.meta.url).pathname

/** Gone, or a zombie waiting to be reaped: either way it is not running. */
function stopped(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
		return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
	} catch {
		return true
	}
}

/** Every process whose command line carries the marker. */
function withMarker(marker: string): number[] {
	const found: number[] = []
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, 'utf-8').includes(marker))
				found.push(Number(entry))
		} catch {
			// gone between the listing and the read
		}
	}
	return found
}

/** Run a host that starts a long job, then ends as `how` says; returns the job's processes. */
async function runHost(how: 'exit' | 'throw', seconds: number): Promise<number[]> {
	const marker = `sleep ${seconds}`
	const script = `
		import(${JSON.stringify(ROOT)}).then(async ({ BackgroundJobRegistry }) => {
			const registry = new BackgroundJobRegistry()
			const job = registry.start({
				owner: 'o',
				command: ${JSON.stringify(`${marker} & ${marker}`)},
				workingDirectory: process.cwd(),
			})
			await registry.awaitStarted(job.id)
			process.stdout.write('ready\\n')
			process.stdin.once('data', () => {
				if (${JSON.stringify(how)} === 'throw') throw new Error('host crashed')
				process.exit(0)
			})
		})
	`
	const host = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] })
	await new Promise<void>((resolve) => host.stdout.once('data', () => resolve()))
	// The shell forks its sleeps right after it starts; wait for the event, not a guess.
	let pids = withMarker(marker)
	while (pids.filter((pid) => !stopped(pid)).length < 2) {
		await new Promise((resolve) => setImmediate(resolve))
		pids = withMarker(marker)
	}
	const ended = new Promise<void>((resolve) => host.once('close', () => resolve()))
	host.stdin.write('go\n')
	await ended
	return pids
}

describe.skipIf(process.platform !== 'linux')('a job does not outlive its host', () => {
	it.each([
		['exit', 7101],
		['throw', 7102],
	] as const)(
		'is stopped when the host ends by %s',
		async (how, seconds) => {
			const pids = await runHost(how, seconds)
			// At least both sleeps.
			expect(pids.length).toBeGreaterThanOrEqual(2)
			for (const pid of pids) {
				// A SIGKILL is prompt but not synchronous with the signal; wait for the event.
				while (!stopped(pid)) await new Promise((resolve) => setImmediate(resolve))
			}
			expect(pids.every(stopped)).toBe(true)
		},
		30_000,
	)
})
