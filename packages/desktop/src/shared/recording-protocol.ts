/**
 * Record your screen: the values the recorder, the chooser, the pill and the review sheet agree on.
 *
 * A recording is pictures of the chosen display, the controls the person used (read through the
 * accessibility interfaces, never as keys or buttons), ordinary text left in fields, and the person's
 * own voice when they turn it on. It lives in memory only and goes nowhere until the person presses
 * Send on the review sheet.
 */

/** Bump when the wrapper or the instruction block of the message changes. */
export const RECORDING_TEMPLATE_VERSION = 1

export const RECORDING_LIMITS = {
	/** Recorded time; the pill counts down from `COUNTDOWN_FROM_MS`. */
	maxDurationMs: 600_000,
	countdownFromMs: 540_000,
	/** A lock, sleep or user switch keeps the recording resumable this long. */
	awayKeepMs: 3_600_000,
	/** A finished recording waits for review this long. */
	reviewHoldMs: 600_000,
	/** The chooser's Start button ignores input this long after the chooser opens. */
	inputProtectionMs: 300,
	maxEvents: 2_000,
	maxTextChars: 200,
	maxNameChars: 80,
	maxTitleChars: 120,
	maxSayChunkChars: 4_096,
	maxSayTotalChars: 20_000,
	/** Held in memory while recording. */
	maxHeldFrames: 60,
	/** Sent: at most this many pictures and bytes. */
	maxSentFrames: 24,
	maxSentBytes: 6 * 1024 * 1024,
	/** The events JSON in the message. */
	maxEventsJsonBytes: 24_000,
	/** Longest edge of a kept picture and its JPEG quality. */
	frameLongEdge: 1280,
	frameQuality: 80,
	thumbEdge: 240,
	/** Frame policy. */
	minFrameGapMs: 700,
	maxQuietGapMs: 5_000,
	settleMs: 200,
	changeThreshold: 0.06,
	textStillMs: 700,
	cursorHz: 20,
} as const

export type RecordingPlatform = 'win32' | 'darwin' | 'linux' | 'other'

/** Why the Record your screen item is not offered; the item is simply absent in every case. */
export type RecordingUnavailable =
	| 'platform'
	| 'remote-session'
	| 'helper-missing'
	| 'helper-without-watch'
	| 'switched-off'

export interface RecordingAvailability {
	available: boolean
	reason?: RecordingUnavailable
	/** The sentence the person reads when the reason is one they can be told. */
	message?: string
}

export type RecordingEventType =
	| 'start'
	| 'app'
	| 'focus'
	| 'text'
	| 'say'
	| 'invoke'
	| 'select'
	| 'menu'
	| 'window'
	| 'pointer'
	| 'paused'
	| 'resumed'
	| 'stop'

export type RecordingPauseReason = 'user' | 'secure-field' | 'protected-screen' | 'lock' | 'sleep'

export type RecordingStopReason = 'done' | 'limit' | 'display-lost' | 'shortcut' | 'away'

export interface RecordingEvent {
	/** Milliseconds from the start, pauses removed. */
	t: number
	type: RecordingEventType
	role?: string
	name?: string
	title?: string
	field?: string
	value?: string
	text?: string
	phase?: 'open' | 'close'
	/** One based index of the picture taken for this event. */
	frame?: number
	/** For a pointer: where it settled, as a fraction of the display. */
	x?: number
	y?: number
	display?: { w: number; h: number }
	reason?: RecordingPauseReason | RecordingStopReason | 'protected-screen'
}

/** What a recording left out, and why. The review sheet lists it and the message says it. */
export interface RecordingCut {
	/** Events not kept because the 2 000 cap was reached. */
	events: number
	/** Text values not kept because a cap was reached. */
	text: number
	/** Spoken text not kept because a cap was reached. */
	say: number
	/** Pictures dropped while recording to stay under the held cap. */
	framesHeld: number
	/** Pictures dropped at delivery to stay within the sent count and size. */
	framesThinned: number
	/** Events dropped to fit the events JSON size. */
	eventsJson: number
	/** Texts and spoken words replaced because they looked like a secret. */
	redacted: number
	/** Moments left out because a secure field or a protected screen was showing. */
	paused: number
	/** Events the helper dropped because its queue was full. */
	helperDropped: number
	/** Pictures that could not be taken. */
	frameFailures: number
	/** Passed in by the person on the review sheet. */
	removedSteps: number
	removedPictures: number
	removedVoice: number
}

export const EMPTY_CUT: Readonly<RecordingCut> = Object.freeze({
	events: 0,
	text: 0,
	say: 0,
	framesHeld: 0,
	framesThinned: 0,
	eventsJson: 0,
	redacted: 0,
	paused: 0,
	helperDropped: 0,
	frameFailures: 0,
	removedSteps: 0,
	removedPictures: 0,
	removedVoice: 0,
})

