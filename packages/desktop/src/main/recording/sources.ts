import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { NativeWatch } from '@namzu/computer-use'
import { type Display, type NativeImage, desktopCapturer, nativeImage, screen } from 'electron'
import { RECORDING_LIMITS } from '../../shared/recording-protocol.js'
import type { CapturedFrame, FrameSource, WatchedEvent } from './assembler.js'
import type { DisplaySource } from './controller.js'
import { drawRing, grayOf, isBlack, shownSize } from './pixels.js'
import type { Scheduler, WatchSource } from './session.js'

/**
 * The Electron and native pieces a recording stands on: pictures of one display from the screen
 * capturer, the pointer's place, the native helper's read-only control events, and the real timers.
 * Each is a small object behind an interface the session knows, so the recording logic is tested
 * without any of them.
 */

export function isWsl(platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'linux' && /microsoft|wsl/i.test(release())
}

/**
 * The native helper: `NAMZU_NATIVE_HELPER`, else the deprecated `NAMZU_WIN_HELPER` (read until the
 * next major of `@namzu/computer-use`), else `namzu-native.exe` beside the app's resources; undefined
 * when none exists.
 */
export function helperPath(
	env: Readonly<Record<string, string | undefined>> = process.env,
	resources: string | undefined = process.resourcesPath,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	for (const name of ['NAMZU_NATIVE_HELPER', 'NAMZU_WIN_HELPER']) {
		const named = env[name]?.trim()
		if (named && exists(named)) return named
	}
	if (resources) {
		const beside = join(resources, 'namzu-native.exe')
		if (exists(beside)) return beside
	}
	return undefined
}

export const realScheduler: Scheduler = {
	every(ms, fn) {
		const timer = setInterval(fn, ms)
		return () => clearInterval(timer)
	},
	after(ms, fn) {
		const timer = setTimeout(fn, ms)
		return () => clearTimeout(timer)
	},
}

/** The native helper's UI Automation subscriptions as a watch source. Read only; never a key. */
export function nativeWatchSource(executable: string, cliVersion?: string): WatchSource {
	const watch = new NativeWatch({ executable, ...(cliVersion ? { cliVersion } : {}) })
	return {
		async start() {
			const started = await watch.start()
			return { controls: started.controls }
		},
		async poll() {
			const polled = await watch.poll()
			return { events: polled.events as readonly WatchedEvent[], dropped: polled.dropped }
		},
		async stop() {
			await watch.dispose()
		},
	}
}

function thumbnailOf(sources: Electron.DesktopCapturerSource[], display: Display, index: number) {
	return (
		sources.find((source) => source.display_id === String(display.id)) ??
		// Some systems leave the id empty; the order is the display order.
		sources[index]
	)
}

/** Pictures of one display, scaled to the long edge, JPEG, with a ring where the pointer is. */
export class ElectronFrames implements FrameSource {
	constructor(
		private readonly display: Display,
		private readonly index: number,
	) {}

	async capture(cursor?: { x: number; y: number }): Promise<CapturedFrame> {
		const pixelsW = Math.round(this.display.size.width * this.display.scaleFactor)
		const pixelsH = Math.round(this.display.size.height * this.display.scaleFactor)
		const shown = shownSize(pixelsW, pixelsH, RECORDING_LIMITS.frameLongEdge)
		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: { width: shown.w, height: shown.h },
		})
		const source = thumbnailOf(sources, this.display, this.index)
		if (!source || source.thumbnail.isEmpty()) throw new Error('The screen could not be captured.')
		const image = source.thumbnail
		const size = image.getSize()
		const bitmap = new Uint8Array(image.toBitmap())
		const gray = grayOf(bitmap, size.width, size.height)
		const black = isBlack(gray)
		if (cursor) {
			const ratio = size.width / pixelsW
			drawRing(bitmap, size.width, size.height, cursor.x * ratio, cursor.y * ratio)
		}
		const jpeg = nativeImage
			.createFromBitmap(Buffer.from(bitmap), { width: size.width, height: size.height })
			.toJPEG(RECORDING_LIMITS.frameQuality)
		return { jpeg: new Uint8Array(jpeg), gray, black }
	}
}

/** A small data URL for the review sheet; the full picture never leaves main. */
export function thumbnailUrl(jpeg: Uint8Array): string {
	const image = nativeImage.createFromBuffer(Buffer.from(jpeg))
	if (image.isEmpty()) return ''
	const { width } = image.getSize()
	const resized: NativeImage =
		width > RECORDING_LIMITS.thumbEdge
			? image.resize({ width: RECORDING_LIMITS.thumbEdge, quality: 'good' })
			: image
	return `data:image/jpeg;base64,${resized.toJPEG(60).toString('base64')}`
}

/** The pointer in a display's own pixels, or undefined when it is on another display. */
export function cursorIn(display: Display): { x: number; y: number } | undefined {
	const point = screen.getCursorScreenPoint()
	const { x, y, width, height } = display.bounds
	if (point.x < x || point.y < y || point.x >= x + width || point.y >= y + height) return undefined
	return {
		x: Math.round((point.x - x) * display.scaleFactor),
		y: Math.round((point.y - y) * display.scaleFactor),
	}
}

/** Every display, as the chooser lists it and as a recording can use it. */
export async function electronDisplays(
	onPlace: (display: Display) => void,
): Promise<DisplaySource[]> {
	const displays = screen.getAllDisplays()
	const primary = screen.getPrimaryDisplay().id
	const near = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
	const thumbs = await desktopCapturer
		.getSources({ types: ['screen'], thumbnailSize: { width: 256, height: 144 } })
		.catch(() => [] as Electron.DesktopCapturerSource[])
	return displays.map((display, index) => {
		const width = Math.round(display.size.width * display.scaleFactor)
		const height = Math.round(display.size.height * display.scaleFactor)
		const shown = shownSize(width, height, RECORDING_LIMITS.frameLongEdge)
		const thumb = thumbnailOf(thumbs, display, index)?.thumbnail
		return {
			info: {
				id: String(display.id),
				label: display.label?.trim() || `Display ${index + 1}`,
				width,
				height,
				thumb: thumb && !thumb.isEmpty() ? thumb.toDataURL() : '',
				primary: display.id === primary,
				underCursor: display.id === near,
			},
			width,
			height,
			shownWidth: shown.w,
			shownHeight: shown.h,
			frames: () => new ElectronFrames(display, index),
			cursor: () => cursorIn(display),
			place: () => onPlace(display),
		}
	})
}
