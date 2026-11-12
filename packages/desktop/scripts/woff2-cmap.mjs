// Reads the character map of a woff2 file: which code points the face can draw. A woff2 file keeps
// its tables in one brotli stream; only `glyf` and `loca` are transformed, and `cmap` is stored as it
// is, so the table directory is walked to find where each table sits in the decompressed stream.
import { brotliDecompressSync } from 'node:zlib'

// The table tags a woff2 directory entry can name by index (woff2 spec, section 5.1).
const KNOWN_TAGS = [
	'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
	'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
	'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
	'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
	'gvar', 'hsty', 'just', 'lcar', 'meta', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
	'Gloc', 'Feat', 'Sill',
]

/** The tables of a woff2 file by tag, each a Buffer of its (decompressed) bytes. */
export function woff2Tables(buffer) {
	if (buffer.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 file')
	const count = buffer.readUInt16BE(12)
	// The length that sits in the stream is the transformed one when a table is transformed.
	let cursor = 48
	const lengths = []
	for (let i = 0; i < count; i++) {
		const flags = buffer[cursor++]
		const index = flags & 63
		let tag
		if (index === 63) {
			tag = buffer.toString('latin1', cursor, cursor + 4)
			cursor += 4
		} else tag = KNOWN_TAGS[index]
		const version = flags >> 6
		const read = () => {
			let value = 0
			for (let k = 0; k < 5; k++) {
				const byte = buffer[cursor++]
				value = value * 128 + (byte & 127)
				if (!(byte & 128)) break
			}
			return value
		}
		const original = read()
		const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0
		lengths.push({ tag, length: transformed ? read() : original })
	}
	const compressed = buffer.readUInt32BE(20)
	const stream = brotliDecompressSync(buffer.subarray(cursor, cursor + compressed))
	const tables = {}
	let offset = 0
	for (const { tag, length } of lengths) {
		tables[tag] = stream.subarray(offset, offset + length)
		offset += length
	}
	return tables
}

/** Every code point the font's character map covers, sorted, as a plain array. */
export function coveredCodePoints(buffer) {
	const { cmap } = woff2Tables(buffer)
	if (!cmap) throw new Error('the font has no cmap table')
	const found = new Set()
	const subtables = cmap.readUInt16BE(2)
	for (let i = 0; i < subtables; i++) {
		const platform = cmap.readUInt16BE(4 + i * 8)
		const encoding = cmap.readUInt16BE(6 + i * 8)
		const offset = cmap.readUInt32BE(8 + i * 8)
		// Unicode subtables only: platform 0, or Windows with Unicode BMP (1) or full repertoire (10).
		const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
		if (!unicode) continue
		const format = cmap.readUInt16BE(offset)
		if (format === 4) {
			const segments = cmap.readUInt16BE(offset + 6) / 2
			const ends = offset + 14
			const starts = ends + segments * 2 + 2
			const deltas = starts + segments * 2
			const ranges = deltas + segments * 2
			for (let k = 0; k < segments; k++) {
				const end = cmap.readUInt16BE(ends + k * 2)
				const start = cmap.readUInt16BE(starts + k * 2)
				const delta = cmap.readInt16BE(deltas + k * 2)
				const rangeOffset = cmap.readUInt16BE(ranges + k * 2)
				for (let c = start; c <= end && start !== 0xffff; c++) {
					let glyph
					if (rangeOffset === 0) glyph = (c + delta) & 0xffff
					else {
						glyph = cmap.readUInt16BE(ranges + k * 2 + rangeOffset + (c - start) * 2)
						if (glyph) glyph = (glyph + delta) & 0xffff
					}
					if (glyph) found.add(c)
				}
			}
		} else if (format === 12) {
			const groups = cmap.readUInt32BE(offset + 12)
			for (let k = 0; k < groups; k++) {
				const start = cmap.readUInt32BE(offset + 16 + k * 12)
				const end = cmap.readUInt32BE(offset + 20 + k * 12)
				const glyph = cmap.readUInt32BE(offset + 24 + k * 12)
				for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) found.add(c)
			}
		}
	}
	return [...found].sort((a, b) => a - b)
}

/** Sorted code points as inclusive [first, last] ranges. */
export function toRanges(points) {
	const ranges = []
	for (const point of points) {
		const last = ranges[ranges.length - 1]
		if (last && point === last[1] + 1) last[1] = point
		else ranges.push([point, point])
	}
	return ranges
}
