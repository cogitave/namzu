/** Desktop-owned listening. Audio, transcripts and models never leave the machine. */
export const LOCAL_LISTENING_SAMPLE_RATE = 16_000

/** Where a running download is, so the person sees it moving. Present only while installing. */
export interface LocalListeningInstallProgress {
	step: 'preparing' | 'downloading' | 'checking'
	/** Bytes received so far across every file; only while `step` is `downloading`. */
	downloadedBytes?: number
	totalBytes?: number
}
export interface LocalListeningState {
	installation: 'missing' | 'installing' | 'ready' | 'failed'
	/** `unloaded` until the first request; `working` while a recognition is being computed. */
	engine: 'unloaded' | 'ready' | 'working'
	device: 'cpu'
	/** What the one-time download weighs. */
	downloadBytes: number
	/** Exact bytes on disk once installed; unknown before. */
	diskBytes: number | null
	progress?: LocalListeningInstallProgress
	error?: string
}
export type LocalListeningEvent = { type: 'state'; state: LocalListeningState }
