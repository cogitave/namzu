import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { DEFAULT_DESKTOP_SETTINGS } from '../shared/settings-protocol.js'
import type { VoiceInputEvent } from '../shared/voice-input-protocol.js'
import {
	BargeIn,
	ENDED_NOTICES,
	HELD_NOTICE,
	NOT_SENT_NOTICE,
	VoiceInputController,
	type VoiceInputRendererApi,
	canReadAloud,
	replyJustFinished,
	spokenReplyTarget,
} from './use-voice-input.js'
import type { CaptureEnvironment, CaptureNode, CaptureTrack } from './voice-capture.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function setup(options: { accepted?: boolean; microphone?: 'ok' | 'denied' } = {}) {
	const listeners = new Set<(event: VoiceInputEvent) => void>()
	const settingsListeners = new Set<(event: never) => void>()
	const track: CaptureTrack = { stop: vi.fn(), onended: null }
	const worklet = {
		port: { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn() },
		connect: vi.fn(),
		disconnect: vi.fn(),
	}
	const node = (): CaptureNode => ({
		port: { onmessage: null, close: vi.fn() },
		connect: vi.fn(),
		disconnect: vi.fn(),
	})
	const context = {
		sampleRate: 16_000,
		destination: {},
		audioWorklet: { addModule: vi.fn(async () => undefined) },
		createMediaStreamSource: vi.fn(() => node()),
		createGain: vi.fn(() => Object.assign(node(), { gain: { value: 1 } })),
		resume: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	}
	const environment: CaptureEnvironment = {
		getUserMedia: vi.fn(async () => {
			if (options.microphone === 'denied')
				throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
			return { getTracks: () => [track] }
		}),
		createContext: () => context,
		createWorkletNode: () => worklet as unknown as CaptureNode,
		workletUrl: 'file:///voice-capture-worklet.js',
	}
	const api = {
		voiceInputStart: vi.fn(async (_sessionId: string) => undefined),
		voiceInputAudio: vi.fn(async (_sessionId: string, _samples: Float32Array) => undefined),
		voiceInputStop: vi.fn(async () => undefined),
		onVoiceInputEvent: vi.fn((listener: (event: VoiceInputEvent) => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}),
		settings: vi.fn(async () => ({
			...DEFAULT_DESKTOP_SETTINGS,
			voiceInputAccepted: options.accepted ?? true,
		})),
		setSettings: vi.fn(async (patch: object) => ({
			settings: { ...DEFAULT_DESKTOP_SETTINGS, ...patch },
		})),
		onEvent: vi.fn((listener: (event: never) => void) => {
			settingsListeners.add(listener)
			return () => settingsListeners.delete(listener)
		}),
	} satisfies VoiceInputRendererApi
	const sent: string[] = []
	const stopped: string[] = []
	const controller = new VoiceInputController(
		api as unknown as VoiceInputRendererApi,
		{ sent: (id) => sent.push(id), replyStopped: (id) => stopped.push(id) },
		() => environment,
	)
	const disconnect = controller.connect()
	const emit = (event: VoiceInputEvent) => {
		for (const listener of [...listeners]) listener(event)
	}
	/** Lets pending promises settle. */
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
	return {
		controller,
		api,
		emit,
		track,
		worklet,
		context,
		sent,
		stopped,
		disconnect,
		settle,
		environment,
	}
}

afterEach(() => vi.useRealTimers())

