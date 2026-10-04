import { describe, expect, it } from 'vitest'
import { startHarnessProcess } from './process.js'

describe('native harness JSON transport', () => {
	it('passes literal argv, decodes split UTF-8 and confirms EOF shutdown', async () => {
		const literal = 'path with spaces & $(not-a-shell)'
		let receive!: (frame: unknown) => void
		const received = new Promise<unknown>((resolve) => {
			receive = resolve
		})
		const child = startHarnessProcess(
			{
				executable: process.execPath,
				args: [
					'-e',
					`const bytes=Buffer.from(JSON.stringify({text:'ö',arg:process.argv[1]})+'\\n'); process.stdout.write(bytes.subarray(0,10)); process.stdout.write(bytes.subarray(10)); process.stdin.resume()`,
					literal,
				],
			},
			{
				cwd: process.cwd(),
				onFrame: receive,
				onClosed: () => undefined,
			},
		)
		expect(await received).toEqual({ text: 'ö', arg: literal })
		expect(await child.close()).toEqual({ stopped: true })
		await expect(child.write({ late: true })).rejects.toThrow('closed')
	})
	it('serializes async frame sinks and drains them before publishing closure', async () => {
		let first!: () => void
		let release!: () => void
		const firstFrame = new Promise<void>((resolve) => {
			first = resolve
		})
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const observed: string[] = []
		const child = startHarnessProcess(
			{
				executable: process.execPath,
				args: ['-e', `process.stdout.write('{"n":1}\\n{"n":2}\\n')`],
			},
			{
				cwd: process.cwd(),
				onFrame: async (frame) => {
					const n = (frame as { n: number }).n
					if (n === 1) {
						first()
						await gate
					}
					observed.push(String(n))
				},
				onClosed: () => {
					observed.push('closed')
				},
			},
		)
		await firstFrame
		expect(observed).toEqual([])
		release()
		await child.closed
		expect(observed).toEqual(['1', '2', 'closed'])
	})
	it('stops on invalid JSON without publishing raw stderr or failed frame content', async () => {
		const frames: unknown[] = []
		let failure: Error | undefined
		const child = startHarnessProcess(
			{
				executable: process.execPath,
				args: [
					'-e',
					`process.stderr.write('private-credential'); process.stdout.write('invalid-private-frame\\n'); process.stdin.resume()`,
				],
			},
			{
				cwd: process.cwd(),
				onFrame: (frame) => {
					frames.push(frame)
				},
				onClosed: (error) => {
					failure = error
				},
			},
		)
		await child.closed
		expect(frames).toEqual([])
		expect(failure?.message).toBe('Harness emitted an invalid JSON frame.')
		expect(await child.close()).toEqual({ stopped: true })
	})
	it('refuses an already cancelled launch before starting the child', () => {
		const abort = new AbortController()
		abort.abort(new Error('cancelled-before-spawn'))
		expect(() =>
			startHarnessProcess(
				{ executable: process.execPath, args: [] },
				{
					cwd: process.cwd(),
					signal: abort.signal,
					onFrame: () => undefined,
					onClosed: () => undefined,
				},
			),
		).toThrow('cancelled-before-spawn')
	})
	it('drops queued native frames after a persistence/sink failure', async () => {
		const frames: unknown[] = []
		const child = startHarnessProcess(
			{
				executable: process.execPath,
				args: ['-e', `process.stdout.write('{"n":1}\\n{"n":2}\\n'); process.stdin.resume()`],
			},
			{
				cwd: process.cwd(),
				onFrame: async (frame) => {
					frames.push(frame)
					throw new Error('sink failed')
				},
				onClosed: () => undefined,
			},
		)
		await child.closed
		expect(frames).toEqual([{ n: 1 }])
	})
})
