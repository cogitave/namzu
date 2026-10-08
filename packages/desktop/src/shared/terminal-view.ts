/**
 * What crosses between the window and main for terminal tabs. The host's own protocol stays in
 * `terminal-protocol.ts`; a window never speaks it, it asks main, which owns the connection.
 */
import type { ReasoningEffort, ReviewMode } from '@namzu/sdk'
import type { TerminalEngine, TerminalTabView } from './terminal-tabs.js'

export const TERMINAL_VIEW_LIMITS = {
	minCols: 2,
	maxCols: 500,
	minRows: 1,
	maxRows: 200,
	maxWrite: 65_536,
	maxViewerId: 128,
	maxPrompt: 8_000,
} as const

export interface TerminalAvailability {
	available: boolean
	/** Why not, in words for the person. */
	reason?: string
}

export type TerminalOpenRequest = {
	projectId: string
	/** The workspace pane the new tab joins. */
	groupId: string
	cols: number
	rows: number
} & (
	| { kind: 'shell' }
	| {
			kind: 'engine'
			engine: TerminalEngine
			provider?: string
			model?: string
			effort?: ReasoningEffort
			permissionMode: ReviewMode
			/** The composer's text, for an installed engine's CLI to start on. */
			prompt?: string
	  }
)

export interface TerminalOpenResult {
	terminal: TerminalTabView
	/** Choices the engine's CLI could not take, for a notice. */
	omitted: string[]
}

export interface TerminalAttachOptions {
	/** The end of what the view last drew; absent when it has nothing to continue from. */
	fromOffset?: number
	/** Ask for the keyboard. */
	writer?: boolean
	/** Take the keyboard from another view. */
	force?: boolean
}

/** What a view needs to draw a terminal as it is now. */
export interface TerminalAttachView {
	/** `replay` appends `data` to what the view has; `snapshot` resets, writes `screen`, then `data`. */
	mode: 'replay' | 'snapshot'
	screen: string
	data: string
	start: number
	/** Live output continues at this offset. */
	end: number
	writer: boolean
	truncated: boolean
	status: TerminalTabView['status']
	exitCode?: number
}

/** Pushed to the windows that have the terminal open. */
export type TerminalEvent =
	| { kind: 'data'; tabId: string; offset: number; data: string }
	/** `exitCode` is absent when the host process itself went away. */
	| { kind: 'exit'; tabId: string; exitCode?: number; signal?: number }

export interface TerminalShellChoice {
	value: string
	label: string
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const MODES = ['prompt', 'accept-edits', 'auto', 'strict', 'plan'] as const
const ENGINE_IDS = ['namzu', 'codex-cli', 'claude-code'] as const

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`Invalid terminal ${what}.`)
	return value as Record<string, unknown>
}
function only(value: Record<string, unknown>, keys: readonly string[], what: string): void {
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw new Error(`Unexpected terminal ${what} field: ${key}.`)
}
function word(value: unknown, what: string, max = 256): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max)
		throw new Error(`Invalid terminal ${what}.`)
	return value
}
/** A value that becomes a command-line argument: no control characters, never an option. */
function argumentWord(value: unknown, what: string): string {
	const text = word(value, what)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(text) || text.startsWith('-'))
		throw new Error(`Invalid terminal ${what}.`)
	return text
}
function optionalWord(value: unknown, what: string): string | undefined {
	return value === undefined ? undefined : argumentWord(value, what)
}

/** The request a window sends to start a terminal, checked field by field. */
export function readTerminalOpenRequest(value: unknown): TerminalOpenRequest {
	const input = record(value, 'request')
	const kind = input.kind
	if (kind !== 'shell' && kind !== 'engine') throw new Error('Invalid terminal kind.')
	only(
		input,
		kind === 'shell'
			? ['projectId', 'groupId', 'cols', 'rows', 'kind']
			: [
					'projectId',
					'groupId',
					'cols',
					'rows',
					'kind',
					'engine',
					'provider',
					'model',
					'effort',
					'permissionMode',
					'prompt',
				],
		'request',
	)
	const base = {
		projectId: word(input.projectId, 'project'),
		groupId: word(input.groupId, 'pane'),
		cols: input.cols as number,
		rows: input.rows as number,
	}
	if (kind === 'shell') return { ...base, kind }
	const engine = (ENGINE_IDS as readonly unknown[]).includes(input.engine)
		? (input.engine as TerminalEngine)
		: undefined
	if (!engine) throw new Error('Invalid terminal engine.')
	if (!(MODES as readonly unknown[]).includes(input.permissionMode))
		throw new Error('Invalid terminal permission mode.')
	if (input.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(input.effort))
		throw new Error('Invalid terminal effort.')
	if (
		input.prompt !== undefined &&
		(typeof input.prompt !== 'string' ||
			input.prompt.length > TERMINAL_VIEW_LIMITS.maxPrompt ||
			input.prompt.includes('\0'))
	)
		throw new Error('Invalid terminal prompt.')
	const prompt = input.prompt as string | undefined
	const provider = optionalWord(input.provider, 'provider')
	const model = optionalWord(input.model, 'model')
	return {
		...base,
		kind,
		engine,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(input.effort ? { effort: input.effort as ReasoningEffort } : {}),
		permissionMode: input.permissionMode as ReviewMode,
		...(prompt?.trim() ? { prompt } : {}),
	}
}

export function readTerminalAttachOptions(value: unknown): TerminalAttachOptions {
	if (value === undefined) return {}
	const input = record(value, 'attach')
	only(input, ['fromOffset', 'writer', 'force'], 'attach')
	if (
		input.fromOffset !== undefined &&
		(typeof input.fromOffset !== 'number' ||
			!Number.isSafeInteger(input.fromOffset) ||
			input.fromOffset < 0)
	)
		throw new Error('Invalid terminal offset.')
	for (const flag of ['writer', 'force'])
		if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
			throw new Error(`Invalid terminal ${flag}.`)
	return {
		...(input.fromOffset === undefined ? {} : { fromOffset: input.fromOffset as number }),
		...(input.writer === true ? { writer: true } : {}),
		...(input.force === true ? { force: true } : {}),
	}
}
