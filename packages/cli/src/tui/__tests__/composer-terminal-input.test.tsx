/** Production-renderer observers for terminal composer keys and geometry. */

import type { MessageAttachment } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { ComposerSubmitMode } from '../Composer.js'
import { Composer } from '../Composer.js'
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
})
