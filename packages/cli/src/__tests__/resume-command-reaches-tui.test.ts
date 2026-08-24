/** The clean-exit handoff must be an actual interactive CLI address. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))

vi.mock('../tui/index.js', () => ({ launchTui }))

const { runCli } = await import('../cli.js')

describe('namzu resume <conversation-id>', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

	afterEach(() => {
		launchTui.mockClear()
		vi.restoreAllMocks()
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
	})

	it('launches the TUI with the exact durable id', async () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: true,
		})

		await expect(
			runCli({ argv: ['node', 'namzu', 'resume', 'ses_copy_paste_target'] }),
		).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		expect(launchTui).toHaveBeenCalledWith(
			expect.objectContaining({
				initialConversationId: 'ses_copy_paste_target',
			}),
		)
	})
})
