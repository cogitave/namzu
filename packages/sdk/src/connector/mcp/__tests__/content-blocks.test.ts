import { describe, expect, it } from 'vitest'

import { mcpToolResultToToolResult } from '../adapter.js'

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

/** A canonical, minimal PCM WAV — see `audio-admission.test.ts` for the format notes. */
function wav(pcmByteLength = 4): string {
	const fmtChunk = Buffer.alloc(16)
	fmtChunk.writeUInt16LE(1, 0)
	fmtChunk.writeUInt16LE(1, 2)
	fmtChunk.writeUInt32LE(8000, 4)
	fmtChunk.writeUInt32LE(8000, 8)
	fmtChunk.writeUInt16LE(1, 12)
	fmtChunk.writeUInt16LE(8, 14)
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

describe('audio content blocks', () => {
	it('reaches the model with its media type', () => {
		const result = mcpToolResultToToolResult({
			content: [{ type: 'audio', data: wav(), mimeType: 'audio/wav' }],
			isError: false,
		})
		expect(result.output).toContain('audio/wav')
	})

	it('is withheld with a notice when malformed', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'audio', data: Buffer.from('not audio').toString('base64'), mimeType: 'audio/wav' },
			],
			isError: false,
		})
		expect(result.output).toContain('audio batch withheld')
	})

	it('withholds the whole audio batch atomically, same as images', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'audio', data: wav(), mimeType: 'audio/wav' },
				{ type: 'audio', data: Buffer.from('junk').toString('base64'), mimeType: 'audio/wav' },
			],
			isError: false,
		})
		expect(result.output).toContain('audio batch withheld')
		expect(result.output).not.toContain('audio/wav]')
	})
})

describe('resource_link content blocks', () => {
	it('is named as a pointer, never as fabricated content', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{
					type: 'resource_link',
					uri: 'file:///reports/q3.pdf',
					name: 'q3-report',
					description: 'Quarterly report',
					mimeType: 'application/pdf',
				},
			],
			isError: false,
		})
		expect(result.content).toEqual([
			{ type: 'text', text: '[MCP resource link: q3-report (file:///reports/q3.pdf)]' },
		])
	})
})

describe('embedded resource content blocks', () => {
	it('handles a blob with no text without throwing, and without pretending to be readable text', () => {
		const blob = Buffer.from([0, 1, 2, 3]).toString('base64')
		expect(() =>
			mcpToolResultToToolResult({
				content: [
					{
						type: 'resource',
						resource: { uri: 'file:///photo.png', mimeType: 'image/png', blob },
					},
				],
				isError: false,
			}),
		).not.toThrow()

		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'resource', resource: { uri: 'file:///photo.png', mimeType: 'image/png', blob } },
			],
			isError: false,
		})
		expect(result.output).toBe('')
		expect(result.content).toBeUndefined()
		expect(result.output).not.toContain(blob)
	})

	it('carries annotations into ToolResult.data untouched', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{
					type: 'resource',
					resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'notes' },
					annotations: { audience: ['assistant'], priority: 0.5, lastModified: '2026-09-01' },
				},
			],
			isError: false,
		})
		expect(result.data).toEqual([
			{
				type: 'resource',
				resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'notes' },
				annotations: { audience: ['assistant'], priority: 0.5, lastModified: '2026-09-01' },
			},
		])
	})
})

describe('a result mixing content-block types', () => {
	it('renders text, image, audio and resource_link all at once', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'text', text: 'here is what I found' },
				{ type: 'image', data: PNG, mimeType: 'image/png' },
				{ type: 'audio', data: wav(), mimeType: 'audio/wav' },
				{
					type: 'resource_link',
					uri: 'file:///report.pdf',
					name: 'report',
				},
			],
			isError: false,
		})

		// Plain text and the audio notice both land in `output`.
		expect(result.output).toContain('here is what I found')
		expect(result.output).toContain('audio/wav')

		// The image and the resource_link pointer both land in `content`.
		expect(result.content).toEqual(
			expect.arrayContaining([
				{ type: 'text', text: 'here is what I found' },
				expect.objectContaining({ type: 'image', mediaType: 'image/png' }),
				{ type: 'text', text: '[MCP resource link: report (file:///report.pdf)]' },
			]),
		)
	})
})
