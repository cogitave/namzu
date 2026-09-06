import { expect, it, vi } from 'vitest'

import { TextPrompt } from '../TextPrompt.js'
import { renderToScreen } from './support/screen.js'

it.each([7, 12, 40])(
	'keeps the cursor in one row at %i columns and submits the original Unicode/control source',
	async (cols) => {
		const original = '👩‍💻界e\u0301\x1b[2Jtail'
		const submit = vi.fn()
		const screen = await renderToScreen(
			<TextPrompt
				title="Name"
				placeholder="Enter a name"
				initialValue={original}
				onSubmit={submit}
				onCancel={() => {}}
			/>,
			{ cols, rows: 12 },
		)
		try {
			screen.press('\x01')
			await screen.waitForRender()
			const frame = screen.viewport()
			expect(frame[0]).toMatch(/^╭/)
			expect(frame[3]).toContain('› ')
			expect(frame[6]).toMatch(/^╰/)
			expect(frame.slice(7).every((row) => row === '')).toBe(true)
			if (cols === 7) expect(frame[3]).toContain('…')
			else expect(frame[3]).toContain('👩‍💻')
			if (cols === 40) expect(frame[3]).toContain('\\u{001b}[2Jtail')
			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledExactlyOnceWith(original)
		} finally {
			await screen.unmount()
		}
	},
)
