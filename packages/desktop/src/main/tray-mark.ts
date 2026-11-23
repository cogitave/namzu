/**
 * Paints a small orange dot with a dark rim in the lower-right corner of a tray picture, so a test
 * profile's icon cannot be taken for the person's own. `bitmap` is BGRA, as Electron's
 * `NativeImage.toBitmap` returns it, `size` pixels on each side; a new buffer is returned.
 */
export function paintTestMark(bitmap: Buffer, size: number): Buffer {
	const out = Buffer.from(bitmap)
	const radius = Math.max(3, Math.round(size * 0.28))
	const cx = size - radius - 1
	const cy = size - radius - 1
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
			if (distance > radius) continue
			const at = (y * size + x) * 4
			const rim = distance > radius - Math.max(1, size / 16)
			// BGRA
			out[at] = rim ? 20 : 0
			out[at + 1] = rim ? 20 : 140
			out[at + 2] = rim ? 20 : 255
			out[at + 3] = 255
		}
	}
	return out
}
