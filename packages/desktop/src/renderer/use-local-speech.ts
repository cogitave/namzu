import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import {
	LOCAL_SPEECH_MAX_TEXT,
	LOCAL_SPEECH_PREVIEW_TEXT,
	type LocalSpeechEvent,
	type LocalSpeechSettings,
	type LocalSpeechSpeakInput,
	type LocalSpeechState,
} from '../shared/local-speech-protocol.js'
import { LocalSpeechPlayback, decodeSpeechPcm } from './local-speech-playback.js'

export interface LocalSpeechRendererApi {
	localSpeechState?(): Promise<LocalSpeechState>
	localSpeechConfigure?(settings: Partial<LocalSpeechSettings>): Promise<LocalSpeechState>
	localSpeechInstall?(): Promise<LocalSpeechState>
	localSpeechUninstall?(): Promise<LocalSpeechState>
	localSpeechSpeak?(input: LocalSpeechSpeakInput): Promise<{ requestId: string }>
	localSpeechCancel?(requestId: string): Promise<void>
	localSpeechAcknowledge?(requestId: string, sequence: number): Promise<void>
	onLocalSpeechEvent?(listener: (event: LocalSpeechEvent) => void): () => void
}

export interface LocalSpeechSnapshot {
	state: LocalSpeechState | null
	loading: boolean
	busy: boolean
	supported: boolean
	playingMessageId?: string
	playbackPhase?: 'loading' | 'playing'
	error?: string
}

interface ActiveSpeech {
	requestId: string
	ownerId: string | undefined
	messageId: string
	nextSequence: number
	playback: LocalSpeechPlayback
	ended: boolean
}

/** One controller per Desktop window. Conversation changes revoke its playback immediately. */
export class LocalSpeechController {
	private snapshot: LocalSpeechSnapshot
	private listeners = new Set<() => void>()
	private unsubscribe: (() => void) | undefined
	private connected = false
	private lifetime = 0
	private active: ActiveSpeech | undefined
	private refreshPromise: Promise<void> | undefined
	private stateRevision = 0

	constructor(
		private api: LocalSpeechRendererApi,
		private ownerId: string | undefined,
		private playbackFactory: (onDrained: () => void) => LocalSpeechPlayback = (onDrained) =>
			new LocalSpeechPlayback(undefined, onDrained),
		private requestId: () => string = () => crypto.randomUUID(),
	) {
		this.snapshot = {
			state: null,
			loading: true,
			busy: false,
			supported: !!(
				api.localSpeechState &&
				api.localSpeechConfigure &&
				api.localSpeechInstall &&
				api.localSpeechSpeak &&
				api.localSpeechCancel &&
				api.localSpeechAcknowledge &&
				api.onLocalSpeechEvent
			),
		}
	}

	getSnapshot = (): LocalSpeechSnapshot => this.snapshot
	getServerSnapshot = (): LocalSpeechSnapshot => this.snapshot
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	connect(): () => void {
		this.connected = true
		this.lifetime += 1
		const lifetime = this.lifetime
		this.update({ busy: false })
		this.unsubscribe = this.api.onLocalSpeechEvent?.((event) => {
			if (this.connected && this.lifetime === lifetime) this.event(event)
		})
		void this.refresh()
		return () => {
			if (this.lifetime !== lifetime) return
			this.connected = false
			this.lifetime += 1
			this.unsubscribe?.()
			this.unsubscribe = undefined
			this.refreshPromise = undefined
			this.stop()
		}
	}

	setOwner(ownerId: string | undefined): void {
		if (ownerId === this.ownerId) return
		this.ownerId = ownerId
		this.stop()
	}