describe('pressing the microphone', () => {
	it('does nothing without a conversation', async () => {
		const { controller, api, settle } = setup()
		await settle()
		controller.toggle()
		expect(controller.getSnapshot().phase).toBe('off')
		expect(api.voiceInputStart).not.toHaveBeenCalled()
	})

	it('asks first, once: nothing is opened before the person agrees', async () => {
		const { controller, api, settle, environment } = setup({ accepted: false })
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		expect(controller.getSnapshot()).toMatchObject({
			consentOpen: true,
			phase: 'off',
			accepted: false,
		})
		expect(api.voiceInputStart).not.toHaveBeenCalled()
		expect(environment.getUserMedia).not.toHaveBeenCalled()
		controller.declineConsent()
		expect(controller.getSnapshot().consentOpen).toBe(false)
		expect(api.setSettings).not.toHaveBeenCalled()
	})

	it('saves the agreement, then starts listening', async () => {
		const { controller, api, settle, environment } = setup({ accepted: false })
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await controller.acceptConsent()
		expect(api.setSettings).toHaveBeenCalledWith({ voiceInputAccepted: true })
		expect(api.voiceInputStart).toHaveBeenCalledWith('s1')
		expect(environment.getUserMedia).toHaveBeenCalledOnce()
		expect(controller.getSnapshot()).toMatchObject({ phase: 'listening', accepted: true })
		// Main's side is opened before the microphone, so the first words are never lost.
		expect(api.voiceInputStart.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(environment.getUserMedia).mock.invocationCallOrder[0] as number,
		)
	})

	it('does not ask again once agreed', async () => {
		const { controller, api, settle } = setup({ accepted: true })
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		expect(controller.getSnapshot()).toMatchObject({ consentOpen: false, phase: 'listening' })
		expect(api.voiceInputStart).toHaveBeenCalledWith('s1')
	})

	it('sends each 100 ms chunk to main for this conversation', async () => {
		const { controller, api, settle, worklet } = setup()
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		// The filter holds back a few milliseconds, so the first full piece needs a little more.
		worklet.port.onmessage?.({ data: new Float32Array(1600).fill(0.1) })
		worklet.port.onmessage?.({ data: new Float32Array(1600).fill(0.1) })
		expect(api.voiceInputAudio).toHaveBeenCalledTimes(1)
		expect(api.voiceInputAudio.mock.calls[0]?.[0]).toBe('s1')
		expect(api.voiceInputAudio.mock.calls[0]?.[1]).toHaveLength(1600)
	})

	it('turns off from the same button, closing the microphone and main’s side', async () => {
		const { controller, api, settle, track, context } = setup()
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		controller.toggle()
		expect(controller.getSnapshot().phase).toBe('off')
		expect(track.stop).toHaveBeenCalled()
		expect(context.close).toHaveBeenCalled()
		expect(api.voiceInputStop).toHaveBeenCalledOnce()
	})

	it('turning it off while it is still starting leaves nothing open', async () => {
		const { controller, api, settle, track } = setup()
		const gate = deferred<undefined>()
		api.voiceInputStart.mockImplementationOnce(() => gate.promise)
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		expect(controller.getSnapshot().phase).toBe('starting')
		controller.toggle()
		gate.resolve(undefined)
		await settle()
		expect(controller.getSnapshot().phase).toBe('off')
		expect(api.voiceInputStop).toHaveBeenCalled()
		expect(track.stop).not.toHaveBeenCalled()
		expect(vi.mocked(api.voiceInputAudio)).not.toHaveBeenCalled()
	})
})

describe('what is shown while listening', () => {
	async function listening() {
		const parts = setup()
		parts.controller.setOwner('s1')
		await parts.settle()
		parts.controller.toggle()
		await parts.settle()
		return parts
	}

	it('follows main’s phases and clears a message when speech starts again', async () => {
		const { controller, emit } = await listening()
		emit({ type: 'held', sessionId: 's1', text: 'evet' })
		expect(controller.getSnapshot().notice?.text).toBe(HELD_NOTICE)
		emit({ type: 'phase', sessionId: 's1', phase: 'hearing' })
		expect(controller.getSnapshot()).toMatchObject({ phase: 'hearing', notice: undefined })
		emit({ type: 'phase', sessionId: 's1', phase: 'transcribing' })
		expect(controller.getSnapshot().phase).toBe('transcribing')
		emit({ type: 'phase', sessionId: 's1', phase: 'listening' })
		expect(controller.getSnapshot().phase).toBe('listening')
	})

	it('says plainly that a question on screen needs the person, with what they said', async () => {
		const { controller, emit } = await listening()
		emit({ type: 'held', sessionId: 's1', text: 'Evet, izin veriyorum' })
		expect(controller.getSnapshot().notice).toEqual({
			kind: 'info',
			text: HELD_NOTICE,
			heard: 'Evet, izin veriyorum',
		})
		expect(HELD_NOTICE).toContain('can’t approve actions')
	})

	it('says plainly when a message could not be sent', async () => {
		const { controller, emit } = await listening()
		emit({ type: 'not-sent', sessionId: 's1', text: 'Bunu yap' })
		expect(controller.getSnapshot().notice).toEqual({
			kind: 'error',
			text: NOT_SENT_NOTICE,
			heard: 'Bunu yap',
		})
	})

	it('ignores events for another conversation', async () => {
		const { controller, emit } = await listening()
		emit({ type: 'held', sessionId: 'other', text: 'hayır' })
		emit({ type: 'phase', sessionId: 'other', phase: 'hearing' })
		expect(controller.getSnapshot()).toMatchObject({ phase: 'listening', notice: undefined })
	})

	it('tells the app when a spoken message went out and when a stop word ended the reply', async () => {
		const { emit, sent, stopped } = await listening()
		emit({ type: 'sent', sessionId: 's1' })
		emit({ type: 'reply-stopped', sessionId: 's1' })
		expect(sent).toEqual(['s1'])
		expect(stopped).toEqual(['s1'])
	})

	it.each([
		['error', ENDED_NOTICES.error],
		['uninstalled', ENDED_NOTICES.uninstalled],
		['sleep', ENDED_NOTICES.sleep],
	] as const)('main ending for %s closes the microphone and says why', async (reason, text) => {
		const { controller, emit, track } = await listening()
		emit({ type: 'ended', sessionId: 's1', reason })
		expect(controller.getSnapshot()).toMatchObject({ phase: 'off', notice: { text } })
		expect(track.stop).toHaveBeenCalled()
	})

	it.each(['stopped', 'conversation', 'window', 'quit'] as const)(
		'main ending for %s closes the microphone quietly',
		async (reason) => {
			const { controller, emit, track } = await listening()
			emit({ type: 'ended', sessionId: 's1', reason })
			expect(controller.getSnapshot()).toMatchObject({ phase: 'off', notice: undefined })
			expect(track.stop).toHaveBeenCalled()
		},
	)

	it('closes the microphone when main stops accepting audio', async () => {
		const { controller, api, worklet, track, settle } = await listening()
		api.voiceInputAudio.mockRejectedValueOnce(new Error('Voice input isn’t listening.'))
		worklet.port.onmessage?.({ data: new Float32Array(1600) })
		worklet.port.onmessage?.({ data: new Float32Array(1600) })
		await settle()
		expect(track.stop).toHaveBeenCalled()
		expect(controller.getSnapshot().phase).toBe('off')
	})
})

