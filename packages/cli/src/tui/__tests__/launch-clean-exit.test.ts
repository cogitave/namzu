/** Clean launch settlement must never replay the hidden diagnostic buffer. */

import { afterEach, describe, expect, it, vi } from 'vitest'

const close = vi.hoisted(() => vi.fn())
const flush = vi.hoisted(() => vi.fn())
const waitUntilExit = vi.hoisted(() => vi.fn(async () => {}))
const render = vi.hoisted(() =>
	vi.fn((element: { props: { onExitSummary?: (value: unknown) => void } }) => {
		element.props.onExitSummary?.({ conversationId: '6c43cf3e-5512-4678-9b77-179a4d4daed6' })
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
		expect(render).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				exitOnCtrlC: false,
				kittyKeyboard: {
					mode: 'auto',
					flags: ['disambiguateEscapeCodes'],
				},
			}),
		)
		expect(write).toHaveBeenLastCalledWith(
			'\nTo resume this conversation, run:\ncd /workspace && namzu resume 6c43cf3e-5512-4678-9b77-179a4d4daed6\n',
		)
	})

	it('prints the product command with the conversation cwd, never the supplied launcher', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		await launchTui(
			{ cwd: '/project workspace', version: '0.0.0-test' },
			{
				resumeCommand: [
					'/absolute/node',
					'--import',
					'/checkout/loader.mjs',
					'/checkout/src/bin.ts',
				],
			},
		)
		expect(write).toHaveBeenLastCalledWith(
			"\nTo resume this conversation, run:\ncd '/project workspace' && namzu resume 6c43cf3e-5512-4678-9b77-179a4d4daed6\n",
		)
	})

	it('prints no resume hint without a durable conversation', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		render.mockImplementationOnce(() => ({ waitUntilExit }))
		await launchTui(
			{ cwd: '/workspace', version: '0.0.0-test' },
			{ resumeCommand: ['/node', '/checkout/bin.js'] },
		)
		expect(write.mock.calls.some(([value]) => String(value).includes('To resume'))).toBe(false)
	})

	it('makes the input raw before Ink starts, so the terminal-support query is not echoed', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const calls: string[] = []
		const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown }
		const had = Object.getOwnPropertyDescriptor(stdin, 'isTTY')
		const hadRaw = Object.getOwnPropertyDescriptor(stdin, 'setRawMode')
		Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true })
		Object.defineProperty(stdin, 'setRawMode', {
			value: (mode: boolean) => {
				calls.push(`raw:${mode}`)
				return stdin
			},
			configurable: true,
			writable: true,
		})
		render.mockImplementationOnce(() => {
			calls.push('render')
			return { waitUntilExit }
		})
		try {
			await launchTui({ cwd: '/workspace', version: '0.0.0-test' })
		} finally {
			if (had) Object.defineProperty(stdin, 'isTTY', had)
			else Reflect.deleteProperty(stdin, 'isTTY')
			if (hadRaw) Object.defineProperty(stdin, 'setRawMode', hadRaw)
			else Reflect.deleteProperty(stdin, 'setRawMode')
		}
		expect(calls.indexOf('raw:true')).toBeGreaterThanOrEqual(0)
		expect(calls.indexOf('raw:true')).toBeLessThan(calls.indexOf('render'))
		expect(calls.at(-1)).toBe('raw:false')
	})
})
