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

	it('reads in line each time where reading is cheap, so a reused pid is seen at once', () => {
		let reads = 0
		const t = createStartTokens({
			slow: false,
			alive: () => true,
			read: () => `L${++reads}`,
		})
		expect(t.peek(3)).toBe('L1')
		expect(t.peek(3)).toBe('L2')
		expect(t.strict(3)).toBe('L3')
		expect(reads).toBe(3)
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

describe('start times that are kept, and when they are not', () => {
	it('reads a pid again after the verify window, so a reused pid is not judged by the old time', async () => {
		let clock = 0
		let token = 'T1'
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			now: () => clock,
			readAsync: async () => token,
		})
		t.peek(4000)
		await t.settled()
		expect(t.peek(4000)).toBe('T1')
		token = 'T2'
		clock = 31_000
		expect(t.peek(4000)).toBe('T1')
		await t.settled()
		expect(t.peek(4000)).toBe('T2')
	})

	it('never keeps an empty answer as a start time, and does not probe again at once', async () => {
		let clock = 0
		let reads = 0
		let answer = ''
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			now: () => clock,
			readAsync: async () => {
				reads++
				return answer
			},
		})
		expect(t.peek(9)).toBeUndefined()
		await t.settled()
		expect(t.peek(9)).toBe('')
		expect(t.peek(9)).toBe('')
		expect(reads).toBe(1)
		expect(t.size).toBe(0)
		answer = 'T9'
		clock = 11_000
		expect(t.peek(9)).toBeUndefined()
		await t.settled()
		expect(t.peek(9)).toBe('T9')
	})

	it('does not keep an empty blocking read either', () => {
		let v = ''
		const t = createStartTokens({ slow: true, alive: () => true, read: () => v })
		expect(t.strict(5)).toBe('')
		v = 'T5'
		expect(t.strict(5)).toBe('T5')
	})

	it('settled() waits for the probes a peek started', async () => {
		let release: (v: string) => void = () => {}
		const t = createStartTokens({
			slow: true,
			alive: () => true,
			readAsync: () =>
				new Promise<string>((r) => {
					release = r
				}),
		})
		t.peek(3)
		let done = false
		const w = t.settled().then(() => {
			done = true
		})
		await Promise.resolve()
		expect(done).toBe(false)
		release('T3')
		await w
		expect(t.peek(3)).toBe('T3')
	})

	it('blocks on a read only where it is cheap: every platform but linux counts as slow', () => {
		let reads = 0
		const t = createStartTokens({ alive: () => true, read: () => `r${++reads}` })
		if (process.platform === 'linux') {
			expect(t.peek(2)).toBe('r1')
			expect(t.peek(2)).toBe('r2') // a reused pid is seen at once
		} else {
			expect(t.peek(2)).toBeUndefined()
		}
	})
})
