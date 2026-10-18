import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ThreadState } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'
import type { DesktopSettings } from '../shared/settings-protocol.js'
import {
	VOICE_BARGE_IN_MS,
	type VoiceInputEvent,
	type VoiceInputPhase,
} from '../shared/voice-input-protocol.js'
import { plainErrorText } from './plain-error.js'
import type { LocalSpeechControls, LocalSpeechSnapshot } from './use-local-speech.js'
import {
	type CaptureEnvironment,
	CaptureError,
	VoiceCapture,
	browserEnvironment,
} from './voice-capture.js'

export interface VoiceInputRendererApi {
	voiceInputStart?(sessionId: string): Promise<void>
	voiceInputAudio?(sessionId: string, samples: Float32Array): Promise<void>
	voiceInputStop?(): Promise<void>
	onVoiceInputEvent?(listener: (event: VoiceInputEvent) => void): () => void
	settings?(): Promise<DesktopSettings>
	setSettings?(patch: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings }>
	onEvent?(listener: (event: DesktopEvent) => void): () => void
}

/** What the mic button shows: off, starting the microphone, or one of the listening phases. */
export type VoiceMicPhase = 'off' | 'starting' | VoiceInputPhase

export interface VoiceNotice {
	kind: 'info' | 'error'
	text: string
	/** What was heard, for a message that was not sent. */
	heard?: string
}
export interface VoiceInputSnapshot {
	supported: boolean
	phase: VoiceMicPhase
	/** The first press asks before the microphone is opened. */
	consentOpen: boolean
	/** Whether the person has agreed to voice input; unknown until main answers. */
	accepted: boolean | undefined
	notice?: VoiceNotice
}

export const HELD_NOTICE =
	'A question is waiting on the screen. Answer it there; voice can’t approve actions. What you said wasn’t sent.'
export const NOT_SENT_NOTICE = 'Namzu couldn’t send what you said. Try again, or type it.'
export const ENDED_NOTICES = {
	error: 'Voice input stopped because something went wrong. Turn it on to try again.',
	uninstalled: 'Voice input was removed, so listening stopped.',
	sleep: 'Listening stopped because the computer slept or was locked.',
} as const

const HEARD_MAX = 200
function heardText(text: string): string {
	return text.length > HEARD_MAX ? `${text.slice(0, HEARD_MAX).trimEnd()}…` : text
}

export interface VoiceInputCallbacks {
	/** A spoken message went out; its reply may be read aloud. */
	sent?(sessionId: string): void
	/** A stop word ended the reply, so it must not be read aloud. */
	replyStopped?(sessionId: string): void
}

/** One per window. Owns the microphone while listening and mirrors what main reports. */
export class VoiceInputController {
	private snapshot: VoiceInputSnapshot
	private listeners = new Set<() => void>()
	private unsubscribe: (() => void)[] = []
	private connected = false
	private lifetime = 0
	private sessionId: string | undefined
	private active: { sessionId: string; capture?: VoiceCapture } | undefined
	private reported: VoiceInputPhase = 'listening'
	private generation = 0
	private starting = false

	constructor(
		private readonly api: VoiceInputRendererApi,
		private readonly callbacks: VoiceInputCallbacks = {},
		private readonly environment: () => CaptureEnvironment = browserEnvironment,
	) {
		this.snapshot = {
			supported: !!(
				api.voiceInputStart &&
				api.voiceInputAudio &&
				api.voiceInputStop &&
				api.onVoiceInputEvent
			),
			phase: 'off',
			consentOpen: false,
			accepted: undefined,
		}
	}

	getSnapshot = (): VoiceInputSnapshot => this.snapshot
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	connect(): () => void {
		this.connected = true
		this.lifetime += 1
		const lifetime = this.lifetime
		const live = () => this.connected && this.lifetime === lifetime
		const stops: (() => void)[] = []
		const events = this.api.onVoiceInputEvent?.((event) => live() && this.event(event))
		if (events) stops.push(events)
		const settings = this.api.onEvent?.((event) => {
			if (live() && event.kind === 'settings')
				this.update({ accepted: event.settings.voiceInputAccepted })
		})
		if (settings) stops.push(settings)
		void this.api
			.settings?.()
			.then((value) => live() && this.update({ accepted: value.voiceInputAccepted }))
			.catch(() => undefined)
		this.unsubscribe = stops
		return () => {
			if (this.lifetime !== lifetime) return
			this.connected = false
			this.lifetime += 1
			for (const stop of stops) stop()
			this.teardown(true)
		}
	}

