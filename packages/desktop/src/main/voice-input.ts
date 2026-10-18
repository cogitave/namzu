import {
	LOCAL_LISTENING_SAMPLE_RATE,
	type LocalListeningState,
} from '../shared/local-listening-protocol.js'
import {
	VOICE_INPUT_SAMPLE_RATE,
	VoiceChunkRateLimit,
	type VoiceInputEndReason,
	type VoiceInputEvent,
	type VoiceInputPhase,
	readVoiceChunk,
} from '../shared/voice-input-protocol.js'
import { AsyncChannel, type ListeningFrame } from './local-listening-stream.js'
import {
	type EndpointOptions,
	UtteranceEndpointer,
	isInventedTranscript,
	isStopCommand,
} from './voice-endpointing.js'

/** Frames waiting for the models beyond this many (about thirty seconds) mean they cannot keep up. */
const MAX_BACKLOG_FRAMES = 300

export interface VoiceDetectorLike {
	detect(
		frames: AsyncIterable<ListeningFrame>,
		context: { readonly signal: AbortSignal },
	): AsyncIterable<{ type: 'speech_start' | 'speech_end'; timestampMs: number }>
}
export interface VoiceRecognizerLike {
	transcribe(
		frames: AsyncIterable<ListeningFrame>,
		context: { readonly signal: AbortSignal },
	): AsyncIterable<{ type: 'final_transcript'; text: string; timestampMs: number }>
}

export interface VoiceSessionOptions extends EndpointOptions {
	detector: VoiceDetectorLike
	recognizer: VoiceRecognizerLike
	onPhase(phase: VoiceInputPhase): void
	onUtterance(text: string): void
	/** The models stopped answering; the session is already closed. */
	onFailure(error: unknown): void
}

/**
 * One open microphone for one conversation. Frames are fed to the speech-activity detector and the
 * recognizer side by side, and what they report is turned into whole spoken messages.
 */
export class VoiceSession {
	private readonly abort = new AbortController()
	private readonly activity = new AsyncChannel<ListeningFrame>()
	private readonly speech = new AsyncChannel<ListeningFrame>()
	private readonly endpointer: UtteranceEndpointer
	private pushed = 0
	private consumedActivity = 0
	private consumedSpeech = 0
	private samples = 0
	private phase: VoiceInputPhase = 'listening'
	private speechStartedAt = 0
	private loops: Promise<void>[] = []
	private closed = false
	constructor(private readonly options: VoiceSessionOptions) {
		this.endpointer = new UtteranceEndpointer({
			...options,
			onUtterance: (text) => options.onUtterance(text),
			onChange: () => this.announce(),
		})
	}

	get open(): boolean {
		return !this.closed
	}

	start(): void {
		const context = { signal: this.abort.signal }
		this.loops = [
			this.consume(async () => {
				for await (const event of this.options.detector.detect(
					this.counted(this.activity, 'activity'),
					context,
				)) {
					if (event.type === 'speech_start') {
						this.speechStartedAt = event.timestampMs
						this.endpointer.speechStart()
					} else this.endpointer.speechEnd(this.speechStartedAt, event.timestampMs)
				}
			}),
			this.consume(async () => {
				// An invented line is dropped like a silent segment: it never becomes a message.
				for await (const event of this.options.recognizer.transcribe(
					this.counted(this.speech, 'speech'),
					context,
				))
					if (!isInventedTranscript(event.text))
						this.endpointer.transcript(event.text, event.timestampMs)
			}),
		]
	}

	/** Takes ownership of `samples` (already checked and copied). */
	push(samples: Float32Array): void {
		if (this.closed) return
		if (this.pushed - Math.min(this.consumedActivity, this.consumedSpeech) > MAX_BACKLOG_FRAMES) {
			this.fail(new Error('Voice input fell behind.'))
			return
		}
		const frame: ListeningFrame = {
			channels: 1,
			format: 'pcm_f32le',
			sampleRateHz: LOCAL_LISTENING_SAMPLE_RATE,
			samplesPerChannel: samples.length,
			// Little-endian on every platform Desktop runs on.
			data: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
			timestampMs: (this.samples * 1000) / VOICE_INPUT_SAMPLE_RATE,
		}
		this.samples += samples.length
		this.pushed++
		this.activity.push(frame)
		this.speech.push(frame)
	}