	async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise
		if (!this.snapshot.supported) {
			this.update({ loading: false })
			return
		}
		const lifetime = this.lifetime
		const stateRevision = this.stateRevision
		const work = (async () => {
			try {
				const state = await this.api.localSpeechState?.()
				if (
					this.connected &&
					this.lifetime === lifetime &&
					this.stateRevision === stateRevision &&
					state
				)
					this.update({ state, loading: false })
			} catch (error) {
				if (this.connected && this.lifetime === lifetime)
					this.update({ loading: false, error: message(error) })
			}
		})()
		this.refreshPromise = work
		try {
			await work
		} finally {
			if (this.refreshPromise === work) this.refreshPromise = undefined
		}
	}

	configure = async (settings: Partial<LocalSpeechSettings>): Promise<void> => {
		if (settings.enabled === false) this.stop()
		await this.change(() => this.api.localSpeechConfigure?.(settings))
	}

	install = async (): Promise<void> => {
		await this.change(() => this.api.localSpeechInstall?.())
		// Downloading the voice is the person's explicit ask to use it: one action, not two.
		const state = this.snapshot.state
		if (state?.installation === 'ready' && !state.settings.enabled && !this.snapshot.error)
			await this.configure({ enabled: true })
	}

	uninstall = async (): Promise<void> => {
		this.stop()
		await this.change(() => this.api.localSpeechUninstall?.())
	}

	preview = async (ownerId: string | undefined): Promise<void> => {
		await this.speak(ownerId, 'preview', LOCAL_SPEECH_PREVIEW_TEXT, true)
	}

	readAloud = async (
		ownerId: string | undefined,
		messageId: string,
		text: string,
	): Promise<void> => {
		await this.speak(ownerId, messageId, text, false)
	}

	stop = (): void => {
		const active = this.active
		this.active = undefined
		active?.playback.stop()
		if (active) void this.api.localSpeechCancel?.(active.requestId).catch(() => {})
		this.update({ playingMessageId: undefined, playbackPhase: undefined })
	}

	private async change(operation: () => Promise<LocalSpeechState> | undefined): Promise<void> {
		if (!this.connected || !this.snapshot.supported || this.snapshot.busy) return
		const lifetime = this.lifetime
		const stateRevision = this.stateRevision
		this.update({ busy: true, error: undefined })
		try {
			const state = await operation()
			if (this.connected && this.lifetime === lifetime) {
				if (this.stateRevision === stateRevision && state) this.update({ state, busy: false })
				else this.update({ busy: false })
			}
		} catch (error) {
			if (this.connected && this.lifetime === lifetime)
				this.update({ busy: false, error: message(error) })
		}
	}

	private async speak(
		ownerId: string | undefined,
		messageId: string,
		text: string,
		preview: boolean,
	): Promise<void> {
		if (!this.connected || this.ownerId !== ownerId || !this.snapshot.supported) return
		if (this.active?.messageId === messageId) {
			this.stop()
			return
		}
		if (
			this.snapshot.busy ||
			this.snapshot.state?.installation !== 'ready' ||
			(!preview && (!ownerId || !this.snapshot.state.settings.enabled))
		)
			return
		if (!text.trim() || text.length > LOCAL_SPEECH_MAX_TEXT) {
			this.update({ error: 'Choose a reply with between 1 and 8,000 characters.' })
			return
		}
		this.stop()
		const requestId = this.requestId()
		const playback = this.playbackFactory(() => {
			if (this.active?.requestId !== requestId) return
			this.active = undefined
			this.update({ playingMessageId: undefined, playbackPhase: undefined })
			void this.refresh()
		})
		const active: ActiveSpeech = {
			requestId,
			ownerId,
			messageId,
			nextSequence: 0,
			playback,
			ended: false,
		}
		this.active = active
		this.update({ playingMessageId: messageId, playbackPhase: 'loading', error: undefined })
		try {
			// This synchronous open starts from the click, before native I/O can lose activation.
			await playback.open()
			if (this.active !== active || this.ownerId !== ownerId || !this.connected) return
			const accepted = await this.api.localSpeechSpeak?.({
				requestId,
				...(preview ? {} : { sessionId: ownerId }),
				text,
				language: 'tr',
			})
			if (this.active !== active) return
			if (accepted?.requestId !== requestId)
				throw new Error('The local voice did not accept this request.')
		} catch (error) {
			if (this.active !== active) return
			this.stop()
			this.update({ error: message(error) })
		}
	}

	private event(event: LocalSpeechEvent): void {
		if (event.type === 'state') {
			this.stateRevision += 1
			this.update({ state: event.state, loading: false })
			if (
				event.state.installation !== 'ready' ||
				(!event.state.settings.enabled && this.active?.messageId !== 'preview')
			)
				this.stop()
			return
		}
		const active = this.active
		if (!active || event.requestId !== active.requestId || active.ownerId !== this.ownerId) return
		if (event.type === 'error') {
			this.stop()
			this.update({ error: event.message })
			return
		}
		if (event.type === 'end') {
			if (event.reason === 'cancelled') this.stop()
			else if (active.nextSequence === 0) {
				this.stop()
				this.update({ error: 'The local voice produced no audio.' })
			} else {
				active.ended = true
				active.playback.finish()
			}
			return
		}
		try {
			if (
				active.ended ||
				event.sequence !== active.nextSequence ||
				event.channels !== 1 ||
				event.format !== 'pcm_s16le' ||
				event.sampleRate !== 24_000
			)
				throw new Error('The local voice returned an invalid audio stream.')
			const samples = decodeSpeechPcm(event.pcmBase64)
			if (samples.length > event.sampleRate / 5)
				throw new Error('The local voice returned an invalid audio frame.')
			active.nextSequence += 1
			active.playback.append(samples, event.sampleRate, () => {
				if (this.active !== active || active.ownerId !== this.ownerId) return
				void this.api.localSpeechAcknowledge?.(active.requestId, event.sequence).catch((error) => {
					if (this.active !== active) return
					this.stop()
					this.update({ error: message(error) })
				})
			})
			this.update({ playbackPhase: 'playing' })
		} catch (error) {
			this.stop()
			this.update({ error: message(error) })
		}
	}

	private update(patch: Partial<LocalSpeechSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		for (const listener of this.listeners) listener()
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : 'The local voice is unavailable.'
}

export interface LocalSpeechControls extends LocalSpeechSnapshot {
	configure(settings: Partial<LocalSpeechSettings>): Promise<void>
	install(): Promise<void>
	uninstall(): Promise<void>
	preview(): Promise<void>
	readAloud(messageId: string, text: string): Promise<void>
	stop(): void
}

export function useLocalSpeech(
	api: LocalSpeechRendererApi,
	ownerId: string | undefined,
): LocalSpeechControls {
	const controller = useMemo(() => new LocalSpeechController(api, undefined), [api])
	const snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	)
	useLayoutEffect(() => controller.setOwner(ownerId), [controller, ownerId])
	useEffect(() => controller.connect(), [controller])
	return {
		...snapshot,
		configure: controller.configure,
		install: controller.install,
		uninstall: controller.uninstall,
		preview: () => controller.preview(ownerId),
		readAloud: (messageId, text) => controller.readAloud(ownerId, messageId, text),
		stop: controller.stop,
	}
}
