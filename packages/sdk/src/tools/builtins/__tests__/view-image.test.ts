import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { decode, encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseHost } from '../../../types/computer-use/index.js'
import type { ToolResultBlock } from '../../../types/message/index.js'
import type { Sandbox, SandboxReadFileOptions } from '../../../types/sandbox/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'
import { ViewImageTool, createViewImageTool } from '../view-image.js'

const JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
	'base64',
)
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAgA0JaQAA3AA/v89', 'base64')
const tempDirectories: string[] = []

afterEach(async () => {
	for (const path of tempDirectories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'namzu-view-image-'))
	tempDirectories.push(path)
	return path
}

function context(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extras,
	}
}

function png(width = 8, height = 6): Buffer {
	return Buffer.from(
		encode({
			width,
			height,
			channels: 3,
			depth: 8,
			data: new Uint8Array(width * height * 3).fill(90),
		}),
	)
}

function sandbox(readFile: Sandbox['readFile']): Sandbox {
	return {
		id: 'f0f0d1d0-6a4c-4a3f-9ba7-2f8a7cf6b1c4',
		status: 'ready',
		rootDir: '/guest',
		environment: 'basic',
		readFile,
	} as Sandbox
}

function image(result: ToolResult): Extract<ToolResultBlock, { type: 'image' }> {
	expect(result.success, result.error).toBe(true)
	const block = (result.content as readonly ToolResultBlock[]).find(
		(entry) => entry.type === 'image',
	)
	expect(block?.type).toBe('image')
	return block as Extract<ToolResultBlock, { type: 'image' }>
}

/** A real PNG chunk, including its CRC, for malformed-payload fixtures. */
function chunk(type: string, data: Buffer): Buffer {
	const result = Buffer.alloc(data.length + 12)
	result.writeUInt32BE(data.length)
	result.write(type, 4, 'ascii')
	data.copy(result, 8)
	let crc = 0xffffffff
	for (const byte of result.subarray(4, result.length - 4)) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
	}
	result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
	return result
}

function pngWithData(compressed: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
	const valid = png(1, 1)
	return Buffer.concat([
		valid.subarray(0, 33),
		extra,
		chunk('IDAT', compressed),
		chunk('IEND', Buffer.alloc(0)),
	])
}