	/** The shared recognizer is working or idle. */
	recognition(active: boolean): void {
		this.endpointer.recognition(active)
	}

	async stop(): Promise<void> {
		if (this.closed) return
		this.closed = true
		this.abort.abort()
		this.endpointer.dispose()
		this.activity.close()
		this.speech.close()
		await Promise.allSettled(this.loops)
	}

	private async *counted(
		channel: AsyncChannel<ListeningFrame>,
		which: 'activity' | 'speech',
	): AsyncGenerator<ListeningFrame> {
		for await (const frame of channel) {
			if (which === 'activity') this.consumedActivity++
			else this.consumedSpeech++
			yield frame
		}
	}
	private consume(work: () => Promise<void>): Promise<void> {
		return work().catch((error) => {
			if (!this.closed) this.fail(error)
		})
	}
	private fail(error: unknown): void {
		if (this.closed) return
		void this.stop()
		this.options.onFailure(error)
	}
	private announce(): void {
		if (this.closed) return
		const next: VoiceInputPhase = this.endpointer.hearing
			? 'hearing'
			: this.endpointer.busy
				? 'transcribing'
				: 'listening'
		if (next === this.phase) return
		this.phase = next
		this.options.onPhase(next)
	}
}

export interface VoiceActivity {
	running: boolean
	/** A permission or decision prompt waits for the person. */
	waitingOnPerson: boolean
}
/** What the conversation can do for a spoken message. Main wires it to the same operator the composer uses. */
export interface VoiceConversation {
	activity(sessionId: string): VoiceActivity
	cancel(sessionId: string): Promise<void>
	/** Sends the way the composer sends typed text: a new turn when idle, current-turn input when running. */
	sendSpoken(sessionId: string, text: string): Promise<void>
}

export interface VoiceInputManagerOptions extends EndpointOptions {
	conversation: VoiceConversation
	createAdapters(): { detector: VoiceDetectorLike; recognizer: VoiceRecognizerLike }
	/** Throws unless the window still owns the conversation. */
	assertOwner(windowId: string, sessionId: string): void
	deliver(windowId: string, event: VoiceInputEvent): void
	consentAccepted(): boolean
	engineState(): Promise<LocalListeningState>
	record?(operation: string, error: unknown): void
}

interface Open {
	windowId: string
	sessionId: string
	session: VoiceSession
	limit: VoiceChunkRateLimit
	/** Commits run one after another so two spoken messages never overtake each other. */
	chain: Promise<void>
}

const NOT_READY = 'Voice input isn’t downloaded yet. Download it in Settings first.'
const NEEDS_CONSENT = 'Turn on voice input first. Namzu asks once before it uses the microphone.'

/** Spoken input for every window: ownership, limits, lifecycle, and what a finished message does. */
export class VoiceInputManager {
	private readonly open = new Map<string, Open>()
	private recognizing = false
	constructor(private readonly options: VoiceInputManagerOptions) {}

	has(windowId: string): boolean {
		return this.open.has(windowId)
	}

