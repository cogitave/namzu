import { describe, expect, it, vi } from 'vitest'
import {
	LocalSpeechPlayback,
	type SpeechAudioContext,
	type SpeechAudioSource,
	decodeSpeechPcm,
} from './local-speech-playback.js'

function audioContext(resume: () => Promise<void> = async () => {}) {
	const sources: SpeechAudioSource[] = []
	const samples: Float32Array[] = []
	const context: SpeechAudioContext = {
		currentTime: 0,
		destination: {},
		state: 'running',
		resume,
		close: vi.fn(async () => {
			context.state = 'closed'
		}),
		createBuffer: vi.fn(() => ({
			copyToChannel(value: Float32Array) {
				samples.push(value.slice())
			},
		})),
		createBufferSource: () => {
			const source: SpeechAudioSource = {
				buffer: null,
				onended: null,
				connect: vi.fn(),
				disconnect: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			}
			sources.push(source)
			return source
		},
	}
	return { context, sources, samples }
}

describe('local speech streaming playback', () => {
	it('plays frames consecutively and acknowledges only when each one finishes', async () => {
		const audio = audioContext()
		const drained = vi.fn()
		const played = vi.fn()
		const playback = new LocalSpeechPlayback(() => audio.context, drained)
		await playback.open()
		playback.append(new Float32Array(4_800), 24_000, () => played(0))
		playback.append(new Float32Array(4_800), 24_000, () => played(1))
		expect(audio.sources[0]?.start).toHaveBeenCalledWith(0.03)
		expect(audio.sources[1]?.start).toHaveBeenCalledWith(0.23)
		expect(played).not.toHaveBeenCalled()
		playback.finish()
		expect(drained).not.toHaveBeenCalled()
		audio.sources[0]?.onended?.(new Event('ended'))
		expect(played.mock.calls).toEqual([[0]])
		expect(drained).not.toHaveBeenCalled()
		audio.sources[1]?.onended?.(new Event('ended'))
		expect(played.mock.calls).toEqual([[0], [1]])
		expect(drained).toHaveBeenCalledOnce()
		expect(audio.context.close).toHaveBeenCalledOnce()
	})

	it('stops playing and queued frames on owner change without stale acknowledgements', async () => {
		const audio = audioContext()
		const played = vi.fn()
		const drained = vi.fn()
		const playback = new LocalSpeechPlayback(() => audio.context, drained)
		await playback.open()
		playback.append(new Float32Array(4_800), 24_000, played)
		playback.append(new Float32Array(4_800), 24_000, played)
		const lateCallback = audio.sources[0]?.onended
		playback.stop()
		lateCallback?.(new Event('ended'))
		for (const source of audio.sources) {
			expect(source.stop).toHaveBeenCalledOnce()
			expect(source.onended).toBeNull()
		}
		expect(played).not.toHaveBeenCalled()
		expect(drained).not.toHaveBeenCalled()
		expect(() => playback.append(new Float32Array([0]), 24_000)).toThrow('not active')
	})

	it('does not revive a playback context whose resume settled after cancellation', async () => {
		let release: (() => void) | undefined
		const audio = audioContext(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const playback = new LocalSpeechPlayback(() => audio.context)
		const opening = playback.open()
		playback.stop()
		release?.()
		await expect(opening).rejects.toThrow('stopped')
		expect(audio.context.close).toHaveBeenCalledOnce()
	})

	it('refuses non-finite frames and an unbounded PCM queue', async () => {
		const audio = audioContext()
		const playback = new LocalSpeechPlayback(() => audio.context)
		await playback.open()
		expect(() => playback.append(new Float32Array([Number.NaN]), 24_000)).toThrow('invalid')
		expect(() => playback.append(new Float32Array([2]), 24_000)).toThrow('invalid')
		expect(() => playback.append(new Float32Array([0]), 100)).toThrow('invalid')
		playback.append(new Float32Array(24_000 * 10), 24_000)
		playback.append(new Float32Array(24_000 * 10), 24_000)
		expect(() => playback.append(new Float32Array(24_000 * 10), 24_000)).toThrow('faster')
		playback.stop()
	})

	it('decodes signed 16-bit little-endian PCM and refuses incomplete samples', () => {
		expect([...decodeSpeechPcm('AIAAAP9/')]).toEqual([-1, 0, 32_767 / 32_768])
		expect(() => decodeSpeechPcm('AA==')).toThrow('invalid')
		expect(() => decodeSpeechPcm('not base64')).toThrow('invalid')
	})
})
