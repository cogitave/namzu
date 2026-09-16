import type { MCPContentBlock } from '../../types/connector/index.js'

const MAX_ENCODED_BYTES = 24 * 1024 * 1024

type MCPAudioBlock = Extract<MCPContentBlock, { type: 'audio' }>
type AudioMediaType = 'audio/wav' | 'audio/mpeg' | 'audio/ogg'

const AUDIO_MEDIA_TYPES = new Set<AudioMediaType>(['audio/wav', 'audio/mpeg', 'audio/ogg'])

function isAudioMediaType(value: string): value is AudioMediaType {
	return AUDIO_MEDIA_TYPES.has(value as AudioMediaType)
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
	if (value.length === 0 || value.length > MAX_ENCODED_BYTES) return null
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		return null
	}
	const decoded = Buffer.from(value, 'base64')
	return decoded.toString('base64') === value ? decoded : null
}

/**
 * A canonical RIFF/WAVE container: the size field agrees with the buffer
 * length, and walking its chunks (word-aligned, as RIFF requires) lands
 * exactly on the end of the buffer having seen both a `fmt ` and a `data`
 * chunk. Mirrors the WebP walker in `image-admission.ts`, which is the same
 * RIFF container format wearing a different fourCC.
 */
function isWav(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (
		bytes.length < 12 ||
		buffer.toString('ascii', 0, 4) !== 'RIFF' ||
		buffer.readUInt32LE(4) + 8 !== bytes.length ||
		buffer.toString('ascii', 8, 12) !== 'WAVE'
	) {
		return false
	}
	let offset = 12
	let sawFmt = false
	let sawData = false
	while (offset + 8 <= bytes.length) {
		const chunkId = buffer.toString('ascii', offset, offset + 4)
		const chunkSize = buffer.readUInt32LE(offset + 4)
		const dataStart = offset + 8
		const dataEnd = dataStart + chunkSize
		if (dataEnd < dataStart || dataEnd > bytes.length) return false
		if (chunkId === 'fmt ') {
			if (chunkSize < 16) return false
			sawFmt = true
		}
		if (chunkId === 'data') sawData = true
		// RIFF chunks are padded to an even byte count; the pad byte is not
		// counted in chunkSize but is present in the stream.
		offset = dataEnd + (chunkSize % 2)
	}
	return sawFmt && sawData && offset === bytes.length
}

/**
 * A sequence of Ogg pages, each framed by its `OggS` capture pattern and a
 * segment table whose declared sizes account for every byte of payload.
 * Page checksums are not verified — the framing itself, consumed exactly to
 * the end of the buffer, is what this admits or refuses.
 */
function isOgg(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let offset = 0
	let sawPage = false
	while (offset + 27 <= bytes.length) {
		if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') return false
		if (bytes[offset + 4] !== 0) return false // stream_structure_version
		const segmentCount = bytes[offset + 26] ?? 0
		const segmentTableStart = offset + 27
		if (segmentTableStart + segmentCount > bytes.length) return false
		let payloadLength = 0
		for (let i = 0; i < segmentCount; i += 1) {
			payloadLength += bytes[segmentTableStart + i] ?? 0
		}
		const payloadEnd = segmentTableStart + segmentCount + payloadLength
		if (payloadEnd > bytes.length) return false
		sawPage = true
		offset = payloadEnd
	}
	return sawPage && offset === bytes.length
}

// MPEG-1 Layer III bitrates in kbps, indexed by the header's 4-bit field.
// Index 0 (free bitrate) and 15 (reserved) are both treated as unsupported.
const MPEG1_L3_BITRATES: readonly number[] = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
]
const MPEG1_SAMPLE_RATES: readonly number[] = [44100, 48000, 32000, 0]

/** Frame length in bytes for an MPEG-1 Layer III frame, or null if the header is malformed/unsupported. */
function mp3FrameLength(headerByte1: number, headerByte2: number): number | null {
	const versionBits = (headerByte1 >> 3) & 0x3
	const layerBits = (headerByte1 >> 1) & 0x3
	if (versionBits !== 0x3 || layerBits !== 0x1) return null // MPEG-1, Layer III only
	const bitrateIndex = (headerByte2 >> 4) & 0xf
	const sampleRateIndex = (headerByte2 >> 2) & 0x3
	const padding = (headerByte2 >> 1) & 0x1
	if (bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 0x3) return null
	const bitrate = MPEG1_L3_BITRATES[bitrateIndex]
	const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex]
	if (!bitrate || !sampleRate) return null
	return Math.floor((144 * bitrate * 1000) / sampleRate) + padding
}

function id3v2TagLength(bytes: Uint8Array, buffer: Buffer): number {
	if (bytes.length < 10 || buffer.toString('ascii', 0, 3) !== 'ID3') return 0
	// Synchsafe integer: 7 significant bits per byte, big-endian.
	const size =
		((bytes[6] ?? 0) & 0x7f) * 0x200000 +
		((bytes[7] ?? 0) & 0x7f) * 0x4000 +
		((bytes[8] ?? 0) & 0x7f) * 0x80 +
		((bytes[9] ?? 0) & 0x7f)
	return 10 + size
}

/**
 * MPEG-1 Layer III frames, one after another with no trailing bytes: an
 * optional ID3v2 tag is skipped, then every remaining byte must belong to a
 * syntactically valid frame header whose declared length reaches exactly
 * the next frame (or the end of the buffer). Other MPEG versions and layers
 * are refused rather than approximated.
 */
function isMp3(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const offsetAfterTag = id3v2TagLength(bytes, buffer)
	if (offsetAfterTag + 4 > bytes.length) return false
	let offset = offsetAfterTag
	let sawFrame = false
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff || ((bytes[offset + 1] ?? 0) & 0xe0) !== 0xe0) return false
		const frameLength = mp3FrameLength(bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0)
		if (frameLength === null || frameLength < 4 || offset + frameLength > bytes.length) {
			return false
		}
		sawFrame = true
		offset += frameLength
	}
	return sawFrame && offset === bytes.length
}

function audioIsAdmitted(block: MCPAudioBlock): boolean {
	if (!isAudioMediaType(block.mimeType)) return false
	const bytes = decodeCanonicalBase64(block.data)
	if (!bytes) return false
	switch (block.mimeType) {
		case 'audio/wav':
			return isWav(bytes)
		case 'audio/ogg':
			return isOgg(bytes)
		case 'audio/mpeg':
			return isMp3(bytes)
	}
}

/**
 * Admit an MCP audio batch atomically before any member becomes model input.
 *
 * Mirrors `admitMcpImageBatch`: a remote server controls the declared MIME
 * and bytes, canonical base64 is only an encoding property, and the decoded
 * value must also be a complete, bounded container whose framing agrees
 * with the declared media type. One bad member withholds the complete batch
 * so a model is never shown a partial result while the host retains every
 * raw block for inspection.
 */
export function admitMcpAudioBatch(audios: readonly MCPAudioBlock[]): boolean {
	return audios.length === 0 || audios.every(audioIsAdmitted)
}
