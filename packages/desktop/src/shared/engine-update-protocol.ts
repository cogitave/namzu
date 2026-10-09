/**
 * Updates of the tools Namzu runs beside the app: the two external engines and a standalone Namzu CLI.
 * The app's own update is `update-protocol.ts`; these never download or restart anything by
 * themselves, and nothing here changes a program until the person clicks Update.
 */

export type EngineUpdateId = 'namzu-cli' | 'codex-cli' | 'claude-code'

export const ENGINE_UPDATE_IDS: readonly EngineUpdateId[] = [
	'codex-cli',
	'claude-code',
	'namzu-cli',
]

/** How the program got onto this machine, read from where it is. */
export type EngineInstallMethod = 'npm-global' | 'native' | 'standalone' | 'bundled' | 'unknown'

export type EngineUpdateStatus = 'current' | 'available' | 'updating' | 'failed' | 'unknown'

export interface EngineUpdateItem {
	id: EngineUpdateId
	name: string
	/** The npm package the registry knows it by. */
	package: string
	/** Absent when the program is not installed or its version could not be read. */
	installed?: string
	/** The registry's latest, when a check succeeded within a week. */
	latest?: string
	method: EngineInstallMethod
	status: EngineUpdateStatus
	/** When the registry was last asked, in milliseconds since the epoch. */
	checkedAt?: number
	/** True when no program was found at all. */
	missing?: boolean
	/** Where the program was found. */
	path?: string
	/** The command a click runs, or the one to run by hand when Namzu does not know the install. */
	command?: string
	/** Set when the command can be run for the person; false means show it and offer Copy. */
	runnable: boolean
	/** A muted line under the row. */
	note?: string
	/** Why the last update did not finish, in words for the person. */
	error?: string
	/** The terminal tab showing a running update. */
	tabId?: string
	/** True for the bundled Namzu command line, which has no program of its own to update. */
	bundled?: boolean
	/** Updated since this app started: open conversations keep the old version until they restart. */
	updated?: boolean
}

export interface EngineUpdatesState {
	items: EngineUpdateItem[]
	/** A check is running now. */
	checking: boolean
	/** When the last check finished (any item), for "Last checked". */
	checkedAt?: number
}

/** What a window sends to start an update. The command comes from main, never from the window. */
export interface EngineUpdateRequest {
	engine: EngineUpdateId
	/** The pane the visible terminal tab joins. */
	groupId: string
	/** The project whose folder the terminal starts in; main picks one when absent or unusable. */
	projectId?: string
}

export type EngineUpdateResult =
	| { ok: true; tabId: string }
	| {
			ok: false
			reason: string
			/** Present when the person can run the update by hand. */
			command?: string
	  }

/** A quiet message for the window that started an update. */
export interface EngineUpdateNotice {
	text: string
	tone: 'success' | 'error' | 'neutral'
}

/** A new version found since the person was last told, shown once. */
export interface EngineUpdateAnnouncement {
	id: EngineUpdateId
	name: string
	version: string
}

export const REGISTRY_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Plain `1.2.3` numbers, optionally with a prerelease tag. Anything else is not a version. */
const SEMVER =
	/^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/u

export function parseVersion(text: string): string | undefined {
	return SEMVER.test(text) ? text : undefined
}

/** The first version number in a program's `--version` line, or undefined. */
export function versionFromOutput(output: string): string | undefined {
	const match = /\b(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?)\b/u.exec(output)
	return match?.[1]
}

/** Negative when `a` is older than `b`. A prerelease is older than its release. */
export function compareVersions(a: string, b: string): number {
	const left = SEMVER.exec(a)
	const right = SEMVER.exec(b)
	if (!left || !right) return 0
	for (let index = 1; index <= 3; index++) {
		const difference = Number(left[index]) - Number(right[index])
		if (difference !== 0) return difference
	}
	if (left[4] === right[4]) return 0
	if (left[4] === undefined) return 1
	if (right[4] === undefined) return -1
	return left[4] < right[4] ? -1 : 1
}

export const ENGINE_UPDATE_NAMES: Record<EngineUpdateId, string> = {
	'codex-cli': 'Codex CLI',
	'claude-code': 'Claude Code',
	'namzu-cli': 'Namzu command line',
}

export const ENGINE_UPDATE_PACKAGES: Record<EngineUpdateId, string> = {
	'codex-cli': '@openai/codex',
	'claude-code': '@anthropic-ai/claude-code',
	'namzu-cli': '@namzu/cli',
}

export function readEngineUpdateRequest(value: unknown): EngineUpdateRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid update request.')
	const input = value as Record<string, unknown>
	for (const key of Object.keys(input))
		if (!['engine', 'groupId', 'projectId'].includes(key))
			throw new Error(`Unexpected update field: ${key}.`)
	if (!ENGINE_UPDATE_IDS.includes(input.engine as EngineUpdateId))
		throw new Error('Unknown program to update.')
	if (typeof input.groupId !== 'string' || input.groupId.length === 0 || input.groupId.length > 256)
		throw new Error('Invalid update pane.')
	if (
		input.projectId !== undefined &&
		(typeof input.projectId !== 'string' ||
			input.projectId.length === 0 ||
			input.projectId.length > 256)
	)
		throw new Error('Invalid update project.')
	return {
		engine: input.engine as EngineUpdateId,
		groupId: input.groupId,
		...(input.projectId === undefined ? {} : { projectId: input.projectId }),
	}
}
