/**
 * Messages between the main process and the two inference workers. Kept free of runtime
 * values so the worker file can import it as types only.
 */
export type ListeningWorkerRole = 'voiceActivity' | 'recognizer'

export interface ListeningWorkerData {
	role: ListeningWorkerRole
	paths: { encoder: string; decoder: string; tokens: string; voiceActivity: string }
	threads: number
	language: string
}

/** What a voice-activity stream reports after audio is fed to it. Samples count from stream open. */
export interface VadFeedResult {
	/** True while a speech segment is still open. */
	detected: boolean
	/** Segments that closed during this feed, oldest first. */
	segments: { start: number; length: number }[]
}

export type ListeningWorkerRequest =
	| { id: number; type: 'vad-open'; stream: number }
	| { id: number; type: 'vad-feed'; stream: number; samples: Float32Array }
	| { id: number; type: 'vad-flush'; stream: number }
	| { id: number; type: 'vad-close'; stream: number }
	| { id: number; type: 'transcribe'; samples: Float32Array }

export type ListeningWorkerResponse =
	| { id: number; ok: true; vad?: VadFeedResult; text?: string }
	| { id: number; ok: false; message: string }

/** Most samples one voice-activity feed may carry (one second). */
export const MAX_VAD_FEED_SAMPLES = 16_000
/** Longest recognizer input: 30 s of speech plus roll and tail padding. */
export const MAX_TRANSCRIBE_SAMPLES = 33 * 16_000
/** Recognitions waiting behind the one running. */
export const MAX_QUEUED_TRANSCRIPTIONS = 8
/** Voice-activity streams open at once. */
export const MAX_VAD_STREAMS = 4
