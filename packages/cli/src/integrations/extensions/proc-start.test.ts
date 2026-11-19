import { describe, expect, it } from 'vitest'
import { createStartTokens } from './proc-start.js'

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('the start time of a process, kept per pid', () => {
	it('is read once for a pid however many callers ask, and later asks hit the cache', async () => {
		let reads = 0
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			readAsync: async () => {
				reads++
				return 'T1'
			},
		})
		expect(t.peek(41)).toBeUndefined()
		expect(t.peek(41)).toBeUndefined()
		await flush()
		expect(t.peek(41)).toBe('T1')
		expect(t.peek(41)).toBe('T1')
		expect(reads).toBe(1)
	})

	it('never runs the blocking read from peek where reading blocks', () => {
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			read: () => {
				throw new Error('blocked')
			},
			readAsync: () => new Promise(() => {}),
		})
		expect(t.peek(7)).toBeUndefined()
	})

	it('forgets a pid whose process is gone, so a reused pid is read again', async () => {
		let up = true
		let reads = 0
		const t = createStartTokens({
			slow: true,
			alive: () => up,
			readAsync: async () => `T${++reads}`,
		})
		t.peek(9)
		await flush()
		expect(t.peek(9)).toBe('T1')
		up = false
		expect(t.peek(9)).toBeUndefined()
		expect(t.size).toBe(0)
		up = true
		await flush()
		expect(t.peek(9)).toBe('T2')
	})

	it('does not keep a token for a process that is not alive when the probe answers', async () => {
		const t = createStartTokens({ slow: true, alive: () => false, readAsync: async () => 'x' })
		t.peek(5)
		await flush()
		expect(t.size).toBe(0)
	})

	it('reads in line where reading is cheap, and keeps the answer', () => {
		let reads = 0
		const t = createStartTokens({
			slow: false,
			alive: () => true,
			read: () => `L${++reads}`,
		})
		expect(t.peek(3)).toBe('L1')
		expect(t.peek(3)).toBe('L1')
		expect(t.strict(3)).toBe('L1')
		expect(reads).toBe(1)
	})

	it('strict reads now, and keeps it for the next asker', () => {
		let reads = 0
		const t = createStartTokens({ slow: true, alive: () => true, read: () => `S${++reads}` })
		expect(t.strict(2)).toBe('S1')
		expect(t.peek(2)).toBe('S1')
		expect(reads).toBe(1)
	})

	it('tells the caller when a probe it started has answered', async () => {
		const seen: [number, string][] = []
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			readAsync: async () => 'Z',
			onResolved: (pid, token) => seen.push([pid, token]),
		})
		t.peek(11)
		await flush()
		expect(seen).toEqual([[11, 'Z']])
	})
})
