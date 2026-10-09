import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_LOCAL_SPEECH_SETTINGS,
	LOCAL_SPEECH_MODEL_BYTES,
	LOCAL_SPEECH_PREVIEW_TEXT,
	type LocalSpeechEvent,
	type LocalSpeechState,
} from '../shared/local-speech-protocol.js'
import type { LocalSpeechPlayback } from './local-speech-playback.js'
import { LocalSpeechController, type LocalSpeechRendererApi } from './use-local-speech.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

function voiceState(enabled = true): LocalSpeechState {
	return {
		settings: { ...DEFAULT_LOCAL_SPEECH_SETTINGS, enabled },
		installation: 'ready',
		worker: 'unloaded',
		device: 'cpu',
		resources: {
			modelDownloadBytes: LOCAL_SPEECH_MODEL_BYTES,
			runtimeDownloadBytes: null,
			diskBytes: null,
			ramBytes: null,
			cpuPercent: null,
			vramBytes: null,
			firstAudioMs: null,
			measuredAt: null,
		},
	}
}

function setup(overrides: LocalSpeechRendererApi = {}, open: () => Promise<void> = async () => {}) {
	const listeners = new Set<(event: LocalSpeechEvent) => void>()
	const state = voiceState()
	const api: LocalSpeechRendererApi = {
		localSpeechState: vi.fn(async () => state),
		localSpeechConfigure: vi.fn(async (settings) => ({
			...state,
			settings: { ...state.settings, ...settings },
		})),
		localSpeechInstall: vi.fn(async () => state),
		localSpeechSpeak: vi.fn(async ({ requestId }) => ({ requestId })),
		localSpeechCancel: vi.fn(async () => {}),
		localSpeechAcknowledge: vi.fn(async () => {}),
		onLocalSpeechEvent: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		...overrides,
	}
	const players: {
		open: ReturnType<typeof vi.fn>
		append: ReturnType<typeof vi.fn>
		finish: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
		drain: () => void
	}[] = []
	let requestNumber = 0
	const controller = new LocalSpeechController(
		api,
		'conversation-a',
		(drain) => {
			const player = { open: vi.fn(open), append: vi.fn(), finish: vi.fn(), stop: vi.fn(), drain }
			players.push(player)
			return player as unknown as LocalSpeechPlayback
		},
		() => `speech-${++requestNumber}`,
	)
	const disconnect = controller.connect()
	const emit = (event: LocalSpeechEvent) => {
		for (const listener of listeners) listener(event)
	}
	const audio = (requestId = 'speech-1', sequence = 0): LocalSpeechEvent => ({
		type: 'audio',
		requestId,
		sequence,
		sampleRate: 24_000,
		channels: 1,
		format: 'pcm_s16le',
		pcmBase64: 'AIAAAP9/',
	})
	return { controller, api, players, emit, audio, disconnect }
}

