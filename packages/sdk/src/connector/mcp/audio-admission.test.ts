import { describe, expect, it } from 'vitest'

import type { MCPContentBlock } from '../../types/connector/index.js'

import { admitMcpAudioBatch } from './audio-admission.js'

type MCPAudioBlock = Extract<MCPContentBlock, { type: 'audio' }>

function audio(mimeType: string, data: string): MCPAudioBlock {
	return { type: 'audio', mimeType, data }
}

/** A canonical, minimal PCM WAV: RIFF/WAVE with one `fmt ` and one `data` chunk. */
function wav(pcmByteLength = 4): string {
	const fmtChunk = Buffer.alloc(16)
	fmtChunk.writeUInt16LE(1, 0) // PCM
	fmtChunk.writeUInt16LE(1, 2) // mono
	fmtChunk.writeUInt32LE(8000, 4) // sample rate
	fmtChunk.writeUInt32LE(8000, 8) // byte rate
	fmtChunk.writeUInt16LE(1, 12) // block align
	fmtChunk.writeUInt16LE(8, 14) // bits per sample
	const dataChunk = Buffer.alloc(pcmByteLength)
	const riffSize = 4 + (8 + fmtChunk.length) + (8 + dataChunk.length)
	const riffHeader = Buffer.alloc(8)
	riffHeader.write('RIFF', 0, 'ascii')
	riffHeader.writeUInt32LE(riffSize, 4)
	const fmtHeader = Buffer.alloc(8)
	fmtHeader.write('fmt ', 0, 'ascii')
	fmtHeader.writeUInt32LE(fmtChunk.length, 4)
	const dataHeader = Buffer.alloc(8)
	dataHeader.write('data', 0, 'ascii')
	dataHeader.writeUInt32LE(dataChunk.length, 4)
	return Buffer.concat([
		riffHeader,
		Buffer.from('WAVE', 'ascii'),
		fmtHeader,
		fmtChunk,
		dataHeader,
		dataChunk,
	]).toString('base64')
}

/** A single canonical Ogg page whose segment table exactly accounts for its payload. */
function oggPage(payload: Buffer): string {
	if (payload.length > 255) throw new Error('test fixture only supports a single segment')
	const header = Buffer.alloc(27)
	header.write('OggS', 0, 'ascii')
	header[4] = 0 // stream_structure_version
	header[5] = 0x06 // header_type: beginning + end of stream
	header[26] = 1 // number_page_segments
	const segmentTable = Buffer.from([payload.length])
	return Buffer.concat([header, segmentTable, payload]).toString('base64')
}

/** One MPEG-1 Layer III frame at 128kbps/44100Hz, padded with silence to its exact length. */
function mp3Frame(): string {
	const frameLength = Math.floor((144 * 128 * 1000) / 44100) // 418
	const frame = Buffer.alloc(frameLength)
	frame[0] = 0xff
	frame[1] = 0xfb // MPEG-1, Layer III, no CRC
	frame[2] = 0x90 // 128kbps, 44100Hz, no padding
	return frame.toString('base64')
}

const CONTAINERS = [
	['audio/wav', wav()],
	['audio/ogg', oggPage(Buffer.from('a fake but complete ogg payload'))],
	['audio/mpeg', mp3Frame()],
] as const

describe('admitMcpAudioBatch', () => {
	it.each(CONTAINERS)('admits a bounded, complete %s container', (mimeType, data) => {
		expect(admitMcpAudioBatch([audio(mimeType, data)])).toBe(true)
	})

	it.each(CONTAINERS)('refuses a truncated %s container', (mimeType, data) => {
		const bytes = Buffer.from(data, 'base64')
		const truncated = bytes.subarray(0, Math.max(1, bytes.length - 4)).toString('base64')

		expect(admitMcpAudioBatch([audio(mimeType, truncated)])).toBe(false)
	})

	it('refuses canonical base64 that is not an audio container', () => {
		expect(
			admitMcpAudioBatch([audio('audio/wav', Buffer.from('not a wav').toString('base64'))]),
		).toBe(false)
	})

	it('refuses a complete container whose declared media type does not match', () => {
		expect(admitMcpAudioBatch([audio('audio/ogg', wav())])).toBe(false)
	})

	it('refuses an unrecognized (but structurally plausible) audio media type', () => {
		expect(admitMcpAudioBatch([audio('audio/flac', wav())])).toBe(false)
	})

	it('refuses non-canonical base64', () => {
		expect(admitMcpAudioBatch([audio('audio/wav', `${wav()}\n`)])).toBe(false)
	})

	it('refuses a WAV missing its data chunk', () => {
		const fmtOnly = Buffer.alloc(28)
		fmtOnly.write('RIFF', 0, 'ascii')
		fmtOnly.writeUInt32LE(20, 4)
		fmtOnly.write('WAVE', 8, 'ascii')
		fmtOnly.write('fmt ', 12, 'ascii')
		fmtOnly.writeUInt32LE(16, 16)
		// 16 bytes of fmt payload follow, all zero, no data chunk after.
		expect(admitMcpAudioBatch([audio('audio/wav', fmtOnly.toString('base64'))])).toBe(false)
	})

	it('refuses an Ogg page whose segment table overruns the buffer', () => {
		const header = Buffer.alloc(27)
		header.write('OggS', 0, 'ascii')
		header[26] = 1
		const segmentTable = Buffer.from([250]) // claims 250 bytes of payload that do not exist
		const truncatedPage = Buffer.concat([header, segmentTable])
		expect(admitMcpAudioBatch([audio('audio/ogg', truncatedPage.toString('base64'))])).toBe(false)
	})

	it('refuses an MP3 frame header naming a reserved/unsupported version or layer', () => {
		const frame = Buffer.from(mp3Frame(), 'base64')
		frame[1] = 0xf0 // MPEG-1 reserved layer (00)
		expect(admitMcpAudioBatch([audio('audio/mpeg', frame.toString('base64'))])).toBe(false)
	})

	it('admits the batch atomically so one invalid member withholds every clip', () => {
		expect(
			admitMcpAudioBatch([
				audio('audio/wav', wav()),
				audio('audio/wav', Buffer.from('junk').toString('base64')),
			]),
		).toBe(false)
	})

	it('admits an empty batch', () => {
		expect(admitMcpAudioBatch([])).toBe(true)
	})
})
