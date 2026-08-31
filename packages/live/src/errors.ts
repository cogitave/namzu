export type LiveErrorCode =
	| 'already_listening'
	| 'audio_buffer_overflow'
	| 'audio_frame_invalid'
	| 'driver_close_timeout'
	| 'incomplete_utterance'
	| 'invalid_user_input'
	| 'invalid_driver_event'
	| 'missing_audio_output'
	| 'missing_speech_recognizer'
	| 'missing_speech_synthesizer'
	| 'missing_turn_detector'
	| 'missing_voice_activity_detector'
	| 'model_protocol_error'
	| 'query_failed'
	| 'run_not_speakable'
	| 'session_closed'
	| 'session_already_started'
	| 'session_not_started'
	| 'speech_too_long'
	| 'transcript_timeout'
	| 'turn_in_progress'
	| 'turn_interrupted'
	| 'unsafe_query_config'

export class LiveError extends Error {
	readonly code: LiveErrorCode

	constructor(code: LiveErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'LiveError'
		this.code = code
	}
}