	/** The conversation this window shows. Listening belongs to one and stops when it changes. */
	setOwner(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) return
		this.sessionId = sessionId
		if (this.snapshot.phase !== 'off' || this.snapshot.consentOpen || this.snapshot.notice) {
			this.teardown(true)
			this.update({ phase: 'off', consentOpen: false, notice: undefined })
		}
	}

	toggle = (): void => {
		if (!this.snapshot.supported) return
		if (this.snapshot.phase !== 'off') {
			this.teardown(true)
			this.update({ phase: 'off', notice: undefined })
			return
		}
		if (!this.sessionId) return
		if (this.snapshot.accepted !== true) {
			this.update({ consentOpen: true, notice: undefined })
			return
		}
		void this.start()
	}

	acceptConsent = async (): Promise<void> => {
		if (!this.api.setSettings) return
		this.update({ consentOpen: false })
		try {
			const result = await this.api.setSettings({ voiceInputAccepted: true })
			if (!this.connected) return
			this.update({ accepted: result.settings.voiceInputAccepted })
			if (result.settings.voiceInputAccepted) await this.start()
		} catch (error) {
			if (this.connected)
				this.update({
					notice: { kind: 'error', text: plainErrorText(error, 'turn on voice input') },
				})
		}
	}
	declineConsent = (): void => this.update({ consentOpen: false })
	dismissNotice = (): void => this.update({ notice: undefined })

	private async start(): Promise<void> {
		const sessionId = this.sessionId
		if (!sessionId || this.starting || this.snapshot.phase !== 'off') return
		this.starting = true
		const generation = ++this.generation
		const stale = () => this.generation !== generation || !this.connected
		this.reported = 'listening'
		this.update({ phase: 'starting', notice: undefined })
		const active: { sessionId: string; capture?: VoiceCapture } = { sessionId }
		this.active = active
		try {
			await this.api.voiceInputStart?.(sessionId)
			if (stale()) {
				// Main opened its side after the person already turned this off.
				void this.api.voiceInputStop?.().catch(() => undefined)
				return
			}
			const capture = new VoiceCapture(
				this.environment(),
				(samples) => {
					if (this.active !== active) return
					// Main rejects once it has stopped; its own `ended` event says why.
					void this.api.voiceInputAudio?.(sessionId, samples).catch(() => this.teardown(false))
				},
				(error) => {
					if (this.active !== active) return
					this.fail(error)
				},
			)
			active.capture = capture
			await capture.start()
			if (stale()) {
				capture.stop()
				return
			}
			this.update({ phase: this.reported })
		} catch (error) {
			if (stale()) return
			this.fail(error)
		} finally {
			this.starting = false
		}
	}

	private fail(error: unknown): void {
		const text =
			error instanceof CaptureError ? error.message : plainErrorText(error, 'turn on voice input')
		this.teardown(true)
		this.update({ phase: 'off', notice: { kind: 'error', text } })
	}

	/** Closes the microphone; `tellMain` also ends the listening session there. */
	private teardown(tellMain: boolean): void {
		this.generation += 1
		const active = this.active
		this.active = undefined
		active?.capture?.stop()
		if (tellMain && active) void this.api.voiceInputStop?.().catch(() => undefined)
		if (!tellMain && active && this.snapshot.phase !== 'off') this.update({ phase: 'off' })
	}

	private event(event: VoiceInputEvent): void {
		// A reply belongs to its conversation whether or not the microphone is still open for it.
		if (event.type === 'sent') {
			this.callbacks.sent?.(event.sessionId)
			return
		}
		if (event.type === 'reply-stopped') {
			this.callbacks.replyStopped?.(event.sessionId)
			return
		}
		if (event.sessionId !== this.active?.sessionId) return
		switch (event.type) {
			case 'phase':
				this.reported = event.phase
				if (this.snapshot.phase !== 'off' && this.snapshot.phase !== 'starting')
					this.update({
						phase: event.phase,
						notice: event.phase === 'hearing' ? undefined : this.snapshot.notice,
					})
				return
			case 'held':
				this.update({ notice: { kind: 'info', text: HELD_NOTICE, heard: heardText(event.text) } })
				return
			case 'not-sent':
				this.update({
					notice: { kind: 'error', text: NOT_SENT_NOTICE, heard: heardText(event.text) },
				})
				return
			case 'ended': {
				this.teardown(false)
				const reason = event.reason
				const text =
					reason === 'error' || reason === 'uninstalled' || reason === 'sleep'
						? ENDED_NOTICES[reason]
						: undefined
				this.update({
					phase: 'off',
					...(text ? { notice: { kind: 'info' as const, text } } : {}),
				})
				return
			}
		}
	}

	private update(patch: Partial<VoiceInputSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		for (const listener of this.listeners) listener()
	}
}

export interface VoiceInputControls extends VoiceInputSnapshot {
	toggle(): void
	acceptConsent(): Promise<void>
	declineConsent(): void
	dismissNotice(): void
}

