/** Clean launch settlement must never replay the hidden diagnostic buffer. */

import { afterEach, describe, expect, it, vi } from 'vitest'

const close = vi.hoisted(() => vi.fn())
const flush = vi.hoisted(() => vi.fn())
const waitUntilExit = vi.hoisted(() => vi.fn(async () => {}))
const render = vi.hoisted(() =>
	vi.fn((element: { props: { onExitSummary?: (value: unknown) => void } }) => {
		element.props.onExitSummary?.({ conversationId: 'ses_clean' })
		return { waitUntilExit }
	}),
)

vi.mock('ink', () => ({ render }))
vi.mock('../App.js', () => ({ App: () => null }))
vi.mock('../log-pane.js', () => ({
	installTuiLogSink: () => ({ close, flush }),
}))

const { launchTui } = await import('../index.js')

afterEach(() => {
	vi.restoreAllMocks()
	close.mockClear()
	flush.mockClear()
	waitUntilExit.mockClear()
	render.mockClear()
})

describe('launchTui clean settlement', () => {
	it('discards diagnostic history before printing the resumable conversation handoff', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

		await launchTui({ cwd: '/workspace', version: '0.0.0-test' })

		expect(close).toHaveBeenCalledOnce()
		expect(flush).not.toHaveBeenCalled()
		expect(write).toHaveBeenLastCalledWith(
			'To resume this conversation, run: namzu resume ses_clean\n',
		)
	})
})
