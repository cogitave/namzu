/** Desktop-owned speech. No project tools, credentials or cloud requests enter this protocol. */
export const LOCAL_SPEECH_PREVIEW_TEXT =
	'Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor.'
export const LOCAL_SPEECH_MODEL_BYTES = 34_389_147
export const LOCAL_SPEECH_MAX_TEXT = 8_000
export const LOCAL_SPEECH_SAMPLE_RATE = 24_000

export interface LocalSpeechSettings {
	enabled: boolean
	language: 'tr'
	engine: 'ema-lightning'
	/** Zero keeps an already loaded model in memory. */
	idleUnloadSeconds: 0 | 300
}
export const DEFAULT_LOCAL_SPEECH_SETTINGS: Readonly<LocalSpeechSettings> = {
	enabled: false,
	language: 'tr',
	engine: 'ema-lightning',
	idleUnloadSeconds: 300,
}
export interface LocalSpeechResources {
	modelDownloadBytes: number
	/** Exact retained wheel bytes after installation; unknown before installation. */
	runtimeDownloadBytes: number | null
	diskBytes: number | null
	/** Current worker process resident memory, excluding the Desktop and system Python. */
	ramBytes: number | null
	/** Worker CPU usage as a percentage of one CPU core. */
	cpuPercent: number | null
	/** The current implementation runs on CPU and allocates no model GPU memory. */
	vramBytes: null
	firstAudioMs: number | null
	measuredAt: string | null
}
export interface LocalSpeechState {
	settings: LocalSpeechSettings
	installation: 'missing' | 'installing' | 'ready' | 'failed'
	worker: 'unloaded' | 'loading' | 'ready' | 'speaking'
	device: 'cpu'
	resources: LocalSpeechResources
	error?: string
}
export interface LocalSpeechSpeakInput {
	requestId: string
	/** Main verifies the conversation belongs to the requesting window. Absent only for preview. */
	sessionId?: string
	text: string
	language: 'tr'
}
export type LocalSpeechEvent =
	| { type: 'state'; state: LocalSpeechState }
	| {
			type: 'audio'
			requestId: string
			sequence: number
			sampleRate: 24000
			format: 'pcm_s16le'
			channels: 1
			pcmBase64: string
	  }
	| { type: 'end'; requestId: string; reason: 'completed' | 'cancelled' }
	| { type: 'error'; requestId: string; message: string }

export function localSpeechSettings(
	value: unknown,
	base: LocalSpeechSettings = { ...DEFAULT_LOCAL_SPEECH_SETTINGS },
): LocalSpeechSettings {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid local speech settings.')
	const record = value as Record<string, unknown>
	const keys = new Set(['enabled', 'language', 'engine', 'idleUnloadSeconds'])
	if (Object.keys(record).some((key) => !keys.has(key)))
		throw new Error('Invalid local speech setting.')
	if ('enabled' in record && typeof record.enabled !== 'boolean')
		throw new Error('Invalid local speech preference.')
	if ('language' in record && record.language !== 'tr')
		throw new Error('EMA Lightning supports Turkish only.')
	if ('engine' in record && record.engine !== 'ema-lightning')
		throw new Error('Unsupported local speech engine.')
	if ('idleUnloadSeconds' in record && ![0, 300].includes(record.idleUnloadSeconds as number))
		throw new Error('Invalid local speech memory preference.')
	return { ...base, ...record } as LocalSpeechSettings
}

export function localSpeechRequestId(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
		throw new Error('Invalid local speech request.')
	return value
}

export function localSpeechText(value: unknown): string {
	if (typeof value !== 'string' || !value.trim() || value.length > LOCAL_SPEECH_MAX_TEXT)
		throw new Error('Speech text must contain between 1 and 8,000 characters.')
	return value
}
