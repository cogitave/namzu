import {
	type ChooserAnswer,
	type ChooserDisplay,
	type ChooserInit,
	type ChooserMicrophone,
	RECORDING_LIMITS,
	RECORDING_WORDS,
	type RecordingAvailability,
	type RecordingNotice,
	type RecordingReviewView,
	chooserDisclosure,
} from '../../shared/recording-protocol.js'
import type { FrameSource } from './assembler.js'
import { recordingAvailability } from './availability.js'
import { composerText, frameName, recordingBlock, recordingChipName } from './message.js'
import { RecordingNarration } from './narration.js'
import type { NarrationService } from './narration.js'
import type { ContentProtection } from './protection.js'
import {
	type NarrationHandle,
	type PillOutput,
	RecordingSession,
	type Scheduler,
	type SessionState,
	type WatchSource,
} from './session.js'

/**
 * Record your screen as the application sees it: whether it is offered, the chooser, one recording at
 * a time, the review, and what Send hands to the composer. Everything Electron, the native helper or
 * the computer's clock is passed in, so a test drives the whole flow with fakes.
 */

/** One display the person may choose, with what recording it needs. */
export interface DisplaySource {
	info: ChooserDisplay
	/** Pixels of the display itself; the picture is scaled from this. */
	width: number
	height: number
	shownWidth: number
	shownHeight: number
	frames: () => FrameSource
	/** The pointer in this display's pixels, or undefined when it is on another display. */
	cursor: () => { x: number; y: number } | undefined
	/** Where the pill goes. */
	place?: () => void
}

export interface ListeningState {
	ready: boolean
	/** `Voice narration understands <language>.` */
	language?: string
	service?: NarrationService
	microphones: ChooserMicrophone[]
}

export interface ControllerSettings {
	/** Settings, Privacy: the switch that offers the menu item. */
	enabled: boolean
	voice: boolean
	microphone: string
}

export interface ControllerDeps {
	platform: NodeJS.Platform
	env: Readonly<Record<string, string | undefined>>
	wsl?: boolean
	helperPresent: () => boolean
	settings: () => ControllerSettings
	saveSettings: (patch: {
		screenRecordingVoice?: boolean
		screenRecordingMicrophone?: string
	}) => void
	listening: () => Promise<ListeningState>
	displays: () => Promise<DisplaySource[]>
	createWatch: () => WatchSource | undefined
	chooser: (init: ChooserInit) => Promise<ChooserAnswer>
	pill: PillOutput
	protection: ContentProtection
	shortcut: () => string
	notify: (notice: RecordingNotice) => void
	thumb: (jpeg: Uint8Array) => string
	clock: () => number
	wall: () => number
	scheduler: Scheduler
	nextId: () => string
	openSettings?: () => void
	count?: (what: 'started' | 'finished' | 'discarded') => void
}

export type BeginResult =
	| { started: true }
	| { started: false; reason: 'cancelled' | 'unavailable' | 'busy' | 'failed'; message?: string }

/** What Send hands to the composer: one attachment and the text that goes beside it. */
export interface RecordingDelivery {
	attachment: { name: string; text: string; images: { name: string; data: string }[] }
	composerText: string
}

export class RecordingController {
	private session: RecordingSession | undefined
	private choosing = false

	constructor(private readonly deps: ControllerDeps) {}

	availability(): RecordingAvailability {
		return recordingAvailability({
			platform: this.deps.platform,
			env: this.deps.env,
			...(this.deps.wsl ? { wsl: true } : {}),
			helper: { present: this.deps.helperPresent() },
			enabled: this.deps.settings().enabled,
		})
	}

	get state(): SessionState {
		return this.session?.state ?? 'idle'
	}

	/** Quitting loses a recording that is running or waiting; the window asks first. */
	get holdsRecording(): boolean {
		return this.session?.holdsRecording ?? false
	}

