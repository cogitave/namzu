import { nativeImage } from 'electron'
import { GRAY_HEIGHT, GRAY_WIDTH } from './assembler.js'
import type { CapturedFrame, FrameSource, WatchedEvent } from './assembler.js'
import type { DisplaySource } from './controller.js'
import type { WatchSource } from './session.js'

/**
 * The stand-ins an end-to-end test records with: a painted screen instead of the real one and a
 * scripted list of control events instead of the native helper. They are built only on a test
 * profile with `NAMZU_RECORDING_FAKE=1`, and nothing here reads the computer's screen or input.
 */

const WIDTH = 640
const HEIGHT = 360

/** A screen that changes on every picture, so the frame policy keeps what it is asked to keep. */
export class PaintedScreen implements FrameSource {
	private taken = 0
	async capture(cursor?: { x: number; y: number }): Promise<CapturedFrame> {
		this.taken++
		const bitmap = Buffer.alloc(WIDTH * HEIGHT * 4)
		const hue = (this.taken * 37) % 360
		for (let y = 0; y < HEIGHT; y++)
			for (let x = 0; x < WIDTH; x++) {
				const at = (y * WIDTH + x) * 4
				const band = Math.floor((y / HEIGHT) * 6)
				const bright = 70 + band * 20 + ((x + this.taken * 40) % 160) / 4
				bitmap[at] = (bright + hue / 3) % 255
				bitmap[at + 1] = (bright * 0.8 + hue / 5) % 255
				bitmap[at + 2] = (bright * 0.6 + hue / 2) % 255
				bitmap[at + 3] = 255
			}
		if (cursor) {
			// A plain square marks the pointer in the painted picture.
			for (let y = Math.max(0, cursor.y - 6); y < Math.min(HEIGHT, cursor.y + 6); y++)
				for (let x = Math.max(0, cursor.x - 6); x < Math.min(WIDTH, cursor.x + 6); x++) {
					const at = (y * WIDTH + x) * 4
					bitmap[at] = 30
					bitmap[at + 1] = 30
					bitmap[at + 2] = 240
				}
		}
		const gray = new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT)
		for (let index = 0; index < gray.length; index++)
			gray[index] = 40 + ((index * 7 + this.taken * 53) % 180)
		const jpeg = nativeImage.createFromBitmap(bitmap, { width: WIDTH, height: HEIGHT }).toJPEG(70)
		return { jpeg: new Uint8Array(jpeg), gray, black: false }
	}
}

/** Control events handed out one batch per poll, in the order a person would produce them. */
export class ScriptedWatch implements WatchSource {
	private step = 0
	private readonly script: WatchedEvent[][] = [
		[{ kind: 'app', tMs: 0, process: 'sheet.exe', window: 'q3-report.xlsx' }],
		[{ kind: 'focus', tMs: 0, role: 'Edit', name: 'Search' }],
		[{ kind: 'value', tMs: 0, role: 'Edit', name: 'Search', value: 'overdue invoices' }],
		[{ kind: 'invoke', tMs: 0, role: 'Button', name: 'Filter' }],
		[{ kind: 'menu', tMs: 0, phase: 'open', name: 'File' }],
		[{ kind: 'invoke', tMs: 0, role: 'MenuItem', name: 'Export' }],
	]
	async start() {
		return { controls: true }
	}
	async poll() {
		// One batch every ten polls, so steps are spread over the recording.
		this.step++
		const batch = this.step % 10 === 0 ? this.script[this.step / 10 - 1] : undefined
		return { events: batch ?? [], dropped: 0 }
	}
	async stop() {}
}

export function paintedDisplay(onPlace: () => void): DisplaySource {
	const frames = new PaintedScreen()
	const swatch = Buffer.alloc(128 * 72 * 4)
	for (let at = 0; at < swatch.length; at += 4) {
		swatch[at] = 150
		swatch[at + 1] = 110
		swatch[at + 2] = 80
		swatch[at + 3] = 255
	}
	const thumb = nativeImage.createFromBitmap(swatch, { width: 128, height: 72 }).toDataURL()
	return {
		info: {
			id: 'test-display',
			label: 'Display 1',
			width: WIDTH,
			height: HEIGHT,
			thumb,
			primary: true,
			underCursor: true,
		},
		width: WIDTH,
		height: HEIGHT,
		shownWidth: WIDTH,
		shownHeight: HEIGHT,
		frames: () => frames,
		cursor: () => ({ x: 200, y: 150 }),
		place: onPlace,
	}
}
