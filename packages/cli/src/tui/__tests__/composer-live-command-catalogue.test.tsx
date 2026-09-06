import { expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'
import type { SlashCommand } from '../slashCommands.js'
import { renderToScreen } from './support/screen.js'

it('renders and submits the live command catalogue after the session registry changes', async () => {
	const command = (name: string): SlashCommand => ({
		name,
		description: 'Available from this session',
		action: () => ({ kind: 'none' }),
	})
	const onSubmit = vi.fn()
	const screen = await renderToScreen(
		<Composer history={[]} onSubmit={onSubmit} builtins={[command('runtime-before')]} />,
		{ cols: 100, rows: 24 },
	)
	try {
		screen.press('/runtime')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('/runtime-before')

		screen.rerender(
			<Composer history={[]} onSubmit={onSubmit} builtins={[command('runtime-after')]} />,
		)
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('/runtime-after')
		expect(screen.viewport().join('\n')).not.toContain('/runtime-before')
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(onSubmit.mock.calls[0]?.[0]).toBe('/runtime-after')
	} finally {
		await screen.unmount()
	}
})