	/**
	 * Opens the chooser and, on Start, begins recording. `provider` names where the recording will
	 * go once sent ("DeepSeek V4 Flash"), because the chooser says so.
	 */
	async begin(options: { provider: string }): Promise<BeginResult> {
		const availability = this.availability()
		if (!availability.available)
			return {
				started: false,
				reason: 'unavailable',
				...(availability.message ? { message: availability.message } : {}),
			}
		if (this.choosing || this.session?.busy)
			return { started: false, reason: 'busy', message: RECORDING_WORDS.alreadyRunning }
		this.choosing = true
		try {
			const [displays, listening] = await Promise.all([this.deps.displays(), this.deps.listening()])
			if (displays.length === 0)
				return { started: false, reason: 'failed', message: 'No screen was found to record.' }
			const settings = this.deps.settings()
			const voiceAvailable = listening.ready
			const init: ChooserInit = {
				disclosure: chooserDisclosure(options.provider),
				warning: RECORDING_WORDS.warning,
				voiceMissing: RECORDING_WORDS.listeningMissing,
				displays: displays.map((display) => display.info),
				voice: {
					available: voiceAvailable,
					on: voiceAvailable && settings.voice,
					...(voiceAvailable && listening.language
						? { language: `Voice narration understands ${listening.language}.` }
						: {}),
					microphones: listening.microphones,
					microphone: settings.microphone,
				},
				shortcut: this.deps.shortcut(),
				provider: options.provider,
				inputProtectionMs: RECORDING_LIMITS.inputProtectionMs,
			}
			this.deps.notify({ type: 'state', recording: 'chooser' })
			let answer = await this.deps.chooser(init)
			while (answer.type === 'open-settings' || answer.type === 'continue') {
				if (answer.type === 'open-settings') this.deps.openSettings?.()
				answer = await this.deps.chooser(init)
			}
			if (answer.type === 'cancel') {
				this.deps.notify({ type: 'state', recording: 'idle' })
				return { started: false, reason: 'cancelled' }
			}
			const chosen = displays.find((display) => display.info.id === answer.displayId)
			if (!chosen) {
				this.deps.notify({ type: 'state', recording: 'idle' })
				return { started: false, reason: 'failed', message: 'That screen is no longer there.' }
			}
			this.deps.saveSettings({
				screenRecordingVoice: answer.voice,
				...(answer.microphone ? { screenRecordingMicrophone: answer.microphone } : {}),
			})
			const session = this.makeSession(chosen, listening)
			this.session = session
			chosen.place?.()
			try {
				await session.start({ voice: answer.voice && voiceAvailable })
			} catch (error) {
				this.session = undefined
				this.deps.notify({ type: 'state', recording: 'idle' })
				return {
					started: false,
					reason: 'failed',
					message: error instanceof Error ? error.message : RECORDING_WORDS.blocked,
				}
			}
			return { started: true }
		} finally {
			this.choosing = false
		}
	}

	private makeSession(display: DisplaySource, listening: ListeningState): RecordingSession {
		const watch = this.deps.createWatch()
		const noticeState = (state: SessionState) =>
			this.deps.notify({ type: 'state', recording: state === 'processing' ? 'running' : state })
		return new RecordingSession({
			clock: this.deps.clock,
			wall: this.deps.wall,
			scheduler: this.deps.scheduler,
			frames: display.frames(),
			...(watch ? { watch } : {}),
			cursor: display.cursor,
			protection: this.deps.protection,
			pill: this.deps.pill,
			...(listening.ready && listening.service
				? {
						narration: (hooks): NarrationHandle =>
							new RecordingNarration({
								service: listening.service as NarrationService,
								say: hooks.say,
								onDisconnect: hooks.disconnected,
							}),
					}
				: {}),
			display: {
				w: display.width,
				h: display.height,
				shownW: display.shownWidth,
				shownH: display.shownHeight,
			},
			nextId: this.deps.nextId,
			thumb: this.deps.thumb,
			...(this.deps.count ? { count: this.deps.count } : {}),
			onState: noticeState,
			onReview: (view) => this.deps.notify({ type: 'review', view }),
			onReviewClosed: (reason) => this.deps.notify({ type: 'review-closed', reason }),
			onMessage: (text) => this.deps.notify({ type: 'message', text }),
		})
	}

	/** A button on the pill, the tray or the shortcut. */
	async act(action: 'pause' | 'resume' | 'done' | 'discard' | 'reconnect'): Promise<void> {
		const session = this.session
		if (!session) return
		if (action === 'pause') session.pause()
		else if (action === 'resume') session.resume()
		else if (action === 'reconnect') session.reconnectNarration()
		else if (action === 'done') await session.done('done')
		else await session.discard()
	}

	/** The shortcut or the tray ends the recording from anywhere. */
	async endNow(): Promise<void> {
		const session = this.session
		if (!session || !session.busy) return
		await session.done('shortcut')
	}

	away(reason: 'lock' | 'sleep'): void {
		this.session?.away(reason)
	}

	displayLost(): void {
		const session = this.session
		if (session?.busy) void session.done('display-lost')
	}

	audio(samples: Float32Array): void {
		this.session?.audio(samples)
	}

	review(): RecordingReviewView | undefined {
		return this.session?.review ? this.session.reviewView() : undefined
	}

	removeStep(id: number): RecordingReviewView | undefined {
		this.session?.review?.removeStep(id)
		return this.review()
	}

	removePicture(index: number): RecordingReviewView | undefined {
		this.session?.review?.removePicture(index)
		return this.review()
	}

	removePictures(): RecordingReviewView | undefined {
		this.session?.review?.removePictures()
		return this.review()
	}

	removeVoice(): RecordingReviewView | undefined {
		this.session?.review?.removeVoice()
		return this.review()
	}

	/** Discard on the review sheet. */
	discardReview(): void {
		this.session?.closeReview('discarded')
	}

	/**
	 * Send on the review sheet: the recording as one attachment and the composer text. Nothing has
	 * gone to the model before this; after it the draft holds the recording until the person sends
	 * the message.
	 */
	send(note: string | undefined): RecordingDelivery {
		const session = this.session
		const draft = session?.review
		if (!session || !draft) throw new Error(RECORDING_WORDS.expired)
		const { result, frames } = draft.finalize()
		const text = recordingBlock({ result, frames, imageInput: true })
		const delivery: RecordingDelivery = {
			attachment: {
				name: recordingChipName(result.durationMs),
				text,
				images: frames.map((frame) => ({
					name: `${frameName(frame.index)}.jpg`,
					data: Buffer.from(frame.jpeg).toString('base64'),
				})),
			},
			composerText: composerText(note),
		}
		session.closeReview('sent')
		return delivery
	}
}
