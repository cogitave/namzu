import { describe, expect, it, vi } from 'vitest'
import {
	CAPTURE_CONSTRAINTS,
	type CaptureEnvironment,
	CaptureError,
	type CaptureNode,
	type CaptureTrack,
	VoiceCapture,
	captureMessage,
} from './voice-capture.js'

function sineBlock(rate: number, length = rate / 10): Float32Array {
	return Float32Array.from(
		{ length },
		(_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / rate),
	)
}

function fakeEnvironment(
	options: { rate?: number; microphone?: 'ok' | 'denied' | 'missing' | 'busy' } = {},
) {
	const track: CaptureTrack = { stop: vi.fn(), onended: null }
	const worklet = {
		port: { onmessage: null, close: vi.fn() },
		connect: vi.fn(),
		disconnect: vi.fn(),
	} as unknown as CaptureNode & {
		port: { onmessage: ((event: { data: Float32Array }) => void) | null }
	}
	const node = (): CaptureNode => ({
		port: { onmessage: null, close: vi.fn() },
		connect: vi.fn(),
		disconnect: vi.fn(),
	})
	const context = {
		sampleRate: options.rate ?? 48_000,
		destination: {},
		audioWorklet: { addModule: vi.fn(async () => undefined) },
		createMediaStreamSource: vi.fn(() => node()),
		createGain: vi.fn(() => Object.assign(node(), { gain: { value: 1 } })),
		resume: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	}
	const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
		const names: Record<string, string | undefined> = {
			denied: 'NotAllowedError',
			missing: 'NotFoundError',
			busy: 'NotReadableError',
		}
		const failure = names[options.microphone ?? 'ok']
		if (failure) throw Object.assign(new Error(failure), { name: failure })
		return { getTracks: () => [track] }
	})
	const environment: CaptureEnvironment = {
		getUserMedia,
		createContext: () => context,
		createWorkletNode: () => worklet,
		workletUrl: 'file:///app/renderer/voice-capture-worklet.js',
	}
	return { environment, context, worklet, track, getUserMedia }
}

describe('VoiceCapture', () => {
	it('asks for echo cancellation, noise suppression, gain control and one channel', async () => {
		const { environment, getUserMedia } = fakeEnvironment()
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		await capture.start()
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
		})
		expect(CAPTURE_CONSTRAINTS.audio).toMatchObject({ channelCount: 1 })
		// Audio only: never a camera.
		expect(JSON.stringify(getUserMedia.mock.calls[0])).not.toContain('video')
		capture.stop()
	})

	it('loads the processor from the module file it was given, and mutes the graph’s output', async () => {
		const { environment, context } = fakeEnvironment()
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		await capture.start()
		expect(context.audioWorklet.addModule).toHaveBeenCalledWith(
			'file:///app/renderer/voice-capture-worklet.js',
		)
		const mute = context.createGain.mock.results[0]?.value as { gain: { value: number } }
		expect(mute.gain.value).toBe(0)
		capture.stop()
	})

	it('delivers 16 kHz audio in pieces of about 100 ms', async () => {
		const { environment, worklet } = fakeEnvironment({ rate: 48_000 })
		const chunks: Float32Array[] = []
		const capture = new VoiceCapture(
			environment,
			(samples) => chunks.push(samples),
			() => {},
		)
		await capture.start()
		// One second of microphone audio in 20 ms blocks.
		for (let index = 0; index < 50; index++)
			worklet.port.onmessage?.({ data: sineBlock(48_000, 960) })
		expect(chunks.length).toBeGreaterThanOrEqual(9)
		expect(chunks.length).toBeLessThanOrEqual(10)
		for (const chunk of chunks) {
			expect(chunk.length).toBe(1600)
			expect(Math.max(...chunk)).toBeLessThanOrEqual(1)
		}
		capture.stop()
	})

	it('stops the tracks, closes the context and goes quiet when stopped', async () => {
		const { environment, context, track, worklet } = fakeEnvironment()
		const chunks: Float32Array[] = []
		const capture = new VoiceCapture(
			environment,
			(samples) => chunks.push(samples),
			() => {},
		)
		await capture.start()
		capture.stop()
		expect(track.stop).toHaveBeenCalled()
		expect(context.close).toHaveBeenCalled()
		expect(worklet.port.onmessage).toBeNull()
		expect(chunks).toEqual([])
	})

	it('stopping twice is harmless', async () => {
		const { environment, track } = fakeEnvironment()
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		await capture.start()
		capture.stop()
		capture.stop()
		expect(track.stop).toHaveBeenCalledTimes(1)
	})

	it('reports the microphone being unplugged and releases everything', async () => {
		const { environment, track, context } = fakeEnvironment()
		const failures: CaptureError[] = []
		const capture = new VoiceCapture(
			environment,
			() => {},
			(error) => failures.push(error),
		)
		await capture.start()
		track.onended?.({})
		expect(failures.map((error) => error.kind)).toEqual(['missing'])
		expect(context.close).toHaveBeenCalled()
	})

	it.each([
		['denied', 'denied'],
		['missing', 'missing'],
		['busy', 'busy'],
	] as const)('turns a %s microphone into a plain sentence', async (microphone, kind) => {
		const { environment } = fakeEnvironment({ microphone })
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		const failure = await capture.start().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(CaptureError)
		expect((failure as CaptureError).kind).toBe(kind)
		expect((failure as CaptureError).message).toBe(captureMessage(kind))
		expect((failure as CaptureError).message).not.toMatch(/Error|NotAllowed|NotFound|NotReadable/)
	})

	it('releases the microphone if it was stopped while it was still opening', async () => {
		const { environment, track, getUserMedia } = fakeEnvironment()
		let release: (() => void) | undefined
		getUserMedia.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ getTracks: () => [track] })
				}),
		)
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		const started = capture.start()
		capture.stop()
		release?.()
		await started
		expect(track.stop).toHaveBeenCalled()
	})

	it('refuses a microphone too slow for speech with a sentence, not a crash', async () => {
		const { environment } = fakeEnvironment({ rate: 8000 })
		const capture = new VoiceCapture(
			environment,
			() => {},
			() => {},
		)
		const failure = await capture.start().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(CaptureError)
		expect((failure as CaptureError).message).toBe(captureMessage('unavailable'))
	})
})
