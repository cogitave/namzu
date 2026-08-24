import { describe, expect, it } from 'vitest'

import type { MCPContentBlock } from '../../types/connector/index.js'

import { admitMcpImageBatch } from './image-admission.js'

type MCPImageBlock = Extract<MCPContentBlock, { type: 'image' }>

const RASTERS = [
	[
		'image/png',
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	],
	[
		'image/jpeg',
		'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
	],
	['image/gif', 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='],
	['image/webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAgA0JaQAA3AA/v89'],
] as const

function image(mimeType: string, data: string): MCPImageBlock {
	return { type: 'image', mimeType, data }
}

describe('admitMcpImageBatch', () => {
	it.each(RASTERS)('admits a bounded, complete %s container', (mimeType, data) => {
		expect(admitMcpImageBatch([image(mimeType, data)])).toBe(true)
	})

	it.each(RASTERS)('refuses a truncated %s container', (mimeType, data) => {
		const bytes = Buffer.from(data, 'base64')
		const truncated = bytes.subarray(0, Math.max(1, bytes.length - 4)).toString('base64')

		expect(admitMcpImageBatch([image(mimeType, truncated)])).toBe(false)
	})

	it('refuses canonical base64 that is not a raster container', () => {
		expect(
			admitMcpImageBatch([image('image/png', Buffer.from('not a png').toString('base64'))]),
		).toBe(false)
	})

	it('refuses a complete raster whose declared media type does not match', () => {
		expect(admitMcpImageBatch([image('image/jpeg', RASTERS[0][1])])).toBe(false)
	})

	it('refuses a WebP extended header that contains no raster payload', () => {
		const bytes = Buffer.alloc(30)
		bytes.write('RIFF', 0, 'ascii')
		bytes.writeUInt32LE(22, 4)
		bytes.write('WEBP', 8, 'ascii')
		bytes.write('VP8X', 12, 'ascii')
		bytes.writeUInt32LE(10, 16)

		expect(admitMcpImageBatch([image('image/webp', bytes.toString('base64'))])).toBe(false)
	})

	it('refuses non-canonical base64 and unsupported rich image media types', () => {
		expect(admitMcpImageBatch([image('image/png', `${RASTERS[0][1]}\n`)])).toBe(false)
		expect(admitMcpImageBatch([image('image/svg+xml', 'PHN2Zy8+')])).toBe(false)
	})

	it('admits the batch atomically so one invalid member withholds every image', () => {
		expect(
			admitMcpImageBatch([
				image(RASTERS[0][0], RASTERS[0][1]),
				image('image/png', Buffer.from('junk').toString('base64')),
			]),
		).toBe(false)
	})
})