describe('stopping', () => {
	it('stops when the conversation changes', async () => {
		const { controller, api, settle, track } = setup()
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		controller.setOwner('s2')
		expect(controller.getSnapshot().phase).toBe('off')
		expect(track.stop).toHaveBeenCalled()
		expect(api.voiceInputStop).toHaveBeenCalledOnce()
	})

	it('stops when the window goes away', async () => {
		const { controller, api, settle, track, disconnect } = setup()
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		disconnect()
		expect(track.stop).toHaveBeenCalled()
		expect(api.voiceInputStop).toHaveBeenCalledOnce()
	})

	it('says one plain sentence when the microphone is refused, and leaves nothing open', async () => {
		const { controller, api, settle, track } = setup({ microphone: 'denied' })
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		const snapshot = controller.getSnapshot()
		expect(snapshot.phase).toBe('off')
		expect(snapshot.notice?.kind).toBe('error')
		expect(snapshot.notice?.text).toBe(
			'Namzu can’t use the microphone. Allow microphone access in Windows settings, then try again.',
		)
		expect(snapshot.notice?.text).not.toMatch(/NotAllowed|Permission denied|Error/)
		expect(api.voiceInputStop).toHaveBeenCalled()
		expect(track.stop).not.toHaveBeenCalled()
	})

	it('can be dismissed', async () => {
		const { controller, settle } = setup({ microphone: 'denied' })
		controller.setOwner('s1')
		await settle()
		controller.toggle()
		await settle()
		controller.dismissNotice()
		expect(controller.getSnapshot().notice).toBeUndefined()
	})
})

describe('settings events', () => {
	it('learns that the agreement was withdrawn elsewhere', async () => {
		const { controller, settle, api } = setup({ accepted: true })
		await settle()
		expect(controller.getSnapshot().accepted).toBe(true)
		const listener = api.onEvent.mock.calls[0]?.[0] as (event: unknown) => void
		listener({
			kind: 'settings',
			settings: { ...DEFAULT_DESKTOP_SETTINGS, voiceInputAccepted: false },
		})
		expect(controller.getSnapshot().accepted).toBe(false)
	})
})

