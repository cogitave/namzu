import type { StopReason } from '@namzu/sdk'

export type PcmFormat = 'pcm_f32le' | 'pcm_s16le'

/** One interleaved PCM frame. Drivers must treat `data` as immutable. */
export interface AudioFrame {
	readonly channels: number
	readonly data: Uint8Array
	readonly format: PcmFormat
	readonly sampleRateHz: number
	readonly samplesPerChannel: number
	readonly sequence?: number
	readonly timestampMs?: number
}

export interface LiveMessage {
	readonly content: string
	readonly createdAt: number
	readonly id: string
	readonly role: 'assistant' | 'user'
}

export interface LiveUsage {
	readonly cacheCreationTokens: number
	readonly completionTokens: number
	readonly promptCachedTokens: number
	readonly promptTokens: number
	readonly totalTokens: number
}

export interface LiveModelTurn {
	readonly instructions: string
	readonly messages: readonly LiveMessage[]
	readonly signal: AbortSignal
}

export type LiveModelEvent =
	| { readonly messageId: string; readonly text: string; readonly type: 'text_delta' }
	| { readonly runId: string; readonly type: 'usage'; readonly usage: LiveUsage }
	| {
			readonly result: string
			readonly runId: string
			readonly stopReason: StopReason
			readonly type: 'completed'
	  }
	| { readonly runId: string; readonly type: 'cancelled' }

export interface LiveModel {
	stream(turn: LiveModelTurn): AsyncIterable<LiveModelEvent>
}

export interface MediaDriverContext {
	readonly signal: AbortSignal
}

export type VoiceActivityEvent =
	| {
			readonly probability?: number
			/** Milliseconds on the source stream's monotonic timeline. */
			readonly timestampMs: number
			readonly type: 'speech_start'
	  }
	| {
			readonly probability?: number
			/** Milliseconds on the source stream's monotonic timeline. */
			readonly timestampMs: number
			readonly type: 'speech_end'
	  }

export interface VoiceActivityDetector {
	detect(
		frames: AsyncIterable<AudioFrame>,
		context: MediaDriverContext,
	): AsyncIterable<VoiceActivityEvent>
}

export type TranscriptEvent =
	| {
			readonly confidence?: number
			readonly language?: string
			readonly text: string
			/** Milliseconds on the same source timeline used by voice-activity events. */
			readonly timestampMs: number
			readonly type: 'partial_transcript'
	  }
	| {
			readonly confidence?: number
			readonly language?: string
			readonly text: string
			/**
			 * End of the recognized speech on the same source timeline used by
			 * voice-activity events. It must fall inside the matching VAD interval.
			 */
			readonly timestampMs: number
			readonly type: 'final_transcript'
	  }

export interface SpeechRecognizer {
	transcribe(
		frames: AsyncIterable<AudioFrame>,
		context: MediaDriverContext,
	): AsyncIterable<TranscriptEvent>
}

export interface TurnDetectionContext {
	readonly history: readonly LiveMessage[]
	readonly signal: AbortSignal
	readonly speechEndedAt: number
	readonly speechStartedAt: number
	readonly transcript: string
	readonly transcriptFinalAt: number
}

export interface TurnDetector {
	isTurnComplete(context: TurnDetectionContext): boolean | Promise<boolean>
}

export interface SpeechSynthesisContext {
	readonly signal: AbortSignal
	readonly turnId: string
}

export interface SynthesizedAudio {
	readonly final: boolean
	readonly frame: AudioFrame
	readonly text?: string
}

export interface SpeechSynthesizer {
	synthesize(
		text: AsyncIterable<string>,
		context: SpeechSynthesisContext,
	): AsyncIterable<SynthesizedAudio>
}

export interface AudioOutput {
	cancel(turnId: string, reason: string): Promise<void> | void
	write(audio: SynthesizedAudio, context: SpeechSynthesisContext): Promise<void> | void
}

export type LiveSessionState =
	| 'closed'
	| 'idle'
	| 'listening'
	| 'ready'
	| 'responding'
	| 'speaking'
	| 'thinking'

export type LiveSessionEvent =
	| {
			readonly previous: LiveSessionState
			readonly state: LiveSessionState
			readonly type: 'state_changed'
	  }
	| { readonly turnId: string; readonly type: 'turn_started'; readonly userText: string }
	| { readonly event: VoiceActivityEvent; readonly type: 'voice_activity' }
	| { readonly event: TranscriptEvent; readonly type: 'transcript' }
	| { readonly text: string; readonly turnId: string; readonly type: 'assistant_text_delta' }
	| { readonly audio: SynthesizedAudio; readonly turnId: string; readonly type: 'assistant_audio' }
	| {
			readonly runId: string
			readonly turnId: string
			readonly type: 'usage'
			readonly usage: LiveUsage
	  }
	| {
			readonly latencyMs: number
			readonly message: LiveMessage
			readonly runId: string
			readonly turnId: string
			readonly type: 'turn_completed'
	  }
	| { readonly reason: string; readonly turnId: string; readonly type: 'turn_interrupted' }
	| { readonly error: Error; readonly turnId: string; readonly type: 'turn_failed' }
	| { readonly error: Error; readonly type: 'listener_failed' }

export interface LiveTurnResult {
	readonly latencyMs: number
	readonly message?: LiveMessage
	readonly runId?: string
	readonly status: 'completed' | 'interrupted'
	readonly turnId: string
	readonly usage?: LiveUsage
}
