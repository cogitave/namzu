/**
 * What the app tells its windows about the engine it runs and keeps current. Main builds this from
 * the engine folder's state and its own checks; a window only draws it. Nothing here is text from
 * the update feed: versions are checked version numbers, the rest are fixed words, and a time is a
 * number the window turns into a date in the person's own language.
 */

export type EngineSource = 'bundled' | 'managed' | 'override'

export interface EngineVersions {
	/** The Namzu command line version. */
	commandLine?: string
	/** The engine (SDK) version it carries. */
	engine?: string
}

/** Why a fetched engine was given up, in a few fixed kinds. */
export type EngineProblem = 'did-not-start' | 'ended-early' | 'failed-checks'

export type EngineStatus =
	/** The setting is off: only this app's own engine runs and nothing is asked of the network. */
	| { kind: 'off' }
	| { kind: 'override' }
	/** No answer from the feed has been seen yet. */
	| { kind: 'unknown' }
	| { kind: 'checking' }
	| { kind: 'current'; checkedAt: number }
	/** A newer engine is downloaded and checked; it runs from the next time a project opens. */
	| { kind: 'ready'; version: string }
	/** A fetched engine was given up; `to` is what runs instead. */
	| { kind: 'went-back'; version: string; problem: EngineProblem; to?: string }
	| { kind: 'needs-newer-app' }
	| { kind: 'cannot-check'; since: number }

export interface EngineRun extends EngineVersions {
	source: EngineSource
	/** When a fetched engine became the one in use. */
	since?: number
}

export interface EngineDeliveryView {
	/**
	 * False when this build has no signing key (or no bundled engine to compare with): the app
	 * asks nothing, and every screen reads exactly as it did before engines could be fetched.
	 */
	available: boolean
	/** The setting "Keep the engine up to date". */
	enabled: boolean
	runs: EngineRun
	/** This app's own engine: what is used when no fetched one works. */
	bundled: EngineVersions
	status: EngineStatus
	/** A fetched engine exists, so "Use this app's own engine" has something to do. */
	canUseOwn: boolean
}

export const UNAVAILABLE_ENGINE_VIEW: EngineDeliveryView = {
	available: false,
	enabled: true,
	runs: { source: 'bundled' },
	bundled: {},
	status: { kind: 'unknown' },
	canUseOwn: false,
}
