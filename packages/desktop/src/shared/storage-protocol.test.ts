import { describe, expect, it } from 'vitest'
import { formatBytes, isStoragePartId } from './storage-protocol.js'

describe('storage words', () => {
	it('writes sizes a person can read', () => {
		expect(formatBytes(0)).toBe('0 B')
		expect(formatBytes(-4)).toBe('0 B')
		expect(formatBytes(512)).toBe('512 B')
		expect(formatBytes(1536)).toBe('1.5 KB')
		expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
		expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB')
	})
	it('knows the six parts', () => {
		expect(isStoragePartId('logs')).toBe(true)
		expect(isStoragePartId('home')).toBe(false)
	})
})
