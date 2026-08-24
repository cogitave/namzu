/** Production-renderer observers for terminal composer keys and geometry. */

import type { MessageAttachment } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { ComposerSubmitMode } from '../Composer.js'
import { Composer } from '../Composer.js'
import { matchSlashCommands } from '../slashCommands.js'
import { renderToScreen } from './support/screen.js'

const clipboardImage = {
	data: 'iVBORw0KGgo=',
	mediaType: 'image/png' as const,
}

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => ({ kind: 'image' as const, image: clipboardImage }),
}))

function composer(
	onSubmit: (
		value: string,
		attachments?: readonly MessageAttachment[],
		mode?: ComposerSubmitMode,
	) => void,
) {
	return <Composer history={[]} onSubmit={onSubmit} />
}

describe('the composer on a production-shaped terminal', () => {
	it('accepts the Alt+V byte sequence as the same image action as Ctrl+V', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('\x1bv')
			await screen.waitForRender()

			expect(screen.scrollback()).toContainEqual(expect.stringContaining('Image #1'))

			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith('', [clipboardImage])
		} finally {
			await screen.unmount()
		}
	})

	it('uses whitespace-delimited Ctrl+W word rubout', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('keep hello-world   ')
			await screen.waitForRender()
			screen.press('\x17')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('keep', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('inserts at the visible left/right cursor instead of appending at the end', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('helo')
			await screen.waitForRender()
			screen.press('\x1b[D')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('hel▏o')

			screen.press('l')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith('hello', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('moves across and deletes a complete grapheme instead of splitting its bytes', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('a👨‍👩‍👧‍👦b')
			await screen.waitForRender()
			screen.press('\x1b[D')
			await screen.waitForRender()
			screen.press('\x7f')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('ab', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('supports Home/End and their Ctrl+A/Ctrl+E terminal bindings', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('tail')
			await screen.waitForRender()
			screen.press('\x01')
			await screen.waitForRender()
			screen.press('head ')
			await screen.waitForRender()
			screen.press('\x05')
			await screen.waitForRender()
			screen.press('!')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('head tail!', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('applies Ctrl+W at the cursor while preserving the suffix', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('alpha beta gamma')
			await screen.waitForRender()
			screen.press('\x01')
			await screen.waitForRender()
			for (let index = 0; index < 11; index += 1) screen.press('\x1b[C')
			await screen.waitForRender()
			screen.press('\x17')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('alpha gamma', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('deletes forward at Delete and kills toward either line boundary', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('a👍🏽bc')
			await screen.waitForRender()
			screen.press('\x01')
			screen.press('\x1b[C')
			await screen.waitForRender()
			screen.press('\x1b[3~')
			await screen.waitForRender()
			screen.press('\x05')
			screen.press('\x15')
			await screen.waitForRender()
			screen.press('kept')
			screen.press('\x01')
			screen.press('\x1b[C')
			screen.press('\x0b')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('k', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('uses Tab as a queue submission when no completion menu owns it', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('follow up')
			await screen.waitForRender()
			screen.press('\t')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('follow up', undefined, 'queue')
		} finally {
			await screen.unmount()
		}
	})

	it('gives a slash description the remaining terminal width', async () => {
		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('/per')
			await screen.waitForRender()

			const row = screen.viewport().find((line) => line.includes('/permissions'))
			expect(row).toContain('Choose how undecided tool calls are handled: /permissions [mode].')
		} finally {
			await screen.unmount()
		}
	})

	it('scrolls the slash window so commands after the first six stay reachable', async () => {
		const matches = matchSlashCommands('/', [])
		expect(matches.length).toBeGreaterThan(6)
		const seventh = matches[6]
		if (!seventh) throw new Error('slash registry unexpectedly has fewer than seven commands')

		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 120,
			rows: 24,
		})
		try {
			screen.press('/')
			await screen.waitForRender()
			for (let index = 0; index < 6; index += 1) {
				screen.press('\x1b[B')
				await screen.waitForRender()
			}

			const viewport = screen.viewport().join('\n')
			expect(viewport).toContain(`› /${seventh.name}`)
			expect(viewport).not.toContain(`› /${matches[0]?.name}`)
		} finally {
			await screen.unmount()
		}
	})
})
