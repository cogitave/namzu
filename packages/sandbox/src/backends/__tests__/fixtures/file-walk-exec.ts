import type { Sandbox, SandboxExecOptions, SandboxExecResult, SandboxFileEntry } from '@namzu/sdk'
import { expect } from 'vitest'
import { RemoteCancellationUnknownError } from '../../remote-execution-controller.js'

/** One streamed entry, with worker termination held until the test releases it. */
export function fileWalkExec(entry: SandboxFileEntry) {
	let started = false
	let signal: AbortSignal | undefined
	let onOutput: SandboxExecOptions['onOutput']
	let observedCompletion!: () => void
	const completed = new Promise<void>((resolve) => {
		observedCompletion = resolve
	})
	let observedAbort!: () => void
	const aborted = new Promise<void>((resolve) => {
		observedAbort = resolve
	})
	let finish!: (result: SandboxExecResult) => void
	let fail!: (error: Error) => void
	const terminal = new Promise<SandboxExecResult>((resolve, reject) => {
		finish = resolve
		fail = reject
	})
	return {
		aborted,
		completed,
		get started() {
			return started
		},
		get signal() {
			return signal
		},
		async exec(_command: string, _argv?: string[], options?: SandboxExecOptions) {
			started = true
			signal = options?.signal
			onOutput = options?.onOutput
			signal?.addEventListener('abort', observedAbort, { once: true })
			if (signal?.aborted) observedAbort()
			options?.onOutput?.({
				stream: 'stdout',
				data: `${JSON.stringify({ type: 'entry', ...entry })}\n`,
			})
			try {
				return await terminal
			} finally {
				signal?.removeEventListener('abort', observedAbort)
				observedCompletion()
			}
		},
		finish(complete = false) {
			if (complete) onOutput?.({ stream: 'stdout', data: '{"type":"done"}\n' })
			finish({
				exitCode: complete ? 0 : 143,
				stdout: '',
				stderr: '',
				timedOut: false,
				durationMs: 1,
			})
		},
		fail,
	}
}

export async function checkFileWalkOwnership(
	sandbox: Sandbox,
	worker: ReturnType<typeof fileWalkExec>,
	entry: SandboxFileEntry,
	stop: 'complete' | 'return' | 'caller' | 'unknown',
): Promise<void> {
	const caller = new AbortController()
	expect(sandbox.walkFiles).toBeTypeOf('function')
	const iterator = sandbox.walkFiles!(sandbox.rootDir, {
		maxEntries: 2,
		pattern: '*.ts',
		signal: caller.signal,
	})[Symbol.asyncIterator]()
	try {
		expect(worker.started).toBe(false)
		await expect(iterator.next()).resolves.toMatchObject({ done: false, value: entry })
		expect(sandbox.status).toBe('busy')
		if (stop === 'complete') {
			worker.finish(true)
			await worker.completed
			await Promise.resolve()
			expect(sandbox.status).toBe('busy')
			await expect(iterator.next()).resolves.toMatchObject({ done: true })
			expect(sandbox.status).toBe('ready')
			return
		}
		if (stop === 'caller') caller.abort(new Error('stop file discovery'))
		const pending = stop === 'caller' ? iterator.next() : iterator.return!()
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		)
		await worker.aborted
		expect(worker.signal?.aborted).toBe(true)
		expect(sandbox.status).toBe('busy')
		if (stop === 'unknown')
			worker.fail(new RemoteCancellationUnknownError('worker outcome unknown'))
		else worker.finish()
		const error = await outcome
		if (stop === 'unknown') {
			expect(error).toMatchObject({ retirement: { accepted: true } })
			expect(sandbox.status).toBe('destroyed')
		} else {
			if (stop === 'caller') expect(error).toBe(caller.signal.reason)
			else expect(error).toBeUndefined()
			expect(sandbox.status).toBe('ready')
		}
	} finally {
		worker.finish()
		await iterator.return?.().catch(() => {})
	}
}
