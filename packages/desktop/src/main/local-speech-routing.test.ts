import { expect, it, vi } from 'vitest'
import {
	DEFAULT_LOCAL_SPEECH_SETTINGS,
	LOCAL_SPEECH_PREVIEW_TEXT,
	type LocalSpeechEvent,
	type LocalSpeechState,
} from '../shared/local-speech-protocol.js'
import { LocalSpeechRouting } from './local-speech-routing.js'

function fixture() {
	let owned = true
	let resolveState: ((value: LocalSpeechState) => void) | undefined
	const state = {
		settings: { ...DEFAULT_LOCAL_SPEECH_SETTINGS, enabled: true },
	} as LocalSpeechState
	const engine = {
		state: vi.fn(async () => state),
		speak: vi.fn(async (input: { requestId: string; text: string }) => ({
			requestId: input.requestId,
		})),
		cancel: vi.fn(),
		acknowledge: vi.fn(),
	}
	const deliver = vi.fn()
	const route = new LocalSpeechRouting(engine, {
		assertOwner(window, session) {
			if (window !== 'original' || (session !== undefined && (session !== 'chat' || !owned)))
				throw new Error('Foreign owner')
		},
		deliver,
	})
	return {
		engine,
		route,
		deliver,
		state,
		move: () => {
			owned = false
		},
		delayState: () => {
			engine.state.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveState = resolve
					}),
			)
			return () => resolveState?.(state)
		},
	}
}
const input = { requestId: 'voice', sessionId: 'chat', text: 'Merhaba.', language: 'tr' as const }
const audio: LocalSpeechEvent = {
	type: 'audio',
	requestId: 'voice',
	sequence: 0,
	sampleRate: 24000,
	format: 'pcm_s16le',
	channels: 1,
	pcmBase64: 'AAA=',
}

it('uses fixed preview text and enforces Turkish and the requesting conversation', async () => {
	const f = fixture()
	await f.route.speak('original', {
		...input,
		sessionId: undefined,
		text: 'Untrusted arbitrary preview',
	})
	expect(f.engine.speak).toHaveBeenCalledWith({
		requestId: 'voice',
		text: LOCAL_SPEECH_PREVIEW_TEXT,
		preview: true,
	})
	f.route.cancel('original', 'voice')
	await expect(f.route.speak('foreign', input)).rejects.toThrow('Foreign')
	await expect(f.route.speak('original', { ...input, sessionId: 'foreign' })).rejects.toThrow(
		'Foreign',
	)
	await expect(f.route.speak('original', { ...input, language: 'en' })).rejects.toThrow('Turkish')
})

it('rechecks ownership after the asynchronous state read before starting CPU work', async () => {
	const f = fixture()
	const settle = f.delayState()
	const requested = f.route.speak('original', input)
	f.move()
	settle()
	await expect(requested).rejects.toThrow('Foreign')
	expect(f.engine.speak).not.toHaveBeenCalled()
})

it('routes only the requester audio, rejects foreign ACKs/cancellation and fences transfer frames', async () => {
	const f = fixture()
	await f.route.speak('original', input)
	f.route.event(audio)
	expect(f.deliver).toHaveBeenCalledWith('original', audio)
	expect(() => f.route.acknowledge('foreign', 'voice', 0)).toThrow('another window')
	expect(() => f.route.cancel('foreign', 'voice')).toThrow('another window')
	expect(() => f.route.acknowledge('original', 'voice', -1)).toThrow('acknowledgement')
	f.route.acknowledge('original', 'voice', 0)
	expect(f.engine.acknowledge).toHaveBeenCalledWith('voice', 0)
	f.move()
	f.route.event({ ...audio, sequence: 1 })
	expect(f.engine.cancel).toHaveBeenCalledWith('voice')
	expect(f.deliver).toHaveBeenCalledTimes(1)
})

it('permits original requester cleanup after a transfer and forgets ended requests', async () => {
	const f = fixture()
	await f.route.speak('original', input)
	f.move()
	f.route.cancel('original', 'voice')
	f.route.event(audio)
	expect(f.deliver).not.toHaveBeenCalled()
	expect(f.engine.cancel).toHaveBeenCalledOnce()
})

it('refuses duplicate request IDs and voice-disabled conversation playback', async () => {
	const f = fixture()
	await f.route.speak('original', input)
	await expect(f.route.speak('original', input)).rejects.toThrow('in use')
	f.route.event({ type: 'end', requestId: 'voice', reason: 'completed' })
	f.route.event(audio)
	expect(f.deliver).toHaveBeenCalledTimes(1)
	f.state.settings.enabled = false
	await expect(f.route.speak('original', input)).rejects.toThrow('Enable voice')
})
