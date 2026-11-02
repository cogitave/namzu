import { describe, expect, it } from 'vitest'
import {
	type FitResult,
	type SharpFactory,
	type SharpPipeline,
	fitImage,
	headerDimensions,
	imageTokenCost,
	sniffImageFormat,
} from './image-fit.js'

function png(width: number, height: number, padTo = 64): Buffer {
	const header = Buffer.alloc(24)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
	header.writeUInt32BE(width, 16)
	header.writeUInt32BE(height, 20)
	return Buffer.concat([header, Buffer.alloc(Math.max(0, padTo - 24), 1)])
}

const MIB = 1024 * 1024
const none = async () => null

/**
 * A scripted stand-in for the image library. Each pipeline records the
 * operations asked of it; `sizeOf` says how many bytes that chain produces.
 */
function fakeSharp(
	meta: { width: number; height: number },
	sizeOf: (ops: string[]) => number,
): { sharp: SharpFactory; chains: string[][] } {
	const chains: string[][] = []
	const pipeline = (ops: string[]): SharpPipeline => {
		const next = (op: string) => pipeline([...ops, op])
		return {
			metadata: async () => meta,
			resize: (w, h, o) =>
				next(`resize:${String(w)}x${String(h)}:${o?.fit}:${o?.withoutEnlargement}`),
			flatten: () => next('flatten'),
			png: (o) => next(`png${o?.palette ? ':palette' : ''}`),
			jpeg: (o) => next(`jpeg:${String(o?.quality)}`),
			webp: () => next('webp'),
			gif: () => next('gif'),
			toBuffer: async () => {
				chains.push(ops)
				return Buffer.alloc(sizeOf(ops), 2)
			},
		}
	}
	return { sharp: () => pipeline([]), chains }
}

const pass = async (deps: Parameters<typeof fitImage>[1], bytes: Buffer): Promise<FitResult> =>
	fitImage(bytes, deps)

describe('reading an image from its own bytes', () => {
	it('names the format and the size from the header', () => {
		const bytes = png(640, 480)
		expect(sniffImageFormat(bytes)).toBe('image/png')
		expect(headerDimensions(bytes, 'image/png')).toEqual({ width: 640, height: 480 })
		expect(sniffImageFormat(Buffer.from('not an image at all'))).toBeNull()
		expect(sniffImageFormat(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)]))).toBe('image/bmp')
	})

	it('reads GIF, JPEG and WebP sizes', () => {
		const gif = Buffer.alloc(16)
		gif.write('GIF89a', 0, 'latin1')
		gif.writeUInt16LE(30, 6)
		gif.writeUInt16LE(20, 8)
		expect(headerDimensions(gif, 'image/gif')).toEqual({ width: 30, height: 20 })
		const jpeg = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64,
			0x00, 0xc8, 0x03,
		])
		expect(headerDimensions(jpeg, 'image/jpeg')).toEqual({ width: 200, height: 100 })
		const webp = Buffer.alloc(30)
		webp.write('RIFF', 0, 'latin1')
		webp.write('WEBPVP8X', 8, 'latin1')
		webp.writeUIntLE(799, 24, 3)
		webp.writeUIntLE(599, 27, 3)
		expect(headerDimensions(webp, 'image/webp')).toEqual({ width: 800, height: 600 })
	})

	it('prices an image in 28 px patches', () => {
		expect(imageTokenCost(28, 28)).toBe(1)
		expect(imageTokenCost(1000, 1000)).toBe(36 * 36)
	})
})

describe('an image inside the limits', () => {
	it('passes through byte for byte, with the library or without it', async () => {
		const bytes = png(1500, 900, 200_000)
		const { sharp, chains } = fakeSharp({ width: 1500, height: 900 }, () => 1)
		const withLib = await pass({ loadSharp: async () => sharp }, bytes)
		expect(withLib).toEqual({ ok: true, data: bytes, mediaType: 'image/png' })
		expect(chains).toEqual([])
		expect(await pass({ loadSharp: none }, bytes)).toEqual({
			ok: true,
			data: bytes,
			mediaType: 'image/png',
		})
	})
})