export function useVoiceInput(
	api: VoiceInputRendererApi,
	sessionId: string | undefined,
	callbacks: VoiceInputCallbacks,
): VoiceInputControls {
	const latest = useRef(callbacks)
	latest.current = callbacks
	const controller = useMemo(
		() =>
			new VoiceInputController(api, {
				sent: (id) => latest.current.sent?.(id),
				replyStopped: (id) => latest.current.replyStopped?.(id),
			}),
		[api],
	)
	const snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	)
	useEffect(() => controller.connect(), [controller])
	useEffect(() => controller.setOwner(sessionId), [controller, sessionId])
	return {
		...snapshot,
		toggle: controller.toggle,
		acceptConsent: controller.acceptConsent,
		declineConsent: controller.declineConsent,
		dismissNotice: controller.dismissNotice,
	}
}

/**
 * Barge-in: speaking over a reply that is being read aloud stops the reading, but only once the
 * speech has lasted a moment, so a cough or a click does not cut it off. It never stops the
 * agent's work; only a stop word does that.
 */
export class BargeIn {
	private phase: VoiceMicPhase = 'off'
	private playing = false
	private timer: ReturnType<typeof setTimeout> | undefined
	constructor(
		private readonly stopPlayback: () => void,
		private readonly delayMs = VOICE_BARGE_IN_MS,
	) {}
	update(phase: VoiceMicPhase, playing: boolean): void {
		this.phase = phase
		this.playing = playing
		const armed = phase === 'hearing' && playing
		if (!armed) {
			this.clear()
			return
		}
		if (this.timer !== undefined) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			if (this.phase === 'hearing' && this.playing) this.stopPlayback()
		}, this.delayMs)
	}
	dispose(): void {
		this.clear()
	}
	private clear(): void {
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
	}
}

export function useBargeIn(phase: VoiceMicPhase, playing: boolean, stopPlayback: () => void): void {
	const stop = useRef(stopPlayback)
	stop.current = stopPlayback
	const gate = useMemo(() => new BargeIn(() => stop.current()), [])
	useEffect(() => {
		gate.update(phase, playing)
	}, [gate, phase, playing])
	useEffect(() => () => gate.dispose(), [gate])
}

export const SPEAKABLE_MAX_CHARS = 8_000

/** The reply to read aloud once a turn is over: the last answer after the newest message of the person. */
export function spokenReplyTarget(thread: ThreadState): { key: string; text: string } | undefined {
	if (thread.error || thread.retry || thread.retryNotice) return undefined
	for (let index = thread.messages.length - 1; index >= 0; index--) {
		const message = thread.messages[index]
		if (!message) continue
		if (message.role === 'user') return undefined
		if (message.phase === 'commentary' || message.status === 'pending') continue
		const text = message.text.trim()
		if (!text || text.length > SPEAKABLE_MAX_CHARS) return undefined
		return { key: `message-${index}`, text }
	}
	return undefined
}

/** A reply in this conversation has just ended and nothing is waiting behind it. */
export function replyJustFinished(
	before: { sessionId: string; running: boolean },
	after: { sessionId: string; running: boolean; queued: number },
): boolean {
	return (
		before.sessionId === after.sessionId && before.running && !after.running && after.queued === 0
	)
}

/** The local voice is installed and switched on, so a reply can be read aloud. */
export function canReadAloud(
	speech: Pick<LocalSpeechSnapshot, 'supported' | 'state' | 'busy'>,
): boolean {
	return (
		speech.supported &&
		!speech.busy &&
		speech.state?.installation === 'ready' &&
		speech.state.settings.enabled
	)
}

/**
 * Reads a voice-started reply aloud when it finishes, through the same read-aloud the message
 * button uses, and only when the local voice is installed and switched on. Otherwise nothing
 * extra happens.
 */
export function useSpokenReplies(options: {
	sessionId: string
	thread: ThreadState
	speech: Pick<LocalSpeechControls, 'supported' | 'state' | 'busy' | 'readAloud'>
	/** Conversations whose current reply was started by voice. */
	started: { current: Set<string> }
}): void {
	const latest = useRef(options)
	latest.current = options
	const before = useRef({ sessionId: options.sessionId, running: options.thread.running })
	const { sessionId, thread } = options
	useEffect(() => {
		const after = { sessionId, running: thread.running, queued: thread.queued.length }
		const previous = before.current
		before.current = { sessionId, running: thread.running }
		if (!replyJustFinished(previous, after)) return
		const { started, speech } = latest.current
		if (!started.current.delete(sessionId) || !canReadAloud(speech)) return
		const target = spokenReplyTarget(latest.current.thread)
		if (target) void speech.readAloud(target.key, target.text)
	}, [sessionId, thread.running, thread.queued.length])
}
