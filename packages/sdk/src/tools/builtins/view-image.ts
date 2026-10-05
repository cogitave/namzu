import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { z } from 'zod'
import { admitMcpImageBatch } from '../../connector/mcp/image-admission.js'
import type { ToolContext, ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'
import { STANDARD_SCREENSHOT_LIMITS, fitPng, screenshotTargetSize } from './computer-use-image.js'

// 16 MiB becomes less than the runtime's 24 MiB encoded rich-content budget.
// Admission is per artifact; the runtime still budgets accumulated images.
const MAX_BYTES = 16 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024
const MAX_EDGE = 16_384
const MAX_PIXELS = 16_000_000
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_FRAME_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

const inputSchema = z.object({
	path: z.string().min(1).describe("Path to a saved PNG, JPEG or WebP image in this turn's files"),
})

/** Host admission for a model which cannot receive image tool results. */
export interface ViewImageToolOptions {
	readonly unavailableReason?: string
}

interface Raster {
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	readonly width: number
	readonly height: number
}

async function readBounded(
	read: (offset: number, length: number) => Promise<Buffer>,
	signal: AbortSignal,
): Promise<Buffer> {
	const chunks: Buffer[] = []
	let offset = 0
	for (;;) {
		signal.throwIfAborted()
		const length = Math.min(READ_CHUNK_BYTES, MAX_BYTES + 1 - offset)
		const chunk = await read(offset, length)
		signal.throwIfAborted()
		if (chunk.length > length)
			throw new Error('The file backend returned more bytes than the requested bounded range.')
		offset += chunk.length
		if (offset > MAX_BYTES)
			throw new Error('Image exceeds the 16 MiB inspection limit. Export a smaller image.')
		chunks.push(chunk)
		if (chunk.length < length) return Buffer.concat(chunks, offset)
	}
}

async function readArtifact(
	path: string,
	context: ToolContext,
): Promise<{ path: string; bytes: Buffer; sandboxed: boolean }> {
	context.abortSignal.throwIfAborted()
	if (context.sandbox) {
		const bytes = await context.sandbox.readFile(path, {
			offset: 0,
			length: MAX_BYTES + 1,
			signal: context.abortSignal,
		})
		context.abortSignal.throwIfAborted()
		if (bytes.length > MAX_BYTES)
			throw new Error('Image exceeds the 16 MiB inspection limit. Export a smaller image.')
		return { path, bytes, sandboxed: true }
	}
	const resolved = await resolveWithinAnyReal(toolRoots(context), path)
	const file = await open(resolved, 'r')
	try {
		const stat = await file.stat()
		if (!stat.isFile()) throw new Error('Image inspection requires a regular file.')
		if (stat.size > MAX_BYTES)
			throw new Error('Image exceeds the 16 MiB inspection limit. Export a smaller image.')
		const bytes = await readBounded(async (offset, length) => {
			const buffer = Buffer.allocUnsafe(length)
			const { bytesRead } = await file.read(buffer, 0, length, offset)
			return buffer.subarray(0, bytesRead)
		}, context.abortSignal)
		return { path: resolved, bytes, sandboxed: false }
	} finally {
		await file.close()
	}
}

function malformed(): never {
	throw new Error('Image is malformed or truncated. Export a complete static PNG, JPEG or WebP.')
}

function jpegDimensions(bytes: Buffer): Pick<Raster, 'width' | 'height'> {
	let offset = 2
	let inScan = false
	let frame: Pick<Raster, 'width' | 'height'> | undefined
	while (offset < bytes.length) {
		if (inScan && bytes[offset] !== 0xff) {
			offset += 1
			continue
		}
		if (bytes[offset] !== 0xff) malformed()
		while (bytes[offset] === 0xff) offset += 1
		const marker = bytes[offset]
		if (marker === undefined) malformed()
		offset += 1
		if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue
		inScan = false
		if (marker === 0xd9) break
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		if (offset + 2 > bytes.length) malformed()
		const length = bytes.readUInt16BE(offset)
		if (length < 2 || offset + length > bytes.length) malformed()
		if (JPEG_FRAME_MARKERS.has(marker)) {
			if (length < 8 || frame) malformed()
			frame = {
				width: bytes.readUInt16BE(offset + 5),
				height: bytes.readUInt16BE(offset + 3),
			}
		}
		offset += length
		if (marker === 0xda) inScan = true
	}
	return frame ?? malformed()
}

function webpDimensions(bytes: Buffer): Pick<Raster, 'width' | 'height'> {
	let offset = 12
	let dimensions: Pick<Raster, 'width' | 'height'> | undefined
	while (offset + 8 <= bytes.length) {
		const type = bytes.toString('ascii', offset, offset + 4)
		const length = bytes.readUInt32LE(offset + 4)
		const start = offset + 8
		if (start + length > bytes.length) malformed()
		let current: Pick<Raster, 'width' | 'height'> | undefined
		if (type === 'ANIM' || type === 'ANMF')
			throw new Error('Animated WebP is unsupported. Export the required frame as a static PNG.')
		if (type === 'VP8X' && length >= 10) {
			current = {
				width: bytes.readUIntLE(start + 4, 3) + 1,
				height: bytes.readUIntLE(start + 7, 3) + 1,
			}
		} else if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
			const packed = bytes.readUInt32LE(start + 1)
			current = {
				width: (packed & 0x3fff) + 1,
				height: ((packed >>> 14) & 0x3fff) + 1,
			}
		} else if (type === 'VP8 ' && length >= 10) {
			current = {
				width: bytes.readUInt16LE(start + 6) & 0x3fff,
				height: bytes.readUInt16LE(start + 8) & 0x3fff,
			}
		}
		if (current) {
			if (
				dimensions &&
				(dimensions.width !== current.width || dimensions.height !== current.height)
			)
				malformed()
			dimensions = current
		}
		offset = start + length + (length & 1)
	}
	return dimensions ?? malformed()
}

