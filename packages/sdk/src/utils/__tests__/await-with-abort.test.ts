import { getEventListeners } from 'node:events'
import { expect, it } from 'vitest'
import { awaitWithAbort } from '../await-with-abort.js'

it.each(['success', 'failure', 'cancel'] as const)(
	'releases its subscription after %s',
	async (mode) => {
		const controller = new AbortController()
		let resolve!: (value: string) => void
		let reject!: (reason: Error) => void
		const operation = new Promise<string>((ok, fail) => {
			resolve = ok
			reject = fail
		})
		const waiting = awaitWithAbort(operation, controller.signal)
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
		if (mode === 'success') {
			resolve('original result')
			await expect(waiting).resolves.toBe('original result')
		} else if (mode === 'failure') {
			reject(new Error('backend failed'))
			await expect(waiting).rejects.toThrow('backend failed')
		} else {
			controller.abort(new Error('stop waiting'))
			await expect(waiting).rejects.toThrow('stop waiting')
			// Still observed after the caller has left: no unhandled rejection.
			reject(new Error('late backend failure'))
		}
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	},
)

it('observes an already-started operation even when cancellation precedes the wait', async () => {
	const controller = new AbortController()
	controller.abort(new Error('already stopped'))
	await expect(
		awaitWithAbort(Promise.reject(new Error('backend failed')), controller.signal),
	).rejects.toThrow('already stopped')
	expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('cannot have cancellation hidden by an earlier event listener', async () => {
	const controller = new AbortController()
	controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation())
	const waiting = awaitWithAbort(new Promise<void>(() => {}), controller.signal)
	controller.abort(new Error('must still stop'))
	await expect(waiting).rejects.toThrow('must still stop')
	expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
})
