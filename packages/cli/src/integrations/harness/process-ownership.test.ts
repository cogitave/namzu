import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHarnessProcess } from './process.js'

const nativePlatform = process.platform
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => mocked)

interface OwnedChild extends EventEmitter {
	pid: number
	stdin: PassThrough
	stdout: PassThrough
	stderr: PassThrough
}
let child: OwnedChild
beforeEach(() => {
	vi.useFakeTimers()
	Object.defineProperty(process, 'platform', { value: 'win32' })
	child = Object.assign(new EventEmitter(), {
		pid: 8123,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	})
	mocked.spawn.mockReset().mockReturnValue(child)
	mocked.execFile.mockReset()
})
afterEach(() => {
	Object.defineProperty(process, 'platform', { value: nativePlatform })
	vi.useRealTimers()
})

function owned() {
	return startHarnessProcess(
		{ executable: 'C:\\native\\codex.exe', args: ['app-server'] },
		{ cwd: 'C:\\workspace', onFrame: () => undefined, onClosed: () => undefined },
	)
}

describe('owned Windows harness stop confirmation', () => {
	it('rejects an OS tree-stop failure, retains the live handle and retries with exact PID argv', async () => {
		mocked.execFile.mockImplementation((_executable, _args, _options, callback) =>
			callback(new Error('OS stop failed')),
		)
		const processOwner = owned()
		const rejected = expect(processOwner.close()).rejects.toThrow('tree stop failed')
		await vi.advanceTimersByTimeAsync(3000)
		await rejected
		expect(mocked.execFile).toHaveBeenCalledWith(
			expect.stringContaining('taskkill.exe'),
			['/PID', '8123', '/T', '/F'],
			expect.objectContaining({ windowsHide: true }),
			expect.any(Function),
		)
		await expect(processOwner.write({ late: true })).rejects.toThrow('closed')
		mocked.execFile.mockImplementation((_executable, _args, _options, callback) => {
			callback(null)
			child.emit('exit', 0)
			child.emit('close', 0)
		})
		const retried = processOwner.close()
		await vi.advanceTimersByTimeAsync(3000)
		expect(await retried).toEqual({ stopped: true })
		expect(mocked.spawn).toHaveBeenCalledOnce()
	})
	it('does not target an already exited and possibly reused root PID when pipes remain open', async () => {
		const processOwner = owned()
		child.emit('exit', 0)
		const rejected = expect(processOwner.close()).rejects.toThrow(
			'descendants could not be confirmed',
		)
		await vi.advanceTimersByTimeAsync(3000)
		await rejected
		expect(mocked.execFile).not.toHaveBeenCalled()
		child.emit('close', 0)
		expect(await processOwner.close()).toEqual({ stopped: true })
	})
	it('does not equate a successful taskkill receipt with confirmed native pipe/process closure', async () => {
		mocked.execFile.mockImplementation((_executable, _args, _options, callback) => callback(null))
		const processOwner = owned()
		const rejected = expect(processOwner.close()).rejects.toThrow('closure could not be confirmed')
		await vi.advanceTimersByTimeAsync(6000)
		await rejected
		child.emit('exit', 0)
		child.emit('close', 0)
		expect(await processOwner.close()).toEqual({ stopped: true })
	})
})
