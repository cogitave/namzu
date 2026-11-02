import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A job registered with a kill of its own is signalled through that kill, and
 * the host's exit also sweeps by environment tag, so a descendant that started
 * a session of its own is stopped too. Measured before the sweep covered such
 * jobs: the job's own kill did nothing for the escaped `sleep`, which outlived
 * the host.
 */

const DIST = new URL('../../../../dist/', import.meta.url).pathname

function stopped(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
		return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
	} catch {
		return true
	}
}

function withMarker(marker: string): number[] {
	const found: number[] = []
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replaceAll('\0', ' ')
			if (cmdline.includes(marker)) found.push(Number(entry))
		} catch {
			// gone between the listing and the read
		}
	}
	return found
}

describe.skipIf(process.platform !== 'linux')(
	'the host exit sweeps a job that has its own kill',
	() => {
		it('stops a descendant that left the process group', async () => {
			const marker = 'sleep 7103'
			const script = `
			Promise.all([
				import(${JSON.stringify(`${DIST}runtime/jobs/host-exit-finalizer.js`)}),
				import(${JSON.stringify(`${DIST}process/kill-tree.js`)}),
			]).then(async ([{ stopAtHostExit }, { registerProcessTag }]) => {
				const { spawn } = await import('node:child_process')
				const tag = 'host-exit-own-kill'
				const child = spawn('sh', ['-c', ${JSON.stringify(`setsid ${marker} & wait`)}], {
					detached: true,
					stdio: 'ignore',
					env: { ...process.env, NAMZU_SHELL_TAG: tag },
				})
				registerProcessTag(child, tag)
				// The job's own kill reaches nothing: only the sweep can find the escaped sleep.
				stopAtHostExit({ child, kill: () => {} })
				process.stdout.write('ready\\n')
				process.stdin.once('data', () => process.exit(0))
			})
		`
			const host = spawn(process.execPath, ['-e', script], {
				stdio: ['pipe', 'pipe', 'ignore'],
			})
			await new Promise<void>((resolve) => host.stdout.once('data', () => resolve()))
			let pids = withMarker(marker)
			while (pids.filter((pid) => !stopped(pid)).length < 1) {
				await new Promise((resolve) => setImmediate(resolve))
				pids = withMarker(marker)
			}
			const ended = new Promise<void>((resolve) => host.once('close', () => resolve()))
			host.stdin.write('go\n')
			await ended
			for (const pid of pids) {
				while (!stopped(pid)) await new Promise((resolve) => setImmediate(resolve))
			}
			expect(pids.every(stopped)).toBe(true)
		}, 30_000)
	},
)
