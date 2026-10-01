import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './rpc-client.js'
vi.mock('node:child_process', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:child_process')>()
	return { ...original, spawn: vi.fn(original.spawn), execFile: vi.fn(original.execFile) }
})
const nativePlatform = process.platform
const clients: RuntimeClient[] = []
const fixture = fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))
function client(env = process.env) {
	const runtime = new RuntimeClient(process.cwd(), {
		program: process.execPath,
		args: [fixture],
		env,
	})
	clients.push(runtime)
	return runtime
}
afterEach(async () => {
	Object.defineProperty(process, 'platform', { value: nativePlatform })
	vi.useRealTimers()
	vi.mocked(spawn).mockClear()
	vi.mocked(execFile).mockClear()
	await Promise.all(clients.splice(0).map((runtime) => runtime.close()))
})
it('decodes a response split within UTF-8 and correlates actual process replies', async () => {
	const runtime = client()
	await runtime.start()
	expect(await runtime.request('test/echo')).toBe('Türkçe 🧪')
})
it('rejects all pending callers when the process exits', async () => {
	const runtime = client()
	await runtime.start()
	const pending = expect(runtime.request('test/wait', {}, 0)).rejects.toThrow('connection closed')
	const exit = expect(runtime.request('test/exit')).rejects.toThrow('connection closed')
	await Promise.all([pending, exit])
})
it('finishes shutdown after the owned process has already closed from a signal', async () => {
	const runtime = client()
	await runtime.start()
	await expect(runtime.request('test/signal')).rejects.toThrow('connection closed')
	// Await the actual close completion; an already emitted close event cannot
	// be awaited again. Vitest's timeout catches a genuine stalled shutdown.
	await runtime.close()
	await runtime.close()
})
it('reports malformed protocol output and rejects a pending prompt', async () => {
	const runtime = client()
	await runtime.start()
	await expect(runtime.request('test/malformed')).rejects.toThrow()
	await expect(runtime.request('test/echo')).rejects.toThrow('not connected')
})
it('fails initialization before exposing an incompatible runtime', async () => {
	await expect(client({ ...process.env, FIXTURE_INCOMPATIBLE: '1' }).start()).rejects.toThrow(
		'Update Namzu',
	)
})

function windowsFixture() {
	Object.defineProperty(process, 'platform', { value: 'win32' })
	const child = Object.assign(new EventEmitter(), {
		pid: 7345,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
	child.stdin.on('data', (chunk: Buffer) => {
		const frame = JSON.parse(chunk.toString())
		child.stdout.write(
			`${JSON.stringify({
				jsonrpc: '2.0',
				id: frame.id,
				result: {
					agentInfo: { name: 'namzu' },
					extensions: [
						'namzu/project/status',
						'namzu/project/trust',
						'namzu/conversations/list',
						'namzu/conversations/history',
						'namzu/providers/status',
						'namzu/providers/select',
						'namzu/jobs/list',
						'namzu/jobs/read',
						'namzu/jobs/stop',
					],
				},
			})}\n`,
		)
	})
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
	return { child, runtime: new RuntimeClient(process.cwd(), { program: 'cmd.exe', args: [] }) }
}

it('lets the owned Windows runtime finish its EOF cleanup without tree killing', async () => {
	vi.useFakeTimers()
	const { child, runtime } = windowsFixture()
	await runtime.start()
	const closed = runtime.close()
	child.emit('close', 0)
	await closed
	await vi.advanceTimersByTimeAsync(5_000)
	expect(execFile).not.toHaveBeenCalled()
	expect(child.kill).not.toHaveBeenCalled()
})

it('forces only the live owned Windows tree after EOF grace and permits failure retry', async () => {
	vi.useFakeTimers()
	const { child, runtime } = windowsFixture()
	await runtime.start()
	vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
		callback?.(new Error('access denied'), '', '')
		return child as unknown as ReturnType<typeof execFile>
	})
	const failed = expect(runtime.close()).rejects.toThrow(
		'Could not stop the owned Namzu process tree',
	)
	await vi.advanceTimersByTimeAsync(5_000)
	await failed
	expect(execFile).toHaveBeenCalledWith(
		expect.stringContaining('taskkill.exe'),
		['/pid', '7345', '/t', '/f'],
		{ windowsHide: true },
		expect.any(Function),
	)
	expect(child.kill).not.toHaveBeenCalled()
	vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
		child.emit('close', 0)
		callback?.(null, '', '')
		return child as unknown as ReturnType<typeof execFile>
	})
	const retried = runtime.close()
	await vi.advanceTimersByTimeAsync(5_000)
	await retried
	expect(execFile).toHaveBeenCalledTimes(2)
})

it('refuses to target a Windows PID after its owned wrapper has exited', async () => {
	vi.useFakeTimers()
	const { child, runtime } = windowsFixture()
	await runtime.start()
	child.exitCode = 0
	const failed = expect(runtime.close()).rejects.toThrow('descendants retained')
	await vi.advanceTimersByTimeAsync(5_000)
	await failed
	expect(execFile).not.toHaveBeenCalled()
	child.emit('close', 0)
	await runtime.close()
})

it('retains split UTF-8 runtime diagnostics without replacement characters', async () => {
	const { child, runtime } = windowsFixture()
	await runtime.start()
	const bytes = Buffer.from('Türkçe 🧪')
	child.stderr.emit('data', bytes.subarray(0, 2))
	child.stderr.emit('data', bytes.subarray(2))
	expect((runtime as unknown as { diagnostic: string }).diagnostic).toBe('Türkçe 🧪')
	child.emit('close', 0)
	await runtime.close()
})