function describeRaster(bytes: Buffer): Raster {
	let raster: Raster
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		if (bytes.length < 33) malformed()
		raster = {
			mediaType: 'image/png',
			width: bytes.readUInt32BE(16),
			height: bytes.readUInt32BE(20),
		}
	} else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		raster = { mediaType: 'image/jpeg', ...jpegDimensions(bytes) }
	} else if (
		bytes.toString('ascii', 0, 4) === 'RIFF' &&
		bytes.toString('ascii', 8, 12) === 'WEBP'
	) {
		raster = { mediaType: 'image/webp', ...webpDimensions(bytes) }
	} else {
		throw new Error(
			'Unsupported image bytes. Export a static PNG, JPEG or WebP; renaming the file does not convert it.',
		)
	}
	if (
		raster.width < 1 ||
		raster.height < 1 ||
		raster.width > MAX_EDGE ||
		raster.height > MAX_EDGE ||
		raster.width * raster.height > MAX_PIXELS
	)
		throw new Error(
			'Image dimensions exceed the inspection limit (16,384 pixels per edge, 16 million pixels total). Export a smaller image.',
		)
	return raster
}

/** Validate bounded pixel data without inflating ancillary metadata. */
async function validatedPng(bytes: Buffer, raster: Raster): Promise<Buffer> {
	const depth = bytes[24] ?? 0
	const colour = bytes[25] ?? -1
	const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour]
	const allowedDepths = colour === 0 ? [1, 2, 4, 8, 16] : colour === 3 ? [1, 2, 4, 8] : [8, 16]
	if (
		!channels ||
		!allowedDepths.includes(depth) ||
		bytes[26] !== 0 ||
		bytes[27] !== 0 ||
		(bytes[28] !== 0 && bytes[28] !== 1)
	)
		malformed()
	// fast-png's Adam7 reader lays out sub-byte pixels as whole bytes. Do not
	// return a success observation whose unpacked pixels differ from the file.
	if (bytes[28] === 1 && depth < 8)
		throw new Error(
			'Interlaced PNGs below 8 bits per sample are unsupported by this decoder. Export a non-interlaced or 8-bit PNG and inspect that file.',
		)
	const passes =
		bytes[28] === 1
			? [
					[0, 0, 8, 8],
					[4, 0, 8, 8],
					[0, 4, 4, 8],
					[2, 0, 4, 4],
					[0, 2, 2, 4],
					[1, 0, 2, 2],
					[0, 1, 1, 2],
				]
			: [[0, 0, 1, 1]]
	let expected = 0
	for (const [x = 0, y = 0, dx = 1, dy = 1] of passes) {
		const width = Math.max(0, Math.ceil((raster.width - x) / dx))
		const height = Math.max(0, Math.ceil((raster.height - y) / dy))
		if (width > 0 && height > 0)
			expected += (Math.ceil((width * channels * depth) / 8) + 1) * height
	}
	const chunks: Buffer[] = [PNG_SIGNATURE]
	const compressed: Buffer[] = []
	let offset = 8
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset)
		const type = bytes.toString('ascii', offset + 4, offset + 8)
		const end = offset + length + 12
		if (end > bytes.length) malformed()
		if (type === 'acTL' || type === 'fcTL' || type === 'fdAT')
			throw new Error('Animated PNG is unsupported. Export the required frame as a static PNG.')
		if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, end - 4))
		if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type))
			chunks.push(bytes.subarray(offset, end))
		else if (/^[A-Z]/.test(type)) throw new Error(`Unsupported critical PNG chunk: ${type}.`)
		offset = end
	}
	// fast-png's inflater does not expose a byte ceiling. Check the complete
	// compressed pixel stream with Node's ceiling before handing it the image.
	try {
		const inflated = inflateSync(Buffer.concat(compressed), {
			maxOutputLength: expected,
		})
		if (inflated.length !== expected) malformed()
	} catch {
		malformed()
	}
	const canonical = Buffer.concat(chunks)
	const { decode, encode, convertIndexedToRgb } = await import('fast-png')
	try {
		const decoded = decode(canonical, { checkCrc: true })
		if (decoded.width !== raster.width || decoded.height !== raster.height) malformed()
		// Decode indexed pixels too: a complete PLTE/IDAT container can still
		// refer to a palette entry that does not exist.
		if (decoded.palette) convertIndexedToRgb(decoded)
		else if (decoded.depth < 8 || decoded.transparency) {
			// Screenshot resizing assumes unpacked 8/16-bit samples and explicit
			// alpha. Saved images can use packed greyscale or tRNS colour keys.
			const rgba = new Uint8Array(raster.width * raster.height * 4)
			const packedStride = Math.ceil((raster.width * decoded.depth) / 8)
			const maxSample = 2 ** decoded.depth - 1
			for (let y = 0; y < raster.height; y += 1) {
				for (let x = 0; x < raster.width; x += 1) {
					const i = y * raster.width + x
					const packed = decoded.data[y * packedStride + Math.floor((x * decoded.depth) / 8)] ?? 0
					const grey =
						decoded.depth < 8
							? (packed >>> (8 - decoded.depth - ((x * decoded.depth) % 8))) & maxSample
							: (decoded.data[i * decoded.channels] ?? 0)
					const r = grey
					const g = decoded.channels >= 3 ? (decoded.data[i * decoded.channels + 1] ?? 0) : grey
					const b = decoded.channels >= 3 ? (decoded.data[i * decoded.channels + 2] ?? 0) : grey
					rgba[i * 4] = Math.round((r * 255) / maxSample)
					rgba[i * 4 + 1] = Math.round((g * 255) / maxSample)
					rgba[i * 4 + 2] = Math.round((b * 255) / maxSample)
					const transparent =
						decoded.transparency &&
						r === decoded.transparency[0] &&
						(decoded.channels === 1 ||
							(g === decoded.transparency[1] && b === decoded.transparency[2]))
					rgba[i * 4 + 3] = transparent ? 0 : 255
				}
			}
			return Buffer.from(
				encode({ width: raster.width, height: raster.height, data: rgba, channels: 4, depth: 8 }),
			)
		}
	} catch {
		malformed()
	}
	return canonical
}

