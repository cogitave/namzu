import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { type DesktopDiagnosticSink, DesktopDiagnostics, observeDesktopIpc } from './diagnostics.js'
import { ExpectedRuntimeCloseError } from './expected-close.js'
import { RuntimeClient } from './rpc-client.js'
vi.mock('node:child_process', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:child_process')>()
	return { ...original, spawn: vi.fn(original.spawn), execFile: vi.fn(original.execFile) }
})
const nativePlatform = process.platform
const clients: RuntimeClient[] = []
const diagnosticRoots: string[] = []
const fixture = fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))
function client(env = process.env, diagnostics?: DesktopDiagnosticSink) {
	const runtime = new RuntimeClient(
		process.cwd(),
		{
			program: process.execPath,
			args: [fixture],
			env,
		},
		diagnostics,
	)
	clients.push(runtime)
	return runtime
}
afterEach(async () => {
	Object.defineProperty(process, 'platform', { value: nativePlatform })
	vi.useRealTimers()
	vi.mocked(spawn).mockClear()
	vi.mocked(execFile).mockClear()
	await Promise.all(clients.splice(0).map((runtime) => runtime.close()))
	for (const root of diagnosticRoots.splice(0)) rmSync(root, { recursive: true, force: true })
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

it('persists a handled actual CLI RPC failure without prompt, error payload or credentials', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-rpc-diagnostics-'))
	diagnosticRoots.push(root)
	const sink = new DesktopDiagnostics(root)
	const runtime = client(process.env, sink)
	await runtime.start()
	await expect(
		runtime.request('namzu/pals/computer/start', {
			prompt: 'PRIVATE_PROMPT_FIXTURE',
			token: 'PRIVATE_TOKEN_FIXTURE',
		}),
	).rejects.toThrow('local Docker')
	const text = readFileSync(sink.path, 'utf8')
	const failed = text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find((record) => record.eventName === 'namzu.desktop.cli_request_failed')
	expect(failed.attributes).toMatchObject({
		'namzu.desktop.operation': 'namzu/pals/computer/start',
		'namzu.desktop.request': 2,
		'namzu.desktop.rpcCode': -32603,
		'namzu.desktop.failure.reason': 'docker-engine-or-image-required',
		'namzu.desktop.connection': expect.stringMatching(/^[0-9a-f-]{36}$/),
	})
	for (const privateText of [
		'PRIVATE_PROMPT_FIXTURE',
		'PRIVATE_TOKEN_FIXTURE',
		'SECRET_DIAGNOSTIC_FIXTURE',
		'private prompt payload',
	])
		expect(text).not.toContain(privateText)
	await runtime.close()
	expect(readFileSync(sink.path, 'utf8')).not.toContain('namzu.desktop.cli_transport_failed')
})

it('records an actual successful RPC carrying an error turn outcome without retaining its history', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-rpc-turn-error-'))
	diagnosticRoots.push(root)
	const sink = new DesktopDiagnostics(root)
	const runtime = client(process.env, sink)
	await runtime.start()
	expect(
		await runtime.request('session/prompt', { prompt: 'Fail turn with fixture' }),
	).toMatchObject({ stopReason: 'error' })
	const text = readFileSync(sink.path, 'utf8')
	const failed = text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find((record) => record.eventName === 'namzu.desktop.cli_turn_failed')
	expect(failed.attributes).toMatchObject({
		'namzu.desktop.operation': 'session/prompt',
		'namzu.desktop.request': 2,
		'namzu.desktop.failure.reason': 'turn-failed',
	})
	expect(text).not.toContain('PRIVATE_TURN_HISTORY_FIXTURE')
	expect(text).not.toContain('Fail turn with fixture')
})