describe('barge-in', () => {
	it('stops the reading when speech lasts 300 ms while it plays', () => {
		vi.useFakeTimers()
		const stop = vi.fn()
		const gate = new BargeIn(stop)
		gate.update('hearing', true)
		vi.advanceTimersByTime(299)
		expect(stop).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(stop).toHaveBeenCalledOnce()
	})
	it('ignores a short sound', () => {
		vi.useFakeTimers()
		const stop = vi.fn()
		const gate = new BargeIn(stop)
		gate.update('hearing', true)
		vi.advanceTimersByTime(200)
		gate.update('listening', true)
		vi.advanceTimersByTime(1000)
		expect(stop).not.toHaveBeenCalled()
	})
	it('does nothing when nothing is being read', () => {
		vi.useFakeTimers()
		const stop = vi.fn()
		const gate = new BargeIn(stop)
		gate.update('hearing', false)
		vi.advanceTimersByTime(5000)
		expect(stop).not.toHaveBeenCalled()
	})
	it('counts from when the reading begins if the person was already speaking', () => {
		vi.useFakeTimers()
		const stop = vi.fn()
		const gate = new BargeIn(stop)
		gate.update('hearing', false)
		vi.advanceTimersByTime(1000)
		gate.update('hearing', true)
		vi.advanceTimersByTime(299)
		expect(stop).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(stop).toHaveBeenCalledOnce()
	})
	it('stops when the reading ends first, and never twice', () => {
		vi.useFakeTimers()
		const stop = vi.fn()
		const gate = new BargeIn(stop)
		gate.update('hearing', true)
		vi.advanceTimersByTime(100)
		gate.update('hearing', false)
		vi.advanceTimersByTime(1000)
		expect(stop).not.toHaveBeenCalled()
		gate.update('hearing', true)
		gate.update('hearing', true)
		vi.advanceTimersByTime(300)
		expect(stop).toHaveBeenCalledOnce()
		gate.dispose()
	})
	it('is only about the reading: the delay is the only thing it can do', () => {
		vi.useFakeTimers()
		const stopPlayback = vi.fn()
		const gate = new BargeIn(stopPlayback, 50)
		gate.update('hearing', true)
		vi.advanceTimersByTime(50)
		expect(stopPlayback).toHaveBeenCalledOnce()
	})
})

const message = (over: Partial<ChatMessage>): ChatMessage => ({
	role: 'assistant',
	text: '',
	...over,
})

describe('reading a voice reply aloud', () => {
	it('picks the last answer after the person’s message', () => {
		const thread = {
			...emptyThread(),
			messages: [
				message({ role: 'user', text: 'selam' }),
				message({ text: 'Önce bakıyorum.', phase: 'commentary' }),
				message({ text: 'Merhaba, buyrun.', phase: 'final_answer' }),
			],
		}
		expect(spokenReplyTarget(thread)).toEqual({ key: 'message-2', text: 'Merhaba, buyrun.' })
	})
	it('skips commentary at the end and unfinished text', () => {
		const thread = {
			...emptyThread(),
			messages: [
				message({ role: 'user', text: 'selam' }),
				message({ text: 'Cevap', status: 'completed' }),
				message({ text: 'ara not', phase: 'commentary' }),
				message({ text: 'yarım', status: 'pending' }),
			],
		}
		expect(spokenReplyTarget(thread)).toEqual({ key: 'message-1', text: 'Cevap' })
	})
	it('reads nothing when there is no answer yet, an error, or the text is too long', () => {
		expect(spokenReplyTarget(emptyThread())).toBeUndefined()
		expect(
			spokenReplyTarget({ ...emptyThread(), messages: [message({ role: 'user', text: 'selam' })] }),
		).toBeUndefined()
		expect(
			spokenReplyTarget({
				...emptyThread(),
				error: 'x',
				messages: [message({ role: 'user', text: 'a' }), message({ text: 'b' })],
			}),
		).toBeUndefined()
		expect(
			spokenReplyTarget({
				...emptyThread(),
				messages: [message({ role: 'user', text: 'a' }), message({ text: 'b'.repeat(8_001) })],
			}),
		).toBeUndefined()
	})
	it('a reply has finished only in the same conversation with nothing queued behind it', () => {
		const before = { sessionId: 's1', running: true }
		expect(replyJustFinished(before, { sessionId: 's1', running: false, queued: 0 })).toBe(true)
		expect(replyJustFinished(before, { sessionId: 's1', running: false, queued: 1 })).toBe(false)
		expect(replyJustFinished(before, { sessionId: 's1', running: true, queued: 0 })).toBe(false)
		expect(replyJustFinished(before, { sessionId: 's2', running: false, queued: 0 })).toBe(false)
		expect(
			replyJustFinished(
				{ sessionId: 's1', running: false },
				{ sessionId: 's1', running: false, queued: 0 },
			),
		).toBe(false)
	})
	it('reads aloud only when the local voice is installed and switched on', () => {
		const state = (installation: 'ready' | 'missing', enabled: boolean) =>
			({ installation, settings: { enabled } }) as never
		expect(canReadAloud({ supported: true, busy: false, state: state('ready', true) })).toBe(true)
		expect(canReadAloud({ supported: true, busy: false, state: state('ready', false) })).toBe(false)
		expect(canReadAloud({ supported: true, busy: false, state: state('missing', true) })).toBe(
			false,
		)
		expect(canReadAloud({ supported: false, busy: false, state: state('ready', true) })).toBe(false)
		expect(canReadAloud({ supported: true, busy: true, state: state('ready', true) })).toBe(false)
		expect(canReadAloud({ supported: true, busy: false, state: null })).toBe(false)
	})
})
