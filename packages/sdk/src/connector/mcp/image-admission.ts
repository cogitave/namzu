import type { MCPContentBlock } from '../../types/connector/index.js'

const MAX_ENCODED_BYTES = 24 * 1024 * 1024
const MAX_DIMENSION = 16_384
const MAX_PIXELS = 40_000_000

type MCPImageBlock = Extract<MCPContentBlock, { type: 'image' }>
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
])

function isImageMediaType(value: string): value is ImageMediaType {
	return IMAGE_MEDIA_TYPES.has(value as ImageMediaType)
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
	if (value.length === 0 || value.length > MAX_ENCODED_BYTES) return null
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		return null
	}
	const decoded = Buffer.from(value, 'base64')
	return decoded.toString('base64') === value ? decoded : null
}

function dimensionsAreSafe(width: number, height: number): boolean {
	return (
		Number.isSafeInteger(width) &&
		Number.isSafeInteger(height) &&
		width > 0 &&
		height > 0 &&
		width <= MAX_DIMENSION &&
		height <= MAX_DIMENSION &&
		width * height <= MAX_PIXELS
	)
}

const crcTable = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n += 1) {
		let value = n
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		}
		table[n] = value >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff
	for (let offset = start; offset < end; offset += 1) {
		crc = (crcTable[(crc ^ (bytes[offset] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

function isPng(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
		return false
	}
	let offset = 8
	let sawHeader = false
	let sawData = false
	while (offset + 12 <= bytes.length) {
		const length = buffer.readUInt32BE(offset)
		const typeStart = offset + 4
		const dataStart = typeStart + 4
		const dataEnd = dataStart + length
		const chunkEnd = dataEnd + 4
		if (dataEnd < dataStart || chunkEnd > bytes.length) return false
		const type = buffer.toString('ascii', typeStart, dataStart)
		if (buffer.readUInt32BE(dataEnd) !== crc32(bytes, typeStart, dataEnd)) return false
		if (!sawHeader) {
			if (type !== 'IHDR' || length !== 13) return false
			const width = buffer.readUInt32BE(dataStart)
			const height = buffer.readUInt32BE(dataStart + 4)
			if (!dimensionsAreSafe(width, height)) return false
			sawHeader = true
		} else if (type === 'IHDR') return false
		if (type === 'IDAT') sawData = true
		if (type === 'IEND') return length === 0 && sawHeader && sawData && chunkEnd === bytes.length
		offset = chunkEnd
	}
	return false
}

const JPEG_SOF_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function isJpeg(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length < 11 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
	let offset = 2
	let sawFrame = false
	let sawScan = false
	let inScan = false
	while (offset < bytes.length) {
		if (inScan && bytes[offset] !== 0xff) {
			offset += 1
			continue
		}
		if (bytes[offset] !== 0xff) return false
		while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
		if (offset >= bytes.length) return false
		const marker = bytes[offset] ?? 0
		offset += 1
		if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue
		inScan = false
		if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		if (offset + 2 > bytes.length) return false
		const length = buffer.readUInt16BE(offset)
		if (length < 2 || offset + length > bytes.length) return false
		if (JPEG_SOF_MARKERS.has(marker)) {
			if (length < 8) return false
			const height = buffer.readUInt16BE(offset + 3)
			const width = buffer.readUInt16BE(offset + 5)
			if (!dimensionsAreSafe(width, height)) return false
			sawFrame = true
		}
		offset += length
		if (marker === 0xda) {
			sawScan = true
			inScan = true
		}
	}
	return false
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
	let offset = start
	while (offset < bytes.length) {
		const length = bytes[offset] ?? 0
		offset += 1
		if (length === 0) return offset
		if (offset + length > bytes.length) return null
		offset += length
	}
	return null
}

function isGif(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length < 14) return false
	const signature = buffer.toString('ascii', 0, 6)
	if (signature !== 'GIF87a' && signature !== 'GIF89a') return false
	if (!dimensionsAreSafe(buffer.readUInt16LE(6), buffer.readUInt16LE(8))) return false
	let offset = 13
	const packed = bytes[10] ?? 0
	if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1)
	if (offset > bytes.length) return false
	let sawImage = false
	while (offset < bytes.length) {
		const marker = bytes[offset] ?? 0
		offset += 1
		if (marker === 0x3b) return sawImage && offset === bytes.length
		if (marker === 0x21) {
			if (offset >= bytes.length) return false
			offset += 1
			const next = skipGifSubBlocks(bytes, offset)
			if (next === null) return false
			offset = next
			continue
		}
		if (marker !== 0x2c || offset + 9 > bytes.length) return false
		const width = buffer.readUInt16LE(offset + 4)
		const height = buffer.readUInt16LE(offset + 6)
		if (!dimensionsAreSafe(width, height)) return false
		const imagePacked = bytes[offset + 8] ?? 0
		offset += 9
		if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
		if (offset >= bytes.length) return false
		offset += 1
		const next = skipGifSubBlocks(bytes, offset)
		if (next === null) return false
		offset = next
		sawImage = true
	}
	return false
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function webpDimensions(type: string, data: Uint8Array): readonly [number, number] | null {
	const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	if (type === 'VP8X') {
		if (data.length < 10) return null
		return [readUInt24LE(data, 4) + 1, readUInt24LE(data, 7) + 1]
	}
	if (type === 'VP8L') {
		if (data.length < 5 || data[0] !== 0x2f) return null
		const bits = buffer.readUInt32LE(1)
		return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
	}
	if (type === 'VP8 ') {
		if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
			return null
		}
		return [buffer.readUInt16LE(6) & 0x3fff, buffer.readUInt16LE(8) & 0x3fff]
	}
	return null
}

function isWebp(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (
		bytes.length < 20 ||
		buffer.toString('ascii', 0, 4) !== 'RIFF' ||
		buffer.readUInt32LE(4) + 8 !== bytes.length ||
		buffer.toString('ascii', 8, 12) !== 'WEBP'
	) {
		return false
	}
	let offset = 12
	let dimensions: readonly [number, number] | null = null
	let sawImagePayload = false
	while (offset + 8 <= bytes.length) {
		const type = buffer.toString('ascii', offset, offset + 4)
		const length = buffer.readUInt32LE(offset + 4)
		const dataStart = offset + 8
		const dataEnd = dataStart + length
		if (dataEnd < dataStart || dataEnd > bytes.length) return false
		const current = webpDimensions(type, bytes.subarray(dataStart, dataEnd))
		if (current && dimensions === null) dimensions = current
		if (type === 'VP8 ' || type === 'VP8L') sawImagePayload = current !== null
		offset = dataEnd + (length & 1)
	}
	return (
		offset === bytes.length &&
		dimensions !== null &&
		sawImagePayload &&
		dimensionsAreSafe(dimensions[0], dimensions[1])
	)
}

function imageIsAdmitted(block: MCPImageBlock): boolean {
	if (!isImageMediaType(block.mimeType)) return false
	const bytes = decodeCanonicalBase64(block.data)
	if (!bytes) return false
	switch (block.mimeType) {
		case 'image/png':
			return isPng(bytes)
		case 'image/jpeg':
			return isJpeg(bytes)
		case 'image/gif':
			return isGif(bytes)
		case 'image/webp':
			return isWebp(bytes)
	}
}

/**
 * Admit an MCP image batch atomically before any member becomes model input.
 *
 * A remote server controls the declared MIME and bytes. Canonical base64 is
 * only an encoding property; the decoded value must also be a complete,
 * bounded raster container whose format agrees with that declaration. One bad
 * member withholds the complete batch so a model is never shown a partial
 * result while the host retains every raw block for inspection.
 */
export function admitMcpImageBatch(images: readonly MCPImageBlock[]): boolean {
	return images.length === 0 || images.every(imageIsAdmitted)
}
