import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../registry.js'

/**
 * The seam a sandbox uses: it starts the process, the registry keeps it —
 * output, lifetime, ownership — and stops it through the spawner's own
 * kill, which is what reaches inside a boundary the registry cannot see.
 */

const skip = process.platform === 'win32'

describe.skipIf(skip)('a job started by its sandbox', () => {
	it('is read and killed through the spawner, not the host shell', async () => {
		const registry = new BackgroundJobRegistry()
		const kills: NodeJS.Signals[] = []
		const seen: { command: string; workingDirectory: string }[] = []
		const jobs = bindOwner(registry, 'o', {
			workingDirectory: process.cwd(),
			spawn: (params) => {
				seen.push({ command: params.command, workingDirectory: params.workingDirectory })
				const child = spawn('/bin/sh', ['-c', params.command], {
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				})
				return {
					child,
					kill: (signal) => {
						kills.push(signal)
						if (child.pid) process.kill(-child.pid, signal)
					},
				}
			},
		})
		const job = jobs.start({ command: 'echo inside; sleep 30' })
		await new Promise((r) => setTimeout(r, 300))
		expect(seen).toEqual([{ command: 'echo inside; sleep 30', workingDirectory: process.cwd() }])
		expect(jobs.read(job.id).chunk).toContain('inside')
		const stopped = await jobs.kill(job.id)
		expect(stopped.status).toBe('killed')
		expect(kills[0]).toBe('SIGTERM')
	})
})