export type RecordingVoice = 'on' | 'off' | 'unavailable'

/** A finished recording, in main's memory. The pictures never reach the window until Send. */
export interface RecordingFrameData {
	/** One based, in the order taken. */
	index: number
	t: number
	jpeg: Uint8Array
	/** Tied to an event the person caused (not only a timer or a visual change). */
	event: boolean
}

export interface RecordingResult {
	id: string
	durationMs: number
	stopReason: RecordingStopReason
	events: RecordingEvent[]
	frames: RecordingFrameData[]
	cut: RecordingCut
	voice: RecordingVoice
	display: { w: number; h: number; shownW: number; shownH: number }
	/** False when no program exposed its controls: pictures and the cursor only. */
	controls: boolean
	/** The pill said once that typing in a window is not recorded. */
	typingNote: boolean
}

/** What the review sheet shows; thumbnails are small data URLs, the full pictures stay in main. */
export interface RecordingReviewView {
	id: string
	durationMs: number
	duration: string
	pictureCount: number
	stepCount: number
	voice: RecordingVoice
	controls: boolean
	steps: RecordingReviewStep[]
	pictures: RecordingReviewPicture[]
	/** The lines under "What was cut or removed". */
	cutLines: string[]
	/** Seconds the sheet stays before the recording expires. */
	holdMs: number
	summary: string
}
export interface RecordingReviewStep {
	id: number
	t: number
	time: string
	label: string
	/** The picture beside the step, when it has one. */
	picture?: number
	kind: RecordingEventType
}
export interface RecordingReviewPicture {
	index: number
	time: string
	thumb: string
}

/** The states the pill shows. */
export type PillState =
	| { kind: 'recording'; elapsedMs: number; leftMs?: number; voice: boolean }
	| { kind: 'paused'; elapsedMs: number }
	| { kind: 'away'; elapsedMs: number; keptUntil: string }
	| { kind: 'processing' }
	| { kind: 'expired' }

/** A short line the pill may add under its controls. */
export type PillNote =
	| 'narration-disconnected'
	| 'typing-not-recorded'
	| 'screenshots-failing'
	| 'secure-field'
	| 'no-microphone'
	| 'limit'

export interface PillView {
	state: PillState
	note?: PillNote
}

/** The chooser's answer. */
export interface ChooserDisplay {
	id: string
	label: string
	width: number
	height: number
	thumb: string
	primary: boolean
	underCursor: boolean
}
export interface ChooserMicrophone {
	id: string
	label: string
}
export interface ChooserInit {
	displays: ChooserDisplay[]
	voice: {
		/** Local listening is installed. */
		available: boolean
		on: boolean
		/** `Voice narration understands <language>.` when known. */
		language?: string
		microphones: ChooserMicrophone[]
		microphone: string
	}
	shortcut: string
	provider: string
	/** Permission a platform wants before recording; none on Windows. */
	permission?: 'screen' | 'accessibility'
	inputProtectionMs: number
}
export type ChooserAnswer =
	| { type: 'start'; displayId: string; voice: boolean; microphone: string }
	| { type: 'cancel' }
	| { type: 'open-settings' }
	| { type: 'continue' }

/** What the window hears from main about a recording. */
export type RecordingNotice =
	| { type: 'state'; recording: 'idle' | 'chooser' | 'running' | 'paused' | 'away' | 'review' }
	| { type: 'review'; view: RecordingReviewView }
	| { type: 'review-closed'; reason: 'sent' | 'discarded' | 'expired' }
	| { type: 'message'; text: string }

/** The sentences the feature says to the person, in one place. */
export const RECORDING_WORDS = {
	title: 'Record your screen',
	remote: 'Recording does not work in a remote session.',
	blocked:
		'Recording is blocked by security software on this computer. Namzu does not ask you to turn it off.',
	alreadyRunning: 'A recording is already running.',
	limitReached: 'Reached the 10 minute limit.',
	expired: 'Your recording expired before it was sent. Record again.',
	discardedAfterLimit: 'Recording discarded after the time limit',
	narrationDisconnected: 'Narration disconnected. Click to reconnect.',
	typingNotRecorded: "Typing in this window isn't recorded.",
	screenshotsFailing: 'Screenshots are failing.',
	listeningMissing: 'Download listening in Settings to use your voice.',
	warning:
		"Don't type passwords or secrets, and don't show private conversations or sensitive information while recording.",
	quitWarning: 'A screen recording is waiting. Quitting loses it.',
} as const

/** `Namzu records pictures ...` as the chooser says it, with the provider and model filled in. */
export function chooserDisclosure(provider: string): string {
	return `Namzu records pictures of your screen, the controls you use, text you type into ordinary fields, and your voice if you turn it on. It stays on this computer until you press Send, and then goes to ${provider} as a message you can read first. Namzu turns it into a skill you can review.`
}

export function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
