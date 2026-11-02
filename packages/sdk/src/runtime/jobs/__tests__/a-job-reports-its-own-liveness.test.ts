import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JobTool } from '../../../tools/builtins/job.js'
import { BackgroundJobRegistry, bindOwner } from '../registry.js'

function fakeProcess(pid?: number) {
	const child = Object.assign(new EventEmitter(), {
		pid,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	})
	return {
		child,
		out: (text: string) => child.stdout.emit('data', Buffer.from(text)),
		close: (code: number | null) => child.emit('close', code, null),
		spawn: () => ({ child: child as unknown as ReturnType<typeof spawn> }),
	}
}

describe('a background job records when and what it last wrote', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000_000)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('stamps the time and the last non-empty line on every write', () => {
		const registry = new BackgroundJobRegistry()
		const proc = fakeProcess()
		const job = registry.start({
			owner: 'o',
			command: 'build',
			workingDirectory: process.cwd(),
			spawn: proc.spawn,
		})
		expect(registry.get(job.id).lastOutputAt).toBeUndefined()

		vi.setSystemTime(1_004_000)
		proc.out('compiling a\n\u001b[32mcompiling b\u001b[0m\n\n')
		expect(registry.get(job.id)).toMatchObject({
			lastOutputAt: 1_004_000,
			lastOutputLine: 'compiling b',
		})

		vi.setSystemTime(1_009_000)
		proc.out('x'.repeat(400))
		const line = registry.get(job.id).lastOutputLine ?? ''
		expect(line.length).toBe(160)
		expect(line.endsWith('…')).toBe(true)
		expect(registry.get(job.id).lastOutputAt).toBe(1_009_000)
	})

	it('asks the process, not the record, whether the job is alive', () => {
		const registry = new BackgroundJobRegistry()
		const kill = vi.spyOn(process, 'kill')
		const proc = fakeProcess(4242)
		const job = registry.start({
			owner: 'o',
			command: 'serve',
			workingDirectory: process.cwd(),
			spawn: proc.spawn,
		})
		// The record says running; the probe finds no such group.
		kill.mockImplementation(() => {
			throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
		})
		expect(registry.get(job.id).status).toBe('running')
		expect(registry.isAlive(job.id)).toBe(false)
		kill.mockImplementation(() => true)
		expect(registry.isAlive(job.id)).toBe(process.platform === 'win32' ? true : true)
		expect(kill).toHaveBeenCalledWith(-4242, 0)
		kill.mockRestore()
	})

	it('treats a job with no process of its own as alive while the registry says running', () => {
		const registry = new BackgroundJobRegistry()
		const proc = fakeProcess()
		const job = registry.start({
			owner: 'o',
			command: 'watch',
			workingDirectory: process.cwd(),
			spawn: proc.spawn,
		})
		expect(registry.isAlive(job.id)).toBe(true)
		proc.close(0)
		expect(registry.isAlive(job.id)).toBe(false)
		expect(registry.isAlive('b00000000')).toBe(false)
	})

	it('lists a running job with its verdict, its silence and its last line', async () => {
		const registry = new BackgroundJobRegistry()
		const proc = fakeProcess()
		const bound = bindOwner(registry, 'o')
		const spawnWith = bindOwner(registry, 'o', { spawn: () => ({ child: proc.child }) as never })
		const started = spawnWith.start({ command: 'npm test', workingDirectory: process.cwd() })

		vi.setSystemTime(1_010_000)
		proc.out('running suite one\n')
		vi.setSystemTime(1_020_000)
		const progressing = await JobTool.execute({ action: 'list' }, {
			backgroundJobs: bound,
		} as never)
		expect(progressing.output).toBe(
			`job ${started.id} "npm test" - progressing - last progress 10s ago - at: running suite one`,
		)

		vi.setSystemTime(1_000_000 + 10_000 + 130_000)
		const stalled = await JobTool.execute({ action: 'list' }, { backgroundJobs: bound } as never)
		expect(stalled.output).toContain('stalled - last progress 2m 10s ago')

		proc.close(0)
		const ended = await JobTool.execute({ action: 'list' }, { backgroundJobs: bound } as never)
		expect(ended.output).toContain(`${started.id}  exited`)
	})
})
