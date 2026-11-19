/**
 * macOS image paste in the composer: a path into the screenshot preview's folder whose file is
 * already gone reads the clipboard's picture instead of landing as text, and a file copied in
 * Finder (a `files` read) attaches like a dropped one.
 *
 * `process.platform` is faked as `darwin`; nothing here reaches a clipboard. Every wait is on
 * the replaced reader's own completion, never on a clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClipboardRead } from '../../integrations/clipboard/image.js'
import { Composer } from '../Composer.js'
import { renderToScreen } from './support/screen.js'

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(8),
])
const PREVIEW =
	'/var/folders/ab/xyz/T/TemporaryItems/NSIRD_screencaptureui_Q1w2/Screenshot 2026-11-19 at 10.00.00.png'

const state = vi.hoisted(() => ({
	reads: 0,
	next: null as unknown,
	waiters: [] as Array<() => void>,
}))

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
		queueMicrotask(completed)
		return state.next
	},
}))
vi.mock('../../integrations/clipboard/wsl.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/clipboard/wsl.js')>()),
	currentPathEnvironment: () => ({ wsl: false, windows: false, distro: '', mountRoot: '/mnt/' }),
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
				stat: async (path: string) => {
					if (path.includes('screencaptureui') || path.includes('missing'))
						throw new Error('ENOENT')
					return { size: PNG.length, isFile: () => true }
				},
				readFile: async () => PNG,
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

type Screen = Awaited<ReturnType<typeof renderToScreen>>
const frame = (screen: Screen) => screen.viewport().join('\n')

async function open(onNotice = vi.fn()) {
	const screen = await renderToScreen(
		<Composer history={[]} onSubmit={vi.fn()} onNotice={onNotice} />,
		{
			cols: 100,
			rows: 24,
		},
	)
	await screen.waitForRender()
	return { screen, onNotice }
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('image paste on macOS', () => {
	beforeEach(() => {
		Object.defineProperty(process, 'platform', { value: 'darwin' })
		state.reads = 0
		state.next = png
	})
	afterEach(() => {
		if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
	})

	it('reads the clipboard picture when a screenshot-preview path names a file that is gone', async () => {
		const { screen } = await open()
		try {
			const done = nextCompletion()
			screen.press(`\x1b[200~${PREVIEW}\x1b[201~`)
			await done
			// The path read finishes first; the clipboard read follows it.
			while (state.reads === 0) await nextCompletion()
			await screen.waitForRender()
			expect(state.reads).toBe(1)
			expect(frame(screen)).toContain('[Image #1]')
			expect(frame(screen)).not.toContain('screencaptureui')
		} finally {
			await screen.unmount()
		}
	})

	it('attaches a readable image path without reading the clipboard', async () => {
		const { screen } = await open()
		try {
			const done = nextCompletion()
			screen.press('\x1b[200~/Users/a/Pictures/shot.png\x1b[201~')
			await done
			await screen.waitForRender()
			expect(state.reads).toBe(0)
			expect(frame(screen)).toContain('[Image #1]')
		} finally {
			await screen.unmount()
		}
	})

	it('leaves an ordinary missing image path as text, without reading the clipboard', async () => {
		const { screen } = await open()
		try {
			const done = nextCompletion()
			screen.press('\x1b[200~/Users/a/missing.png\x1b[201~')
			await done
			await screen.waitForRender()
			expect(state.reads).toBe(0)
			expect(frame(screen)).toContain('/Users/a/missing.png')
			expect(frame(screen)).not.toContain('[Image #')
		} finally {
			await screen.unmount()
		}
	})

	it('attaches the file a Finder copy left, from the paste key', async () => {
		state.next = { kind: 'files', paths: ['/Users/a/Pictures/shot.png'] } satisfies ClipboardRead
		const { screen } = await open()
		try {
			const done = nextCompletion()
			screen.press('\x16')
			await done
			while (!frame(screen).includes('[Image #1]')) await screen.waitForRender()
			expect(state.reads).toBe(1)
		} finally {
			await screen.unmount()
		}
	})
})