/**
 * Inspect an artifact without granting screen-coordinate authority. An image
 * file can be a reference, render or export; it is never a computer_use frame.
 */
export function createViewImageTool(
	options: ViewImageToolOptions = {},
): ToolDefinition<z.infer<typeof inputSchema>> {
	const unavailableReason = options.unavailableReason
	return defineTool({
		name: 'view_image',
		description: `Visually inspect a saved PNG, JPEG or WebP reference, render or exported image. Reads this turn's files and returns actual image pixels to the model, with source dimensions. PNGs are decoded and fitted; JPEG/WebP containers are checked and must already fit standard vision size. File pixels are not a live desktop screenshot and cannot authorize mouse coordinates.${unavailableReason ? ` Unavailable: ${unavailableReason} Do not retry; tell the user.` : ''}`,
		inputSchema,
		category: 'filesystem',
		pathArgument: 'path',
		permissions: ['file_read'],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		presentCall: (input) => ({
			kind: 'generic',
			label: `Inspect ${input.path}`,
			presentation: 'activity',
			activity: 'exploration',
		}),
		async execute(input, context) {
			if (unavailableReason) {
				const message = `view_image unavailable: ${unavailableReason} No image was read or shown. Do not retry; tell the user.`
				return { success: false, output: message, error: message }
			}
			const artifact = await readArtifact(input.path, context)
			const source = describeRaster(artifact.bytes)
			if (
				!admitMcpImageBatch([
					{
						type: 'image',
						mimeType: source.mediaType,
						data: artifact.bytes.toString('base64'),
					},
				])
			)
				malformed()
			context.abortSignal.throwIfAborted()
			let image = {
				data: artifact.bytes,
				width: source.width,
				height: source.height,
			}
			if (source.mediaType === 'image/png') {
				const png = await validatedPng(artifact.bytes, source)
				image = await fitPng(png, STANDARD_SCREENSHOT_LIMITS)
			} else {
				const target = screenshotTargetSize(source.width, source.height)
				if (target.width !== source.width || target.height !== source.height)
					throw new Error(
						`This ${source.mediaType} image needs resizing. JPEG/WebP decoding and resizing are unavailable here; export a PNG (or a smaller JPEG/WebP) and inspect that file.`,
					)
			}
			context.abortSignal.throwIfAborted()
			const validation = source.mediaType === 'image/png' ? 'decoded' : 'container'
			const output = `Image artifact: ${artifact.path} (${source.width}x${source.height}, ${source.mediaType}); shown at ${image.width}x${image.height}.`
			return {
				success: true,
				output,
				content: [
					{
						type: 'text',
						text: `${output}\n${validation === 'container' ? 'The complete container and dimensions were validated; compressed JPEG/WebP pixels were not decoded by this tool. ' : ''}Inspect these pixels for visual evidence. This saved artifact is not a current computer_use screenshot; capture the application before GUI input.`,
					},
					{
						type: 'image',
						mediaType: source.mediaType,
						data: image.data.toString('base64'),
					},
				],
				data: {
					path: artifact.path,
					sandboxed: artifact.sandboxed,
					artifact: true,
					mediaType: source.mediaType,
					sourceWidth: source.width,
					sourceHeight: source.height,
					width: image.width,
					height: image.height,
					sourceBytes: artifact.bytes.length,
					sha256: createHash('sha256').update(artifact.bytes).digest('hex'),
					validation,
				},
			}
		},
	})
}

/** An optional artifact inspection tool; hosts must mount it explicitly. */
export const ViewImageTool = createViewImageTool()
