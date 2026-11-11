/**
 * The composer's image paste on WSL and for dropped files: an empty bracketed
 * paste reads the clipboard, a paste of image paths attaches the files, Enter
 * waits for a read in flight, and each outcome says something plain.
 *
 * Nothing here reaches a clipboard: the readers are replaced, and every wait
 * is on the replaced reader's own completion, never on a clock.
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
	textReads: 0,
	next: null as unknown,
	text: null as string | null,
	gate: null as null | Promise<void>,
	waiters: [] as Array<() => void>,
}))

/** Resolves when the next replaced reader has returned its answer. */
function nextCompletion(): Promise<void> {
	return new Promise<void>((resolve) => {
		state.waiters.push(resolve)
	})
}
function completed(): void {
	for (const waiter of state.waiters.splice(0)) waiter()
}

vi.mock('../../integrations/clipboard/image.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/clipboard/image.js')>()),
	readClipboardImage: async () => {
		state.reads += 1
		if (state.gate) await state.gate
		queueMicrotask(completed)
		return state.next
	},
}))
vi.mock('../../integrations/clipboard/text-read.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/clipboard/text-read.js')>()),
	readClipboardText: async () => {
		state.textReads += 1
		queueMicrotask(completed)
		return state.text
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
		loadImageFiles: async (
			paths: readonly string[],
			deps: Parameters<typeof real.loadImageFiles>[1],
		) => {
			const result = await real.loadImageFiles(paths, {
				...deps,
				stat: async () => ({ size: PNG.length, isFile: () => true }),
				readFile: async (path: string) =>
					path.endsWith('bad.png') ? Buffer.from('nope nope nope') : PNG,
				fit: async (bytes: Buffer) => ({ ok: true, data: bytes, mediaType: 'image/png' }),
			})
			queueMicrotask(completed)
			return result
		},
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

type Screen = Awaited<ReturnType<typeof renderToScreen>>

/** Press, then wait for the replaced reader to answer and for the composer to draw it. */
async function pressAndSettle(screen: Screen, input: string): Promise<void> {
	const done = nextCompletion()
	screen.press(input)
	await done
	await screen.waitForRender()
}

function reset(): void {
	state.wsl = true
	state.reads = 0
	state.textReads = 0
	state.gate = null
	state.text = null
	state.next = { kind: 'empty' }
}

describe('image paste on WSL', () => {
	it('reads the clipboard on an empty bracketed paste and shows the placeholder', async () => {
		reset()
		state.next = png
		const { screen } = await open()
		try {
			await pressAndSettle(screen, '\x1b[200~\x1b[201~')
			expect(frame(screen)).toContain('[Image #1]')
			expect(state.reads).toBe(1)
		} finally {
			await screen.unmount()
		}
	})

	it('does nothing for an empty paste on a platform that does not send one for images', async () => {
		reset()
		state.wsl = false
		const { screen } = await open()
		try {
			screen.press('\x1b[200~\x1b[201~')
			await screen.waitForRender()
			expect(state.reads).toBe(0)
		} finally {
			await screen.unmount()
		}
	})

	it('refuses an image the reader could not bring inside the limits, with its reason', async () => {
		reset()
		state.next = { kind: 'refused', message: 'This image is too large to attach.' }
		const { screen, onNotice } = await open()
		try {
			await pressAndSettle(screen, '\x1bv')
			expect(onNotice).toHaveBeenCalledWith('This image is too large to attach.')
			expect(frame(screen)).not.toContain('[Image #')
			expect(state.textReads).toBe(0)
		} finally {
			await screen.unmount()
		}
	})

	it('names Alt+V when nothing is on the clipboard', async () => {
		reset()
		const { screen, onNotice } = await open()
		try {
			await pressAndSettle(screen, '\x1bv')
			expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('press Alt+V'))
		} finally {
			await screen.unmount()
		}
	})

	it('explains an unreachable Windows clipboard and a slow one in plain words', async () => {
		reset()
		const { screen, onNotice } = await open()
		try {
			state.next = { kind: 'unavailable', detail: 'x', wsl: true }
			await pressAndSettle(screen, '\x16')
			expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Windows interop'))
			state.next = { kind: 'failed', detail: 'timed out' }
			await pressAndSettle(screen, '\x16')
			expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('took too long'))
		} finally {
			await screen.unmount()
		}
	})

	it('holds Enter while a read is in flight, then sends with the image', async () => {
		reset()
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
			const done = nextCompletion()
			release()
			await done
			await screen.waitForRender()
			expect(onSubmit).toHaveBeenCalledTimes(1)
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

describe('when the key finds no image', () => {
	it('pastes the clipboard text instead', async () => {
		reset()
		state.text = 'from the clipboard'
		const { screen, onNotice } = await open()
		try {
			await pressAndSettle(screen, '\x16')
			expect(state.textReads).toBe(1)
			expect(frame(screen)).toContain('from the clipboard')
			expect(onNotice).not.toHaveBeenCalled()
		} finally {
			await screen.unmount()
		}
	})

	it('says nothing was found when the text is absent or binary too', async () => {
		reset()
		const { screen, onNotice } = await open()
		try {
			await pressAndSettle(screen, '\x16')
			expect(state.textReads).toBe(1)
			expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('No image found'))
		} finally {
			await screen.unmount()
		}
	})

	it('does not read the text for an empty bracketed paste, which already carried none', async () => {
		reset()
		const { screen, onNotice } = await open()
		try {
			await pressAndSettle(screen, '\x1b[200~\x1b[201~')
			expect(state.textReads).toBe(0)
			expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('No image found'))
		} finally {
			await screen.unmount()
		}
	})
})

describe('the chip against the text before it', () => {
	it('sets a space between the word before the cursor and the chip', async () => {
		reset()
		state.next = png
		const { screen } = await open()
		try {
			screen.press('look at')
			await screen.waitForRender()
			await pressAndSettle(screen, '\x16')
			expect(frame(screen)).toContain('look at [Image #1]')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps one space when the draft already ends in one', async () => {
		reset()
		state.next = png
		const { screen } = await open()
		try {
			screen.press('look at ')
			await screen.waitForRender()
			await pressAndSettle(screen, '\x16')
			expect(frame(screen)).toContain('look at [Image #1]')
			expect(frame(screen)).not.toContain('look at  [Image #1]')
		} finally {
			await screen.unmount()
		}
	})

	it('adds no space at the start of an empty draft', async () => {
		reset()
		state.next = png
		const { screen } = await open()
		try {
			await pressAndSettle(screen, '\x16')
			expect(frame(screen)).toMatch(/[❯>] ?\[Image #1\]/)
		} finally {
			await screen.unmount()
		}
	})
})

describe('pasting image paths', () => {
	it('attaches a dropped Windows path as a chip instead of text', async () => {
		reset()
		const { screen } = await open()
		try {
			await pressAndSettle(screen, '\x1b[200~"C:\\Users\\a\\shot one.png"\x1b[201~')
			expect(frame(screen)).toContain('[Image #1]')
			expect(frame(screen)).not.toContain('shot one')
		} finally {
			await screen.unmount()
		}
	})

	it('makes one chip per path', async () => {
		reset()
		const { screen } = await open()
		try {
			await pressAndSettle(screen, '\x1b[200~/a/1.png\n/a/2.jpg\x1b[201~')
			expect(frame(screen)).toContain('[Image #1] [Image #2]')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the whole paste as text when a file is not an image', async () => {
		reset()
		const { screen } = await open()
		try {
			await pressAndSettle(screen, '\x1b[200~/a/bad.png\x1b[201~')
			expect(frame(screen)).toContain('/a/bad.png')
			expect(frame(screen)).not.toContain('[Image #1]')
		} finally {
			await screen.unmount()
		}
	})

	it('refuses a path the read policy keeps out, says why, and leaves the path as text', async () => {
		reset()
		const refusal = 'That file is outside the folders this session can read.'
		const onNotice = vi.fn()
		const screen = await renderToScreen(
			<Composer
				history={[]}
				onSubmit={vi.fn()}
				onNotice={onNotice}
				mayReadImage={async (path) => (path.startsWith('/outside') ? refusal : null)}
			/>,
			{ cols: 100, rows: 24 },
		)
		try {
			await screen.waitForRender()
			await pressAndSettle(screen, '\x1b[200~/outside/secret.png\x1b[201~')
			expect(onNotice).toHaveBeenCalledWith(refusal)
			expect(frame(screen)).not.toContain('[Image #')
			expect(frame(screen)).toContain('/outside/secret.png')
			await pressAndSettle(screen, '\x1b[200~/inside/ok.png\x1b[201~')
			expect(frame(screen)).toContain('[Image #1]')
		} finally {
			await screen.unmount()
		}
	})
})
