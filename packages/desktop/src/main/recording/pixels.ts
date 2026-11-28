import { GRAY_HEIGHT, GRAY_WIDTH } from './assembler.js'

/**
 * Pixel work for a picture, with no Electron in it: the small grayscale the policy compares, the
 * all-black test, and the ring drawn where the pointer was. The bitmaps are BGRA, four bytes a pixel,
 * the way Electron's `toBitmap` hands them over.
 */

/** 64 x 36 brightness by averaging blocks; a source smaller than that is sampled. */
export function grayOf(bgra: Uint8Array, width: number, height: number): Uint8Array {
	const gray = new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT)
	if (width <= 0 || height <= 0 || bgra.length < width * height * 4) return gray
	for (let row = 0; row < GRAY_HEIGHT; row++) {
		const y0 = Math.floor((row * height) / GRAY_HEIGHT)
		const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / GRAY_HEIGHT))
		for (let col = 0; col < GRAY_WIDTH; col++) {
			const x0 = Math.floor((col * width) / GRAY_WIDTH)
			const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / GRAY_WIDTH))
			let sum = 0
			let count = 0
			// A sparse sample of the block is enough for a change test.
			const stepY = Math.max(1, Math.floor((y1 - y0) / 3))
			const stepX = Math.max(1, Math.floor((x1 - x0) / 3))
			for (let y = y0; y < y1; y += stepY)
				for (let x = x0; x < x1; x += stepX) {
					const at = (y * width + x) * 4
					sum +=
						((bgra[at] ?? 0) * 114 + (bgra[at + 1] ?? 0) * 587 + (bgra[at + 2] ?? 0) * 299) / 1000
					count++
				}
			gray[row * GRAY_WIDTH + col] = Math.round(sum / Math.max(1, count))
		}
	}
	return gray
}

/** Every cell of the small picture is nearly black: the secure desktop, protected video, a prompt. */
export function isBlack(gray: Uint8Array): boolean {
	for (const value of gray) if (value > 3) return false
	return gray.length > 0
}

/**
 * A red ring of `radius` and `stroke` pixels centred on (cx, cy), drawn into the bitmap. The point is
 * in the bitmap's own pixels; one off the picture draws nothing.
 */
export function drawRing(
	bgra: Uint8Array,
	width: number,
	height: number,
	cx: number,
	cy: number,
	radius = 14,
	stroke = 3,
): void {
	if (cx < -radius || cy < -radius || cx > width + radius || cy > height + radius) return
	const outer = radius + stroke / 2
	const inner = radius - stroke / 2
	const x0 = Math.max(0, Math.floor(cx - outer))
	const x1 = Math.min(width - 1, Math.ceil(cx + outer))
	const y0 = Math.max(0, Math.floor(cy - outer))
	const y1 = Math.min(height - 1, Math.ceil(cy + outer))
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) {
			const distance = Math.hypot(x - cx, y - cy)
			if (distance < inner || distance > outer) continue
			const at = (y * width + x) * 4
			bgra[at] = 40
			bgra[at + 1] = 40
			bgra[at + 2] = 235
			bgra[at + 3] = 255
		}
}

/** The size a display is captured at: long edge at most `edge`, never enlarged. */
export function shownSize(width: number, height: number, edge: number): { w: number; h: number } {
	const long = Math.max(width, height)
	if (long <= edge) return { w: width, h: height }
	const scale = edge / long
	return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
}

/** A filled red dot on a transparent square, BGRA, for the tray icon while a recording runs. */
export function redDot(size: number): Uint8Array {
	const bgra = new Uint8Array(size * size * 4)
	const c = (size - 1) / 2
	const radius = size * 0.38
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const distance = Math.hypot(x - c, y - c)
			if (distance > radius + 0.5) continue
			const at = (y * size + x) * 4
			const alpha = distance > radius - 0.5 ? Math.round(255 * (radius + 0.5 - distance)) : 255
			bgra[at] = 45
			bgra[at + 1] = 45
			bgra[at + 2] = 225
			bgra[at + 3] = Math.max(0, Math.min(255, alpha))
		}
	return bgra
}
