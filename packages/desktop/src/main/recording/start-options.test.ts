import { describe, expect, it } from 'vitest'
import { readRecordingStart } from './start-options.js'

describe('what the window may ask the recorder', () => {
	it('reads a provider, microphones and a chosen microphone', () => {
		expect(
			readRecordingStart({
				provider: ' DeepSeek V4 Flash ',
				microphones: [{ id: 'a', label: 'Headset' }],
				microphone: 'a',
			}),
		).toEqual({
			provider: 'DeepSeek V4 Flash',
			microphones: [{ id: 'a', label: 'Headset' }],
			microphone: 'a',
		})
	})

	it('turns control characters in the provider into spaces', () => {
		expect(readRecordingStart({ provider: 'A\u0007B\nC' }).provider).toBe('A B C')
	})

	it.each([
		null,
		[],
		{},
		{ provider: '' },
		{ provider: 3 },
		{ provider: 'x'.repeat(201) },
		{ provider: 'x', microphones: 'no' },
		{ provider: 'x', microphones: Array.from({ length: 21 }, () => ({ id: 'a', label: 'b' })) },
		{ provider: 'x', microphones: [{ id: 1, label: 'b' }] },
		{ provider: 'x', microphone: 4 },
	])('refuses %j', (input) => {
		expect(() => readRecordingStart(input)).toThrow('Invalid recording request.')
	})
})
