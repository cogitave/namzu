/**
 * The small count drawn on the Windows taskbar button, as raw BGRA pixels so no image encoder or
 * file is needed. A red disc with the count in white (1 to 9; more than nine shows a plus). The
 * accessible text travels separately, as the description given to `setOverlayIcon`.
 */
export const OVERLAY_SIZE = 16

// 3 wide by 5 tall, one row per string.
const GLYPHS: Record<string, string[]> = {
	'1': ['.#.', '##.', '.#.', '.#.', '###'],
	'2': ['###', '..#', '###', '#..', '###'],
	'3': ['###', '..#', '###', '..#', '###'],
	'4': ['#.#', '#.#', '###', '..#', '..#'],
	'5': ['###', '#..', '###', '..#', '###'],
	'6': ['###', '#..', '###', '#.#', '###'],
	'7': ['###', '..#', '.#.', '.#.', '.#.'],
	'8': ['###', '#.#', '###', '#.#', '###'],
	'9': ['###', '#.#', '###', '..#', '###'],
	'+': ['...', '.#.', '###', '.#.', '...'],
}

export function overlayBitmap(count: number): { width: number; height: number; data: Buffer } {
	const size = OVERLAY_SIZE
	const data = Buffer.alloc(size * size * 4)
	const centre = (size - 1) / 2
	const set = (x: number, y: number, b: number, g: number, r: number) => {
		const at = (y * size + x) * 4
		data[at] = b
		data[at + 1] = g
		data[at + 2] = r
		data[at + 3] = 255
	}
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			if ((x - centre) ** 2 + (y - centre) ** 2 <= (size / 2) ** 2) set(x, y, 0x2f, 0x2f, 0xd9)
	const glyph = GLYPHS[count >= 1 && count <= 9 ? String(Math.floor(count)) : '+']
	// Scaled by two: 6 by 10 pixels, centred.
	const left = (size - 6) / 2
	const top = (size - 10) / 2
	for (let row = 0; row < 5; row++)
		for (let col = 0; col < 3; col++)
			if (glyph?.[row]?.[col] === '#')
				for (let dy = 0; dy < 2; dy++)
					for (let dx = 0; dx < 2; dx++) set(left + col * 2 + dx, top + row * 2 + dy, 255, 255, 255)
	return { width: size, height: size, data }
}