function windowsFixture(diagnostics?: DesktopDiagnosticSink) {
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
	return {
		child,
		runtime: new RuntimeClient(process.cwd(), { program: 'cmd.exe', args: [] }, diagnostics),
	}
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

it('captures otherwise unreported CLI stderr and transport failures with connection correlation', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-rpc-stderr-'))
	diagnosticRoots.push(root)
	const sink = new DesktopDiagnostics(root)
	const { child, runtime } = windowsFixture(sink)
	await runtime.start()
	child.stderr.emit(
		'data',
		Buffer.from('The provider catalogue could not be loaded. PRIVATE_STDERR_FIXTURE\n'),
	)
	child.emit('error', Object.assign(new Error('PRIVATE_ERROR_FIXTURE'), { code: 'ECONNRESET' }))
	const entries = readFileSync(sink.path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
	const stderr = entries.find((entry) => entry.eventName === 'namzu.desktop.cli_stderr')
	const failed = entries.find((entry) => entry.eventName === 'namzu.desktop.cli_transport_failed')
	expect(stderr.attributes['namzu.desktop.failure.reason']).toBe('model-catalogue-unavailable')
	expect(failed.attributes['namzu.desktop.failure.code']).toBe('ECONNRESET')
	expect(failed.attributes['namzu.desktop.connection']).toBe(
		stderr.attributes['namzu.desktop.connection'],
	)
	expect(readFileSync(sink.path, 'utf8')).not.toContain('PRIVATE_')
	child.emit('close', 1)
	await runtime.close()
})

it('decodes split structured stderr lines, preserves INFO startup and flushes a final warning', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-rpc-stderr-level-'))
	diagnosticRoots.push(root)
	const sink = new DesktopDiagnostics(root)
	const { child, runtime } = windowsFixture(sink)
	await runtime.start()
	const line = JSON.stringify({
		timestamp: 1,
		observedTimestamp: 1,
		severityText: 'info',
		severityNumber: 9,
		body: 'ACP protocol server started',
		scope: { name: 'cli' },
		resource: { 'service.name': 'namzu' },
		attributes: { content: 'PRIVATE_STRUCTURED_STDERR' },
	})
	child.stderr.emit('data', Buffer.from(line.slice(0, 25)))
	expect(readFileSync(sink.path, 'utf8')).not.toContain('namzu.desktop.cli_stderr')
	child.stderr.emit(
		'data',
		Buffer.from(
			`${line.slice(25)}\n[2026-10-02T09:00:00.000Z] [INFO] [cli] ACP protocol server started\n`,
		),
	)
	child.stderr.emit('data', Buffer.from('Node runtime warning, PRIVATE_FINAL_STDERR'))
	child.emit('close', 0)
	await runtime.close()
	const text = readFileSync(sink.path, 'utf8')
	const stderr = text
		.trim()
		.split('\n')
		.map((value) => JSON.parse(value))
		.filter((record) => record.eventName === 'namzu.desktop.cli_stderr')
	expect(stderr.map((record) => record.severityText)).toEqual(['info', 'info', 'warn'])
	for (const record of stderr.slice(0, 2))
		expect(record.attributes).not.toHaveProperty('namzu.desktop.failure.reason')
	expect(text).not.toContain('PRIVATE_')
	expect(text).not.toContain('protocol-invalid')
})

it('rejects pending and later polling during explicit owned shutdown without diagnostic failure records', async () => {
	const calls: string[] = []
	const sink: DesktopDiagnosticSink = {
		record: (event) => {
			calls.push(event)
		},
	}
	const runtime = client(process.env, sink)
	await runtime.start()
	const pending = expect(
		observeDesktopIpc(sink, 'palComputer', () => runtime.request('test/wait', {}, 0), 61),
	).rejects.toBeInstanceOf(ExpectedRuntimeCloseError)
	const closed = runtime.close()
	await pending
	await expect(
		runtime.request('namzu/pals/computer/status', { palId: 'private-fixture' }),
	).rejects.toBeInstanceOf(ExpectedRuntimeCloseError)
	await closed
	expect(calls).not.toContain('cli_transport_failed')
	expect(calls).not.toContain('cli_request_failed')
	expect(calls).not.toContain('ipc_failed')
})
it('keeps an unexpected exit diagnostic and ordinary disconnected errors after cleanup', async () => {
	const calls: string[] = []
	const runtime = client(process.env, {
		record: (event) => {
			calls.push(event)
		},
	})
	await runtime.start()
	await expect(runtime.request('test/exit')).rejects.toThrow('connection closed')
	await runtime.close()
	await expect(runtime.request('namzu/pals/computer/status')).rejects.not.toBeInstanceOf(
		ExpectedRuntimeCloseError,
	)
	expect(calls).toContain('cli_transport_failed')
	expect(calls.filter((event) => event === 'cli_request_failed')).toHaveLength(2)
})
