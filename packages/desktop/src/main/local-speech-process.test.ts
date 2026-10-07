import type { ChildProcess, execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import {
	LocalSpeechInstallShutdownError,
	LocalSpeechInstallerProcesses,
} from './local-speech-process.js'

class CommandChild extends EventEmitter {
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	pid = 43210
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	close(code = 1): void {
		this.exitCode = code
		this.emit('close', code)
	}
}
function fixture(platform: NodeJS.Platform = 'win32') {
	const child = new CommandChild()
	const callbacks: ((error: Error | null) => void)[] = []
	const start = vi.fn(() => child as unknown as ChildProcess)
	const stopTree = vi.fn(
		(
			_program: string,
			_args: string[],
			_options: unknown,
			callback: (error: Error | null) => void,
		) => {
			callbacks.push(callback)
			return {} as ChildProcess
		},
	)
	const killGroup = vi.fn()
	const processes = new LocalSpeechInstallerProcesses({
		platform,
		spawn: start as unknown as typeof spawn,
		execFile: stopTree as unknown as typeof execFile,
		killGroup,
	})
	return { child, start, stopTree, callbacks, processes, killGroup }
}

it('settles successful commands only on actual close and does not launch an already aborted command', async () => {
	const f = fixture()
	const run = f.processes.run('/trusted/python', ['-I', '-c', 'print(1)'], {
		cwd: '/owned/runtime',
	})
	f.child.stdout.write('1\n')
	f.child.close(0)
	expect(await run).toBe('1\n')
	const aborted = new AbortController()
	aborted.abort()
	await expect(
		f.processes.run('/trusted/python', [], { cwd: '/owned/runtime', signal: aborted.signal }),
	).rejects.toThrow('cancelled')
	expect(f.start).toHaveBeenCalledTimes(1)
	await f.processes.close()
	expect(f.stopTree).not.toHaveBeenCalled()
})

it('awaits successful Windows tree termination and actual handle closure before admitting rollback', async () => {
	const f = fixture()
	const controller = new AbortController()
	const run = f.processes.run('/trusted/python', ['-I', '-m', 'venv'], {
		cwd: '/owned/runtime',
		signal: controller.signal,
	})
	let settled = false
	void run.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)
	const rejected = expect(run).rejects.toThrow('cancelled')
	controller.abort()
	expect(f.stopTree.mock.calls[0]?.[1]).toEqual(['/pid', '43210', '/t', '/f'])
	expect(f.start.mock.calls[0]).toBeDefined()
	await Promise.resolve()
	expect(settled).toBe(false)
	f.child.close()
	await Promise.resolve()
	expect(settled).toBe(false)
	f.callbacks[0]!(null)
	await rejected
	expect(settled).toBe(true)
	await f.processes.close()
})

it('does not settle after tree-stop success until the owned child has actually closed', async () => {
	const f = fixture()
	const controller = new AbortController()
	const run = f.processes.run('/trusted/python', [], {
		cwd: '/owned/runtime',
		signal: controller.signal,
	})
	let settled = false
	void run.catch(() => {
		settled = true
	})
	const rejected = expect(run).rejects.toThrow('cancelled')
	controller.abort()
	f.callbacks[0]!(null)
	await Promise.resolve()
	expect(settled).toBe(false)
	f.child.close()
	await rejected
})

it('retains failed tree-stop ownership for close retry and never allows a new installer during shutdown', async () => {
	const f = fixture()
	const controller = new AbortController()
	const run = f.processes.run('/trusted/python', [], {
		cwd: '/owned/runtime',
		signal: controller.signal,
	})
	const rejected = expect(run).rejects.toBeInstanceOf(LocalSpeechInstallShutdownError)
	controller.abort()
	f.callbacks[0]!(new Error('test OS refusal'))
	await rejected
	const closing = f.processes.close()
	expect(f.stopTree).toHaveBeenCalledTimes(2)
	expect(f.stopTree.mock.calls[1]?.[1]).toEqual(['/pid', '43210', '/t', '/f'])
	await expect(f.processes.run('/trusted/python', [], { cwd: '/owned/runtime' })).rejects.toThrow(
		'cancelled',
	)
	f.callbacks[1]!(null)
	f.child.close()
	await closing
})

it('never targets the exited parent’s reusable PID when a descendant keeps its handles open', async () => {
	const f = fixture()
	const controller = new AbortController()
	const run = f.processes.run('/trusted/python', [], {
		cwd: '/owned/runtime',
		signal: controller.signal,
	})
	const rejected = expect(run).rejects.toBeInstanceOf(LocalSpeechInstallShutdownError)
	f.child.exitCode = 0
	controller.abort()
	await rejected
	expect(f.stopTree).not.toHaveBeenCalled()
	await expect(f.processes.close()).rejects.toBeInstanceOf(LocalSpeechInstallShutdownError)
	f.child.close(0)
	await f.processes.close()
})

it('terminates only the dedicated Unix process group and waits for closure', async () => {
	const f = fixture('linux')
	const controller = new AbortController()
	const run = f.processes.run('/trusted/python', [], {
		cwd: '/owned/runtime',
		signal: controller.signal,
	})
	const rejected = expect(run).rejects.toThrow('cancelled')
	controller.abort()
	expect(f.killGroup).toHaveBeenCalledExactlyOnceWith(-43210, 'SIGKILL')
	expect(f.stopTree).not.toHaveBeenCalled()
	f.child.close()
	await rejected
})