describe('view_image artifact inspection', () => {
	it('sends real decoded image content, detected from bytes rather than the extension', async () => {
		const dir = await directory()
		const bytes = png()
		await writeFile(join(dir, 'render.jpeg'), bytes)
		const result = await ViewImageTool.execute({ path: 'render.jpeg' }, context(dir))
		const block = image(result)
		expect(block.mediaType).toBe('image/png')
		expect(decode(Buffer.from(block.data, 'base64'))).toMatchObject({ width: 8, height: 6 })
		expect(result.data).toMatchObject({
			artifact: true,
			sandboxed: false,
			validation: 'decoded',
			sourceBytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		})
		expect(result.content?.[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('not a current computer_use screenshot'),
		})
	})

	it('fits large PNG pixels and truthfully reports original and delivered sizes', async () => {
		const bytes = png(2000, 500)
		const result = await ViewImageTool.execute(
			{ path: '/guest/render.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		const decoded = decode(Buffer.from(image(result).data, 'base64'))
		expect(result.data).toMatchObject({
			sourceWidth: 2000,
			sourceHeight: 500,
			width: 1568,
			height: 392,
		})
		expect(decoded.width).toBe(1568)
		expect(decoded.height).toBe(392)
		expect(new Set(decoded.data)).toEqual(new Set([90]))
	})

	it('preserves PNG colour-key transparency during resizing', async () => {
		const width = 2000
		const data = new Uint8Array(width * 3)
		data.fill(90, 0, (width * 3) / 2)
		data.fill(150, (width * 3) / 2)
		const raw = Buffer.from(encode({ width, height: 1, channels: 3, depth: 8, data }))
		const bytes = Buffer.concat([
			raw.subarray(0, 33),
			chunk('tRNS', Buffer.from([0, 90, 0, 90, 0, 90])),
			raw.subarray(33),
		])
		const result = await ViewImageTool.execute(
			{ path: '/guest/transparent.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		const decoded = decode(Buffer.from(image(result).data, 'base64'))
		expect(decoded.channels).toBe(4)
		expect(decoded.data[3]).toBe(0)
		expect([...decoded.data.slice(-4)]).toEqual([150, 150, 150, 255])
	})

	it('unpacks low-bit greyscale artifacts before resizing', async () => {
		const header = Buffer.from(png(2000, 2).subarray(16, 29))
		header[8] = 1
		header[9] = 0
		const rows = Buffer.concat([
			Buffer.from([0]),
			Buffer.alloc(250, 255),
			Buffer.from([0]),
			Buffer.alloc(250),
		])
		const bytes = Buffer.concat([
			png().subarray(0, 8),
			chunk('IHDR', header),
			chunk('IDAT', deflateSync(rows)),
			chunk('IEND', Buffer.alloc(0)),
		])
		const result = await ViewImageTool.execute(
			{ path: '/guest/one-bit.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		const decoded = decode(Buffer.from(image(result).data, 'base64'))
		expect(decoded).toMatchObject({ width: 1568, height: 2 })
		expect([...decoded.data.slice(0, 3)]).toEqual([255, 255, 255])
		expect([...decoded.data.slice(-3)]).toEqual([0, 0, 0])
	})

	it.each([
		['greyscale', 0],
		['indexed', 3],
	] as const)(
		'refuses valid low-bit Adam7 %s images rather than showing incorrectly decoded pixels',
		async (_format, colour) => {
			const header = Buffer.from(png(2, 1).subarray(16, 29))
			header[8] = 1
			header[9] = colour
			header[12] = 1
			// Adam7 passes 1 and 6 each contain one WHITE pixel. fast-png's
			// sub-byte interlace reader treats them as two independent packed
			// bytes, so unwrapping that result would fabricate a BLACK pixel.
			const bytes = Buffer.concat([
				png().subarray(0, 8),
				chunk('IHDR', header),
				...(colour === 3 ? [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] : []),
				chunk('IDAT', deflateSync(Buffer.from([0, 128, 0, 128]))),
				chunk('IEND', Buffer.alloc(0)),
			])
			const result = await ViewImageTool.execute(
				{ path: '/guest/interlaced-one-bit.png' },
				context('/host', { sandbox: sandbox(async () => bytes) }),
			)
			expect(result.success).toBe(false)
			expect(result.error).toContain('Interlaced PNGs below 8 bits per sample are unsupported')
			expect(result.error).toContain('non-interlaced or 8-bit PNG')
			expect(result.content).toBeUndefined()
		},
	)

	it('preserves valid 8-bit Adam7 images', async () => {
		const header = Buffer.from(png(2, 1).subarray(16, 29))
		header[12] = 1
		const bytes = Buffer.concat([
			png().subarray(0, 8),
			chunk('IHDR', header),
			chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 0, 255, 0, 0]))),
			chunk('IEND', Buffer.alloc(0)),
		])
		const result = await ViewImageTool.execute(
			{ path: '/guest/interlaced-eight-bit.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect([...decode(Buffer.from(image(result).data, 'base64')).data]).toEqual([
			255, 255, 255, 255, 0, 0,
		])
	})

	it.each([
		['image/jpeg', JPEG],
		['image/webp', WEBP],
	] as const)(
		'admits complete standard-size %s containers without claiming local pixel decoding',
		async (mediaType, bytes) => {
			const result = await ViewImageTool.execute(
				{ path: '/guest/reference.png' },
				context('/host', { sandbox: sandbox(async () => bytes) }),
			)
			expect(image(result)).toMatchObject({ mediaType, data: bytes.toString('base64') })
			expect(result.data).toMatchObject({ validation: 'container', width: 1, height: 1 })
			expect(result.content?.[0]).toMatchObject({
				text: expect.stringContaining('pixels were not decoded by this tool'),
			})
		},
	)

	it.each([png(), JPEG, WEBP])(
		'refuses a truncated raster instead of emitting a success image',
		async (bytes) => {
			const result = await ViewImageTool.execute(
				{ path: '/guest/truncated' },
				context('/host', { sandbox: sandbox(async () => bytes.subarray(0, bytes.length - 4)) }),
			)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/malformed or truncated/)
			expect(result.content).toBeUndefined()
		},
	)

	it('rejects a misleading .png containing text or vector data', async () => {
		const result = await ViewImageTool.execute(
			{ path: '/guest/fake.png' },
			context('/host', {
				sandbox: sandbox(async () => Buffer.from('<svg><text>not raster</text></svg>')),
			}),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('renaming the file does not convert it')
	})

	it('refuses corrupt PNG CRCs even when the image does not need resizing', async () => {
		const bytes = png()
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
		const result = await ViewImageTool.execute(
			{ path: '/guest/corrupt.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/malformed or truncated/)
	})

	it('rejects compressed pixels that are invalid despite a complete, CRC-correct PNG container', async () => {
		const bytes = pngWithData(deflateSync(Buffer.from([6, 90, 90, 90])))
		const result = await ViewImageTool.execute(
			{ path: '/guest/filter.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/malformed or truncated/)
	})

	it('bounds PNG decompression to the declared scanline size', async () => {
		const bytes = pngWithData(deflateSync(Buffer.alloc(10_000)))
		const result = await ViewImageTool.execute(
			{ path: '/guest/bomb.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/malformed or truncated/)
	})

	it('refuses decoded palette indexes that have no corresponding colour', async () => {
		const header = Buffer.from(png(1, 1).subarray(16, 29))
		header[9] = 3
		const bytes = Buffer.concat([
			png().subarray(0, 8),
			chunk('IHDR', header),
			chunk('PLTE', Buffer.from([0, 0, 0])),
			chunk('IDAT', deflateSync(Buffer.from([0, 2]))),
			chunk('IEND', Buffer.alloc(0)),
		])
		const result = await ViewImageTool.execute(
			{ path: '/guest/palette.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/malformed or truncated/)
	})

	it('does not inflate compressed ancillary metadata while validating actual image pixels', async () => {
		const profile = chunk(
			'iCCP',
			Buffer.concat([Buffer.from('unused\0\0'), deflateSync(Buffer.alloc(10_000))]),
		)
		const bytes = pngWithData(deflateSync(Buffer.from([0, 90, 90, 90])), profile)
		const result = await ViewImageTool.execute(
			{ path: '/guest/metadata.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect([...decode(Buffer.from(image(result).data, 'base64')).data]).toEqual([90, 90, 90])
	})

	it('refuses animated images instead of claiming to have inspected every frame', async () => {
		const bytes = pngWithData(
			deflateSync(Buffer.from([0, 90, 90, 90])),
			chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
		)
		const result = await ViewImageTool.execute(
			{ path: '/guest/animated.png' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Animated PNG is unsupported')
	})

	it('refuses oversized dimensions before decompressing the image', async () => {
		const bytes = png()
		const header = Buffer.from(bytes.subarray(16, 29))
		header.writeUInt32BE(5000, 0)
		header.writeUInt32BE(5000, 4)
		const enormous = Buffer.concat([
			bytes.subarray(0, 8),
			chunk('IHDR', header),
			bytes.subarray(33),
		])
		const result = await ViewImageTool.execute(
			{ path: '/guest/huge.png' },
			context('/host', { sandbox: sandbox(async () => enormous) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('16 million pixels')
	})

	it('explains the JPEG/WebP resize limitation instead of passing oversized pixels to the provider', async () => {
		const bytes = Buffer.from(WEBP)
		bytes.writeUInt16LE(2000, 26)
		const result = await ViewImageTool.execute(
			{ path: '/guest/wide.webp' },
			context('/host', { sandbox: sandbox(async () => bytes) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('JPEG/WebP decoding and resizing are unavailable')
		expect(result.error).toContain('export a PNG')
	})

	it('reads only the guest path with an explicit byte bound and propagates refusal without a host fallback', async () => {
		const dir = await directory()
		const file = join(dir, 'same-name.png')
		await writeFile(file, png())
		const read = vi.fn(
			async (_path: string, _options?: SandboxReadFileOptions): Promise<Buffer> => {
				throw new Error('guest refused this path')
			},
		)
		const ctx = context(dir, { sandbox: sandbox(read) })
		const result = await ViewImageTool.execute({ path: file }, ctx)
		expect(result.success).toBe(false)
		expect(result.error).toContain('guest refused this path')
		expect(read).toHaveBeenCalledExactlyOnceWith(file, {
			offset: 0,
			length: 16 * 1024 * 1024 + 1,
			signal: ctx.abortSignal,
		})
	})

	it('rejects guest payloads above the byte bound', async () => {
		const result = await ViewImageTool.execute(
			{ path: '/guest/huge.png' },
			context('/host', { sandbox: sandbox(async () => Buffer.alloc(16 * 1024 * 1024 + 1)) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('16 MiB')
	})

	it('refuses an oversized host file before reading its body', async () => {
		const dir = await directory()
		const path = join(dir, 'huge.png')
		await writeFile(path, png())
		await truncate(path, 16 * 1024 * 1024 + 1)
		const result = await ViewImageTool.execute({ path }, context(dir))
		expect(result.success).toBe(false)
		expect(result.error).toContain('16 MiB')
	})

	it('follows the real-path permission boundary and honors a call-scoped approved file', async () => {
		const dir = await directory()
		const outside = await directory()
		const path = join(outside, 'outside.png')
		await writeFile(path, png())
		await symlink(path, join(dir, 'escape.png'))
		const refused = await ViewImageTool.execute({ path: 'escape.png' }, context(dir))
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('outside')
		const approved = await ViewImageTool.execute({ path }, context(dir, { approvedPaths: [path] }))
		expect(image(approved).mediaType).toBe('image/png')
	})

	it('refuses before reading when the chosen provider cannot see image results', async () => {
		const read = vi.fn(async () => png())
		const tool = createViewImageTool({
			unavailableReason: 'provider does not support image tool results',
		})
		const result = await tool.execute(
			{ path: '/guest/image.png' },
			context('/host', { sandbox: sandbox(read) }),
		)
		expect(result.success).toBe(false)
		expect(result.output).toContain('No image was read or shown')
		expect(read).not.toHaveBeenCalled()
	})

	it('checks cancellation before touching the file backend', async () => {
		const controller = new AbortController()
		controller.abort(new Error('cancelled inspection'))
		const read = vi.fn(async () => png())
		const result = await ViewImageTool.execute(
			{ path: '/guest/image.png' },
			context('/host', { sandbox: sandbox(read), abortSignal: controller.signal }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('cancelled inspection')
		expect(read).not.toHaveBeenCalled()
	})

	it('never grants GUI input authority from a saved artifact', async () => {
		const execute = vi.fn<ComputerUseHost['execute']>()
		const host: ComputerUseHost = {
			id: 'test',
			capabilities: {
				displayServer: 'win32',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: true,
				clipboard: true,
			},
			getDisplayGeometry: async () => ({ width: 8, height: 6, scaleFactor: 1 }),
			execute,
		}
		const computer = createComputerUseTool(host, { settleMs: 0, screenshotAfterActions: false })
		const ctx = context('/host', { sandbox: sandbox(async () => png()) })
		const seen = await ViewImageTool.execute({ path: '/guest/reference.png' }, ctx)
		expect(seen.success).toBe(true)
		expect(seen.workingState).toBeUndefined()
		expect(seen.data).not.toHaveProperty('screenshot')
		const clicked = await computer.execute(
			computer.inputSchema.parse({ type: 'mouse_click', at: { x: 1, y: 1 } }),
			ctx,
		)
		expect(clicked.success).toBe(false)
		expect(clicked.error).toContain('screenshot')
		expect(execute).not.toHaveBeenCalled()
	})
})
