/**
 * A termination signal reaches the App's own exit, and a hangup prints no
 * handoff to a terminal that is gone. The signal plumbing itself is
 * `termination.test.ts`; the real process is `a-terminated-run-lets-go-of-its-turn`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

type Cleanup = (signal: 'SIGTERM' | 'SIGHUP' | 'SIGINT') => Promise<void> | void

const cleanups = vi.hoisted(() => [] as Cleanup[])
const dispose = vi.hoisted(() => vi.fn())
vi.mock('../../termination.js', () => ({
	handleTerminationSignals: () => ({
		onTerminate: (cleanup: Cleanup) => cleanups.push(cleanup),
		dispose,
	}),
}))

const exited = vi.hoisted(() => ({ resolve: () => {} }))
const appExit = vi.hoisted(() => vi.fn())
const unmount = vi.hoisted(() => vi.fn(() => exited.resolve()))
const render = vi.hoisted(() =>
	vi.fn(
		(element: {
			props: {
				onExitSummary?: (value: unknown) => void
				terminationExit?: { current: (() => void) | null }
			}
		}) => {
			const done = new Promise<void>((resolve) => {
				exited.resolve = resolve
			})
			const { terminationExit, onExitSummary } = element.props
			if (terminationExit) {
				// What the App registers: stop the turn, then leave as `/exit` does.
				terminationExit.current = () => {
					appExit()
					onExitSummary?.({ conversationId: '6c43cf3e-5512-4678-9b77-179a4d4daed6' })
					exited.resolve()
				}
			}
			return { waitUntilExit: () => done, unmount }
		},
	),
)

vi.mock('ink', () => ({ render }))
vi.mock('../App.js', () => ({ App: () => null }))
vi.mock('../log-pane.js', () => ({
	installTuiLogSink: () => ({ close: vi.fn(), flush: vi.fn() }),
}))

const { launchTui } = await import('../index.js')

afterEach(() => {
	vi.restoreAllMocks()
	cleanups.splice(0)
	dispose.mockClear()
	appExit.mockClear()
	unmount.mockClear()
})

describe('launchTui on a termination signal', () => {
	it('leaves through the App, and prints the resume handoff on SIGTERM', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const launched = launchTui({ cwd: '/workspace', version: '0.0.0-test' })
		expect(cleanups).toHaveLength(1)
		await cleanups[0]?.('SIGTERM')
		await launched
		expect(appExit).toHaveBeenCalledOnce()
		expect(unmount).not.toHaveBeenCalled()
		expect(dispose).toHaveBeenCalledOnce()
		expect(write).toHaveBeenLastCalledWith(
			'To resume this conversation, run: cd /workspace && namzu resume 6c43cf3e-5512-4678-9b77-179a4d4daed6\n',
		)
	})

	it('writes nothing to a terminal that hung up', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const launched = launchTui({ cwd: '/workspace', version: '0.0.0-test' })
		await cleanups[0]?.('SIGHUP')
		await launched
		expect(appExit).toHaveBeenCalledOnce()
		expect(write.mock.calls.some(([value]) => String(value).includes('To resume'))).toBe(false)
	})
})