describe('local speech window controller', () => {
	it('reads an actual reply through the exact owner and acknowledges played frames', async () => {
		const fixture = setup()
		await fixture.controller.refresh()
		await fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba Arda.')
		expect(fixture.api.localSpeechSpeak).toHaveBeenCalledWith({
			requestId: 'speech-1',
			sessionId: 'conversation-a',
			text: 'Merhaba Arda.',
			language: 'tr',
		})
		fixture.emit(fixture.audio())
		expect(fixture.players[0]?.append).toHaveBeenCalledWith(
			new Float32Array([-1, 0, 32_767 / 32_768]),
			24_000,
			expect.any(Function),
		)
		expect(fixture.api.localSpeechAcknowledge).not.toHaveBeenCalled()
		fixture.players[0]?.append.mock.calls[0]?.[2]()
		expect(fixture.api.localSpeechAcknowledge).toHaveBeenCalledWith('speech-1', 0)
		fixture.emit({ type: 'end', requestId: 'speech-1', reason: 'completed' })
		expect(fixture.controller.getSnapshot().playingMessageId).toBe('reply-1')
		fixture.players[0]?.drain()
		expect(fixture.controller.getSnapshot().playingMessageId).toBeUndefined()
		fixture.disconnect()
	})

	it('rejects stale owner callbacks and audio from another window/request', async () => {
		const fixture = setup()
		await fixture.controller.refresh()
		await fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba.')
		fixture.emit(fixture.audio('another-window-request'))
		expect(fixture.players[0]?.append).not.toHaveBeenCalled()
		fixture.emit(fixture.audio())
		const latePlayed = fixture.players[0]?.append.mock.calls[0]?.[2]
		fixture.controller.setOwner('conversation-b')
		expect(fixture.api.localSpeechCancel).toHaveBeenCalledWith('speech-1')
		expect(fixture.players[0]?.stop).toHaveBeenCalledOnce()
		latePlayed?.()
		fixture.emit(fixture.audio('speech-1', 1))
		await fixture.controller.readAloud('conversation-a', 'stale-reply', 'Old conversation.')
		expect(fixture.api.localSpeechSpeak).toHaveBeenCalledOnce()
		expect(fixture.api.localSpeechAcknowledge).not.toHaveBeenCalled()
		expect(fixture.players[0]?.append).toHaveBeenCalledOnce()
		fixture.disconnect()
	})

	it('does not start native synthesis if the owner changes while Web Audio unlocks', async () => {
		const opening = deferred<void>()
		const fixture = setup({}, () => opening.promise)
		await fixture.controller.refresh()
		const start = fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba.')
		fixture.controller.setOwner('conversation-b')
		opening.resolve()
		await start
		expect(fixture.api.localSpeechSpeak).not.toHaveBeenCalled()
		fixture.disconnect()
	})

	it('preserves a newer state event when an older status fetch settles', async () => {
		const request = deferred<LocalSpeechState>()
		const fixture = setup({ localSpeechState: vi.fn(() => request.promise) })
		fixture.emit({
			type: 'state',
			state: {
				...voiceState(),
				worker: 'speaking',
				resources: { ...voiceState().resources, firstAudioMs: 182 },
			},
		})
		request.resolve(voiceState())
		await fixture.controller.refresh()
		expect(fixture.controller.getSnapshot().state?.worker).toBe('speaking')
		expect(fixture.controller.getSnapshot().state?.resources.firstAudioMs).toBe(182)
		fixture.disconnect()
	})

	it('ignores retired lifetime state callbacks after cleanup and can reconnect', async () => {
		const request = deferred<LocalSpeechState>()
		const fixture = setup({ localSpeechState: vi.fn(() => request.promise) })
		fixture.disconnect()
		request.resolve(voiceState())
		await request.promise
		expect(fixture.controller.getSnapshot().state).toBeNull()
		const reconnect = fixture.controller.connect()
		await fixture.controller.refresh()
		expect(fixture.controller.getSnapshot().state?.installation).toBe('ready')
		reconnect()
	})

	it('turns the voice on once its download finishes, so Download voice is the only step', async () => {
		const installed = voiceState(false)
		const fixture = setup({
			localSpeechState: vi.fn(async () => voiceState(false)),
			localSpeechInstall: vi.fn(async () => installed),
		})
		await fixture.controller.refresh()
		await fixture.controller.install()
		expect(fixture.api.localSpeechConfigure).toHaveBeenCalledWith({ enabled: true })
		expect(fixture.controller.getSnapshot().state?.settings.enabled).toBe(true)
		fixture.disconnect()
	})

	it('does not turn the voice on when the download failed', async () => {
		const fixture = setup({
			localSpeechInstall: vi.fn(async () => {
				throw new Error('Offline')
			}),
		})
		await fixture.controller.refresh()
		await fixture.controller.install()
		expect(fixture.api.localSpeechConfigure).not.toHaveBeenCalled()
		fixture.disconnect()
	})

	it('allows only fixed preview while voice is disabled, with no conversation text sent', async () => {
		const fixture = setup({ localSpeechState: vi.fn(async () => voiceState(false)) })
		await fixture.controller.refresh()
		await fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba.')
		expect(fixture.api.localSpeechSpeak).not.toHaveBeenCalled()
		await fixture.controller.preview('conversation-a')
		expect(fixture.api.localSpeechSpeak).toHaveBeenCalledWith({
			requestId: 'speech-1',
			text: LOCAL_SPEECH_PREVIEW_TEXT,
			language: 'tr',
		})
		fixture.disconnect()
	})

	it('cancels malformed or reordered streams and reports actual playback failures', async () => {
		const fixture = setup()
		await fixture.controller.refresh()
		await fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba.')
		fixture.emit(fixture.audio('speech-1', 1))
		expect(fixture.controller.getSnapshot().error).toMatch('invalid audio stream')
		expect(fixture.api.localSpeechCancel).toHaveBeenCalledWith('speech-1')
		await fixture.controller.readAloud('conversation-a', 'reply-2', 'Tekrar merhaba.')
		fixture.emit({ type: 'error', requestId: 'speech-2', message: 'Voice process failed.' })
		expect(fixture.controller.getSnapshot().error).toBe('Voice process failed.')
		expect(fixture.controller.getSnapshot().playingMessageId).toBeUndefined()
		fixture.disconnect()
	})

	it('never reports a silent completion as successful playback', async () => {
		const fixture = setup()
		await fixture.controller.refresh()
		await fixture.controller.readAloud('conversation-a', 'reply-1', 'Merhaba.')
		fixture.emit({ type: 'end', requestId: 'speech-1', reason: 'completed' })
		expect(fixture.controller.getSnapshot().error).toBe('The local voice produced no audio.')
		fixture.disconnect()
	})
})
