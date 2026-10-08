// Generate the Namzu app icon from the pixel "N" of the wordmark (src/renderer/wordmark.tsx).
//
//   node scripts/generate-icon.mjs [--out <dir>] [--sheet <file.png>]
//
// Writes build/icon.png (1024) and build/icon.ico (16, 20, 24, 32, 40, 48, 64, 128, 256 px). Every
// size is drawn on its own pixel grid, never scaled from another: the N is four cells wide and four
// tall (the two rows of half blocks of the lettering), each cell a whole number of pixels, centred
// on a whole-pixel offset. Only the tile's rounded corners are antialiased. Node only: PNG is
// written with zlib and the ICO container by hand (PNG-compressed entries, valid since Vista).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// "█▄ █" over "█ ▀█" read as four half-block rows: the initial of the lettering.
export const GLYPH = ['X..X', 'XX.X', 'X.XX', 'X..X']
// --primary of the dark theme (theme.css) on a near-black tile with a trace of green.
export const GREEN = [0x5f, 0xff, 0x5f]
export const TILE = [0x10, 0x15, 0x10]
export const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

/** Pixel geometry of one size: cell edge, glyph offset and corner radius, all in whole pixels. */
export function layout(size) {
	const cell = Math.max(2, Math.round(size * 0.15))
	return { cell, offset: (size - cell * 4) / 2, radius: Math.round(size * 0.22) }
}

/** RGBA pixels of the icon at `size`. */
export function render(size) {
	const { cell, offset, radius } = layout(size)
	const px = Buffer.alloc(size * size * 4)
	const SS = 4
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			// Tile coverage: exact except in the four corner squares, supersampled there.
			let hit = 0
			for (let sy = 0; sy < SS; sy++)
				for (let sx = 0; sx < SS; sx++) {
					const fx = x + (sx + 0.5) / SS
					const fy = y + (sy + 0.5) / SS
					const cx = fx < radius ? radius : fx > size - radius ? size - radius : fx
					const cy = fy < radius ? radius : fy > size - radius ? size - radius : fy
					if ((fx - cx) ** 2 + (fy - cy) ** 2 <= radius * radius) hit++
				}
			const alpha = hit / (SS * SS)
			const gx = Math.floor((x - offset) / cell)
			const gy = Math.floor((y - offset) / cell)
			const on = gx >= 0 && gx < 4 && gy >= 0 && gy < 4 && GLYPH[gy][gx] === 'X'
			const [r, g, b] = on ? GREEN : TILE
			const i = (y * size + x) * 4
			px[i] = r
			px[i + 1] = g
			px[i + 2] = b
			px[i + 3] = Math.round(alpha * 255)
		}
	}
	return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c >>> 0
})
const crc32 = (buf) => {
	let c = 0xffffffff
	for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

export function png(width, height, rgba) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8)
		head.writeUInt32BE(data.length, 0)
		head.write(type, 4, 'ascii')
		const tail = Buffer.alloc(4)
		tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
		return Buffer.concat([head, data, tail])
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	const stride = width * 4
	const raw = Buffer.alloc((stride + 1) * height)
	for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

export function ico(images) {
	const head = Buffer.alloc(6 + images.length * 16)
	head.writeUInt16LE(1, 2) // type: icon
	head.writeUInt16LE(images.length, 4)
	let offset = head.length
	images.forEach(({ size, data }, i) => {
		const e = 6 + i * 16
		head[e] = size === 256 ? 0 : size
		head[e + 1] = size === 256 ? 0 : size
		head.writeUInt16LE(1, e + 4) // planes
		head.writeUInt16LE(32, e + 6) // bits per pixel
		head.writeUInt32LE(data.length, e + 8)
		head.writeUInt32LE(offset, e + 12)
		offset += data.length
	})
	return Buffer.concat([head, ...images.map((i) => i.data)])
}

/** Contact sheet: every size at 1x and 4x (nearest) on dark, light and a taskbar strip. */
export function sheet() {
	const W = 1120
	const H = 640
	const px = Buffer.alloc(W * H * 4)
	const fill = (x0, y0, w, h, [r, g, b]) => {
		for (let y = y0; y < y0 + h; y++)
			for (let x = x0; x < x0 + w; x++) {
				const i = (y * W + x) * 4
				px[i] = r
				px[i + 1] = g
				px[i + 2] = b
				px[i + 3] = 255
			}
	}
	const blit = (src, size, x0, y0, scale) => {
		for (let y = 0; y < size * scale; y++)
			for (let x = 0; x < size * scale; x++) {
				const s = ((Math.floor(y / scale)) * size + Math.floor(x / scale)) * 4
				const a = src[s + 3] / 255
				const i = ((y0 + y) * W + x0 + x) * 4
				for (let c = 0; c < 3; c++) px[i + c] = Math.round(src[s + c] * a + px[i + c] * (1 - a))
			}
	}
	const rows = [
		{ y: 0, h: 290, bg: [0x18, 0x18, 0x18], scale: 1 },
		{ y: 290, h: 290, bg: [0xf2, 0xf2, 0xf2], scale: 1 },
			]
	for (const row of rows) fill(0, row.y, W, row.h, row.bg)
	fill(0, 600, W, 40, [0x1c, 0x1c, 0x1c]) // taskbar
	for (const row of [rows[0], rows[1]]) {
		let x = 16
		for (const s of SIZES) {
			const img = render(s)
			// 1x for small sizes, 2x beyond 64 (128 and 256 are shown downsized by 2/4 elsewhere).
			const shown = s <= 64 ? s * 2 : null
			if (shown) {
				blit(img, s, x, row.y + 16, 2)
				x += shown + 14
			}
		}
		// the big ones at 1x
		blit(render(128), 128, x, row.y + 16, 1)
		x += 142
		blit(render(256), 256, x, row.y + 16, 1)
	}
	// taskbar strip: 32, 24 and 16 px at their real size, one with an "active" underline
	let tx = 20
	for (const s of [16, 20, 24, 32, 40, 48]) {
		blit(render(s), s, tx, 600 + Math.floor((40 - s) / 2), 1)
		tx += s + 20
	}
	fill(20, 636, 24, 3, [0x76, 0xb9, 0xed])
	return png(W, H, px)
}

function main() {
	const args = process.argv.slice(2)
	const flag = (name) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : undefined)
	const out = flag('--out') ?? join(pkgRoot, 'build')
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, 'icon.png'), png(1024, 1024, render(1024)))
	writeFileSync(
		join(out, 'icon.ico'),
		ico(SIZES.map((size) => ({ size, data: png(size, size, render(size)) }))),
	)
	const sheetPath = flag('--sheet')
	if (sheetPath) writeFileSync(sheetPath, sheet())
	for (const s of [...SIZES, 1024]) {
		const { cell, offset, radius } = layout(s)
		console.log(`${s}px: cell ${cell}, glyph ${cell * 4}x${cell * 4} at ${offset},${offset}, radius ${radius}`)
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