describe('an image over the limits, with the library', () => {
	it('scales one too wide to fit inside 2000, never enlarging', async () => {
		const bytes = png(4000, 1000, 100)
		const { sharp, chains } = fakeSharp({ width: 4000, height: 1000 }, () => 500_000)
		const result = await pass({ loadSharp: async () => sharp }, bytes)
		expect(result.ok && result.mediaType).toBe('image/png')
		expect(chains[0]).toEqual(['resize:2000x2000:inside:true', 'png'])
	})

	it('walks the ladder: palette PNG, then JPEG 80, 60, 40, 20', async () => {
		const bytes = png(1000, 1000, 100)
		const heavy = 5 * MIB
		const { sharp, chains } = fakeSharp({ width: 1000, height: 1000 }, (ops) => {
			const last = ops.at(-1) ?? ''
			if (last === 'jpeg:40') return 1 * MIB
			return heavy
		})
		// 1000 px but heavy: dimension step is skipped, the ladder starts at the palette.
		const big = png(1000, 1000, 4 * MIB + 10)
		const result = await pass({ loadSharp: async () => sharp }, big)
		expect(result.ok && result.mediaType).toBe('image/jpeg')
		expect(chains.map((chain) => chain.join('>'))).toEqual([
			'png:palette',
			'flatten>jpeg:80',
			'flatten>jpeg:60',
			'flatten>jpeg:40',
		])
		void bytes
	})

	it('falls back to a 1000 px wide JPEG at quality 20 as the last resort', async () => {
		const big = png(1800, 1800, 4 * MIB + 10)
		const { sharp, chains } = fakeSharp({ width: 1800, height: 1800 }, (ops) =>
			ops.some((op) => op.startsWith('resize:1000')) ? 800_000 : 6 * MIB,
		)
		const result = await pass({ loadSharp: async () => sharp }, big)
		expect(result.ok && result.mediaType).toBe('image/jpeg')
		expect(chains.at(-1)).toEqual(['resize:1000xundefined:inside:true', 'flatten', 'jpeg:20'])
	})

	it('refuses an image that still does not fit after the last resort', async () => {
		const big = png(1800, 1800, 4 * MIB + 10)
		const { sharp } = fakeSharp({ width: 1800, height: 1800 }, () => 6 * MIB)
		const result = await pass({ loadSharp: async () => sharp }, big)
		expect(result.ok).toBe(false)
		expect(!result.ok && result.message).toMatch(/too large/)
	})

	it('converts a BMP to PNG first', async () => {
		const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40, 1)])
		const { sharp, chains } = fakeSharp({ width: 10, height: 10 }, () => 300)
		const result = await pass({ loadSharp: async () => sharp }, bmp)
		expect(chains[0]).toEqual(['png'])
		expect(result.ok && result.mediaType).toBe('image/png')
	})
})

describe('an image over the limits, without the library', () => {
	it('refuses one too wide, in plain words', async () => {
		const result = await pass({ loadSharp: none }, png(4000, 3000, 100))
		expect(result).toEqual({
			ok: false,
			message: expect.stringContaining('image resizing is unavailable'),
		})
	})

	it('refuses one too heavy, and a BMP', async () => {
		expect((await pass({ loadSharp: none }, png(1000, 1000, 5 * MIB))).ok).toBe(false)
		const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40, 1)])
		expect((await pass({ loadSharp: none }, bmp)).ok).toBe(false)
	})

	it('refuses an empty file and something that is not an image', async () => {
		expect((await pass({ loadSharp: none }, Buffer.alloc(0))).ok).toBe(false)
		expect((await pass({ loadSharp: none }, Buffer.from('plain text, not a picture'))).ok).toBe(
			false,
		)
	})

	it('lets a small file with unreadable dimensions through', async () => {
		const bytes = png(0, 0, 40)
		expect((await pass({ loadSharp: none }, bytes)).ok).toBe(true)
	})
})

describe('the real library', async () => {
	const name = 'sharp'
	const real = (await import(name).then(
		(m: { default: unknown }) => m.default,
		() => null,
	)) as null | ((input: unknown) => { png(): { toBuffer(): Promise<Buffer> } })
	const run = it.skipIf(real === null)

	/** A solid-colour image of the given size, as PNG bytes. */
	async function solid(width: number, height: number): Promise<Buffer> {
		const make = real as unknown as (options: unknown) => { png(): { toBuffer(): Promise<Buffer> } }
		return make({ create: { width, height, channels: 3, background: '#336699' } })
			.png()
			.toBuffer()
	}

	run('passes an image inside the limits through unchanged', async () => {
		const bytes = await solid(300, 200)
		const result = await fitImage(bytes)
		expect(result.ok && Buffer.compare(result.data, bytes)).toBe(0)
	})

	run('scales a 3000x1500 PNG down to 2000x1000', async () => {
		const result = await fitImage(await solid(3000, 1500))
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const make = real as unknown as (input: Buffer) => {
			metadata(): Promise<{ width: number; height: number }>
		}
		expect(await make(result.data).metadata()).toMatchObject({ width: 2000, height: 1000 })
	})
})

describe('the common case', () => {
	it('does not load the image library for an image its header shows is inside the limits', async () => {
		let loads = 0
		const result = await fitImage(png(800, 600, 5_000), {
			loadSharp: async () => {
				loads += 1
				return null
			},
		})
		expect(result.ok).toBe(true)
		expect(loads).toBe(0)
	})
})
