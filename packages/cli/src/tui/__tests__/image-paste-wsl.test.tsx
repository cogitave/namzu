/**
 * The composer's image paste on WSL and for dropped files: an empty bracketed
 * paste reads the clipboard, a paste of image paths attaches the files, Enter
 * waits for a read in flight, and each outcome says something plain.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ClipboardRead } from '../../integrations/clipboard/image.js'
import { Composer } from '../Composer.js'
import { renderToScreen } from './support/screen.js'

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(8),
])
const state = vi.hoisted(() => ({
	wsl: true,
	reads: 0,
	next: null as unknown,
	gate: null as null | Promise<void>,
}))

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: async () => {
		state.reads += 1
		if (state.gate) await state.gate
		return state.next
	},
}))
vi.mock('../../integrations/clipboard/wsl.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/clipboard/wsl.js')>()),
	currentPathEnvironment: () => ({ wsl: state.wsl, distro: 'Ubuntu', mountRoot: '/mnt/' }),
}))
vi.mock('../../integrations/clipboard/image-paths.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../integrations/clipboard/image-paths.js')>()
	return {
		...real,
		loadImageFiles: (paths: readonly string[]) =>
			real.loadImageFiles(paths, {
				stat: async () => ({ size: PNG.length, isFile: () => true }),
				readFile: async (path: string) =>
					path.endsWith('bad.png') ? Buffer.from('nope nope nope') : PNG,
			}),
	}
})

const png: ClipboardRead = {
	kind: 'image',
	image: { data: PNG.toString('base64'), mediaType: 'image/png', filename: 'Pasted image' },
}

async function open(onSubmit = vi.fn(), onNotice = vi.fn()) {
	const screen = await renderToScreen(
		<Composer history={[]} onSubmit={onSubmit} onNotice={onNotice} />,
		{
			cols: 100,
			rows: 24,
		},
	)
	await screen.waitForRender()
	return { screen, onSubmit, onNotice }
}

const frame = (screen: Awaited<ReturnType<typeof renderToScreen>>) => screen.viewport().join('\n')

describe('image paste on WSL', () => {
	it('reads the clipboard on an empty bracketed paste and shows the placeholder', async () => {
		state.wsl = true
		state.reads = 0
		state.gate = null
		state.next = png
		const { screen } = await open()
		try {
			screen.press('\x1b[200~\x1b[201~')
			await vi.waitFor(async () => {
				await screen.waitForRender()
				expect(frame(screen)).toContain('[Image #1]')
			})
			expect(state.reads).toBe(1)
		} finally {
			await screen.unmount()
		}
	})

	it('does nothing for an empty paste on a platform that does not send one for images', async () => {
		state.wsl = false
		state.reads = 0
		state.gate = null
		const { screen } = await open()
		try {
			screen.press('\x1b[200~\x1b[201~')
			await screen.waitForRender()
			expect(state.reads).toBe(0)
		} finally {
			await screen.unmount()
			state.wsl = true
		}
	})

	it('names Alt+V when nothing is on the clipboard', async () => {
		state.wsl = true
		state.gate = null
		state.next = { kind: 'empty' }
		const { screen, onNotice } = await open()
		try {
			screen.press('\x1bv')
			await vi.waitFor(() =>
				expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('press Alt+V')),
			)
		} finally {
			await screen.unmount()
		}
	})

	it('explains an unreachable Windows clipboard and a slow one in plain words', async () => {
		state.wsl = true
		state.gate = null
		const { screen, onNotice } = await open()
		try {
			state.next = { kind: 'unavailable', detail: 'x', wsl: true }
			screen.press('\x16')
			await vi.waitFor(() =>
				expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Windows interop')),
			)
			state.next = { kind: 'failed', detail: 'timed out' }
			screen.press('\x16')
			await vi.waitFor(() =>
				expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('took too long')),
			)
		} finally {
			await screen.unmount()
		}
	})

	it('holds Enter while a read is in flight, then sends with the image', async () => {
		state.wsl = true
		state.reads = 0
		let release: () => void = () => {}
		state.gate = new Promise<void>((resolve) => {
			release = resolve
		})
		state.next = png
		const { screen, onSubmit } = await open()
		try {
			screen.press('hi ')
			await screen.waitForRender()
			screen.press('\x16')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()
			expect(onSubmit).not.toHaveBeenCalled()
			screen.press('\x16')
			await screen.waitForRender()
			expect(state.reads).toBe(1)
			release()
			await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
			const attachments = onSubmit.mock.calls[0]?.[1] as
				| ReadonlyArray<{ mediaType: string }>
				| undefined
			expect(attachments).toHaveLength(1)
			expect(attachments?.[0]?.mediaType).toBe('image/png')
		} finally {
			state.gate = null
			await screen.unmount()
		}
	})
})

describe('pasting image paths', () => {
	it('attaches a dropped Windows path as a chip instead of text', async () => {
		state.wsl = true
		state.gate = null
		const { screen } = await open()
		try {
			screen.press('\x1b[200~"C:\\Users\\a\\shot one.png"\x1b[201~')
			await vi.waitFor(async () => {
				await screen.waitForRender()
				expect(frame(screen)).toContain('[Image #1]')
			})
			expect(frame(screen)).not.toContain('shot one')
		} finally {
			await screen.unmount()
		}
	})

	it('makes one chip per path', async () => {
		state.wsl = true
		const { screen } = await open()
		try {
			screen.press('\x1b[200~/a/1.png\n/a/2.jpg\x1b[201~')
			await vi.waitFor(async () => {
				await screen.waitForRender()
				expect(frame(screen)).toContain('[Image #2]')
			})
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the whole paste as text when a file is not an image', async () => {
		state.wsl = true
		const { screen } = await open()
		try {
			screen.press('\x1b[200~/a/bad.png\x1b[201~')
			await vi.waitFor(async () => {
				await screen.waitForRender()
				expect(frame(screen)).toContain('/a/bad.png')
			})
			expect(frame(screen)).not.toContain('[Image #1]')
		} finally {
			await screen.unmount()
		}
	})
})