	async start(windowId: string, sessionId: unknown): Promise<void> {
		if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid voice conversation.')
		this.options.assertOwner(windowId, sessionId)
		if (!this.options.consentAccepted()) throw new Error(NEEDS_CONSENT)
		const state = await this.options.engineState()
		if (state.installation !== 'ready') throw new Error(NOT_READY)
		// The wait above is the only gap in which the window could have moved on.
		this.options.assertOwner(windowId, sessionId)
		await this.end(windowId, 'conversation')
		const { detector, recognizer } = this.options.createAdapters()
		const entry: Open = {
			windowId,
			sessionId,
			limit: new VoiceChunkRateLimit(this.options.now),
			chain: Promise.resolve(),
			session: new VoiceSession({
				...this.options,
				detector,
				recognizer,
				onPhase: (phase) => this.send(windowId, { type: 'phase', sessionId, phase }),
				onUtterance: (text) => {
					entry.chain = entry.chain.then(() => this.commit(entry, text))
				},
				onFailure: (error) => {
					this.options.record?.('voiceInput', error)
					if (this.open.get(windowId) === entry) this.open.delete(windowId)
					this.send(windowId, { type: 'ended', sessionId, reason: 'error' })
				},
			}),
		}
		this.open.set(windowId, entry)
		entry.session.recognition(this.recognizing)
		entry.session.start()
		this.send(windowId, { type: 'phase', sessionId, phase: 'listening' })
	}

	/** One chunk from a window. Throws (so the window stops sending) on anything wrong. */
	audio(windowId: string, sessionId: unknown, value: unknown): void {
		const entry = this.open.get(windowId)
		if (!entry || typeof sessionId !== 'string' || entry.sessionId !== sessionId)
			throw new Error('Voice input isn’t listening.')
		try {
			this.options.assertOwner(windowId, entry.sessionId)
		} catch (error) {
			void this.end(windowId, 'conversation')
			throw error
		}
		const samples = readVoiceChunk(value)
		if (!entry.limit.take(samples.length)) {
			void this.end(windowId, 'error')
			throw new Error('Voice input received audio too fast.')
		}
		entry.session.push(samples)
	}

	async stop(windowId: string): Promise<void> {
		await this.end(windowId, 'stopped')
	}
	stopWindow(windowId: string, reason: VoiceInputEndReason = 'window'): void {
		void this.end(windowId, reason)
	}
	stopAll(reason: VoiceInputEndReason): Promise<void> {
		return Promise.all([...this.open.keys()].map((id) => this.end(id, reason))).then(
			() => undefined,
		)
	}

	/** Keeps listening in step with the engine: removed means every microphone closes. */
	noteEngine(state: LocalListeningState): void {
		if (state.installation !== 'ready' && this.open.size > 0) void this.stopAll('uninstalled')
		const working = state.engine === 'working'
		if (working === this.recognizing) return
		this.recognizing = working
		for (const entry of this.open.values()) entry.session.recognition(working)
	}

	private async end(windowId: string, reason: VoiceInputEndReason): Promise<void> {
		const entry = this.open.get(windowId)
		if (!entry) return
		this.open.delete(windowId)
		await entry.session.stop()
		this.send(windowId, { type: 'ended', sessionId: entry.sessionId, reason })
	}

	private send(windowId: string, event: VoiceInputEvent): void {
		try {
			this.options.deliver(windowId, event)
		} catch (error) {
			this.options.record?.('voiceInputEvent', error)
		}
	}

	/** What a finished spoken message does. Voice never answers a permission or decision prompt. */
	private async commit(entry: Open, text: string): Promise<void> {
		const { windowId, sessionId } = entry
		if (this.open.get(windowId) !== entry) return
		try {
			this.options.assertOwner(windowId, sessionId)
		} catch {
			await this.end(windowId, 'conversation')
			return
		}
		const { conversation } = this.options
		try {
			if (isStopCommand(text)) {
				if (conversation.activity(sessionId).running) {
					await conversation.cancel(sessionId)
					this.send(windowId, { type: 'reply-stopped', sessionId })
				}
				return
			}
			if (conversation.activity(sessionId).waitingOnPerson) {
				this.send(windowId, { type: 'held', sessionId, text })
				return
			}
			await conversation.sendSpoken(sessionId, text)
			this.send(windowId, { type: 'sent', sessionId })
		} catch (error) {
			this.options.record?.('voiceInputSend', error)
			this.send(windowId, { type: 'not-sent', sessionId, text })
		}
	}
}
