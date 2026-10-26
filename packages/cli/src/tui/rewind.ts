/**
 * The rewind picker, without the screen: which prompts it offers, what each
 * choice would do to the files, the words it shows, and how a key moves it.
 *
 * Two stages. The list names the prompts the conversation was given and the
 * present, with what rewinding to each would do to the files. Choosing a
 * prompt opens the options for it: put the files back, continue the
 * conversation from before it, both, summarise around it, or leave it alone.
 */

import { basename } from 'node:path'

import type { Message } from '@namzu/sdk'

import { type CheckpointTurn, type RewindSummary, turnLabel } from '../checkpoints/store.js'
import type { EditablePrompt } from './edit-prompts.js'
import { moveSelection } from './selection-window.js'

// -- which turns come at or after a prompt ---------------------------------

/** One durable user message, as the checkpoint history can name it. */
export interface DurableUser {
	readonly ordinal: number
	readonly label: string
}

/** Every user message in the history, host-authored ones too, in order. */
export function durableUsers(history: readonly Message[]): readonly DurableUser[] {
	const users: DurableUser[] = []
	let ordinal = 0
	for (const message of history) {
		if (message.role !== 'user') continue
		users.push({
			ordinal,
			label: turnLabel(typeof message.content === 'string' ? message.content : ''),
		})
		ordinal += 1
	}
	return users
}

/**
 * The user message each checkpoint turn began with.
 *
 * A turn records the position of its prompt. That position is believed only
 * while the prompt there still has the turn's own words: a history that was
 * shortened since (a compaction, a summary) moves positions, and a turn from
 * before positions were recorded has none. Those are found by their words,
 * scanning forward so two prompts that read alike stay in order. A turn that
 * cannot be placed either way is left out, and the caller says the code
 * cannot be restored rather than guess.
 */
export function placeTurns(
	turns: readonly CheckpointTurn[],
	users: readonly DurableUser[],
): ReadonlyMap<string, number> {
	const placed = new Map<string, number>()
	let floor = -1
	for (const turn of [...turns].sort((a, b) => a.index - b.index)) {
		const recorded = turn.promptOrdinal
		const direct = recorded === undefined ? undefined : users[recorded]
		let ordinal: number | undefined
		if (direct && direct.ordinal === recorded && direct.label === turn.label) ordinal = recorded
		else {
			ordinal = users.find((u) => u.ordinal > floor && u.label === turn.label)?.ordinal
		}
		if (ordinal === undefined) continue
		placed.set(turn.turnId, ordinal)
		floor = Math.max(floor, ordinal)
	}
	return placed
}

/**
 * The first checkpoint turn that began at or after the user message with this
 * position, which is where `restore` starts putting files back from.
 */
export function restoreStart(
	userOrdinal: number,
	turns: readonly CheckpointTurn[],
	placed: ReadonlyMap<string, number>,
): number | undefined {
	let start: number | undefined
	for (const turn of turns) {
		const at = placed.get(turn.turnId)
		if (at === undefined || at < userOrdinal) continue
		if (start === undefined || turn.index < start) start = turn.index
	}
	return start
}

// -- rows -------------------------------------------------------------------

/** What the files would do, per row. */
export type RewindFiles =
	/** Checkpointing is off for this conversation: no second line, no code options. */
	| { readonly kind: 'off' }
	/** Nothing at or after this prompt changed a file. */
	| { readonly kind: 'none' }
	/** The history holds changes that cannot be tied to a prompt, so none is offered. */
	| { readonly kind: 'unavailable' }
	| {
			readonly kind: 'changes'
			readonly restoreFrom: number
			/** Absent while the counting has not finished or could not be done. */
			readonly summary?: RewindSummary
			/** Paths, known from the manifests alone. */
			readonly paths: readonly string[]
	  }

export interface RewindRow {
	readonly kind: 'prompt' | 'current'
	readonly prompt?: EditablePrompt
	readonly files: RewindFiles
}

export function buildRewindRows(
	prompts: readonly EditablePrompt[],
	turns: readonly CheckpointTurn[] | undefined,
	history: readonly Message[],
): readonly RewindRow[] {
	const placed = turns ? placeTurns(turns, durableUsers(history)) : new Map<string, number>()
	const rows: RewindRow[] = prompts.map((prompt) => {
		if (!turns) return { kind: 'prompt', prompt, files: { kind: 'off' } }
		const start = restoreStart(prompt.userOrdinal, turns, placed)
		if (start === undefined) {
			const stray = turns.some((t) => !placed.has(t.turnId))
			return { kind: 'prompt', prompt, files: { kind: stray ? 'unavailable' : 'none' } }
		}
		const paths = new Set<string>()
		for (const turn of turns) {
			const at = placed.get(turn.turnId)
			if (at !== undefined && at >= prompt.userOrdinal)
				for (const file of turn.files) paths.add(file)
		}
		return {
			kind: 'prompt',
			prompt,
			files: { kind: 'changes', restoreFrom: start, paths: [...paths] },
		}
	})
	rows.push({ kind: 'current', files: { kind: 'off' } })
	return rows
}

/** Counting is done newest first, so the rows nearest the present are exact soonest. */
export async function countRewindRows(
	rows: readonly RewindRow[],
	summarise: (fromIndex: number, expired: () => boolean) => Promise<RewindSummary>,
	opts: {
		now: () => number
		budgetMs: number
		onRow: (index: number, summary: RewindSummary) => void
	},
): Promise<void> {
	const until = opts.now() + opts.budgetMs
	const expired = () => opts.now() >= until
	for (let i = rows.length - 1; i >= 0; i--) {
		const files = rows[i]?.files
		if (files?.kind !== 'changes') continue
		let summary: RewindSummary
		try {
			summary = await summarise(files.restoreFrom, expired)
		} catch {
			continue
		}
		opts.onRow(i, summary)
	}
}

/** The time the second lines may take to count, all together. */
export const REWIND_COUNT_BUDGET_MS = 1000

/** `main.ts +3 -1`, `4 files changed +9 -2`, `No code changes`, or the unavailable notice. */
export function rewindRowDetail(files: RewindFiles): string | undefined {
	switch (files.kind) {
		case 'off':
			return undefined
		case 'none':
			return 'No code changes'
		case 'unavailable':
			return '⚠ No code restore'
		case 'changes': {
			const names = files.summary?.files ?? files.paths
			if (names.length === 0) return 'No code changes'
			const head =
				names.length === 1 ? basename(names[0] as string) : `${names.length} files changed`
			return `${head}${countsText(files.summary)}`
		}
	}
}

function countsText(summary: RewindSummary | undefined): string {
	if (summary?.insertions === undefined || summary.deletions === undefined) return ''
	return ` +${summary.insertions} -${summary.deletions}`
}

/** The rows' present-tense summary of the files a restore would put back. */
export function restoreFilesLine(files: RewindFiles): string | undefined {
	if (files.kind !== 'changes') return undefined
	const names = files.summary?.files ?? files.paths
	if (names.length === 0) return 'The code has not changed (nothing will be restored).'
	const where =
		names.length === 1
			? basename(names[0] as string)
			: names.length === 2
				? `${basename(names[0] as string)} and ${basename(names[1] as string)}`
				: `${basename(names[0] as string)} and ${names.length - 1} other files`
	return `The code will be restored${countsText(files.summary)} in ${where}.`
}

// -- options ----------------------------------------------------------------

export type RewindOption =
	| 'both'
	| 'conversation'
	| 'code'
	| 'summarize'
	| 'summarize_up_to'
	| 'nevermind'

export const REWIND_OPTION_LABELS: Readonly<Record<RewindOption, string>> = {
	both: 'Restore code and conversation',
	conversation: 'Restore conversation',
	code: 'Restore code',
	summarize: 'Summarize from here',
	summarize_up_to: 'Summarize up to here',
	nevermind: 'Never mind',
}

export const REWIND_CONTEXT_PLACEHOLDER = 'add context (optional)'
export const REWIND_CODE_WARNING = '⚠ Rewinding does not affect files edited manually or via bash.'

export function isSummarize(option: RewindOption): boolean {
	return option === 'summarize' || option === 'summarize_up_to'
}

export function rewindOptions(
	canRestoreCode: boolean,
	canSummarize: boolean,
): readonly RewindOption[] {
	return [
		...(canRestoreCode ? (['both', 'conversation', 'code'] as const) : (['conversation'] as const)),
		...(canSummarize ? (['summarize', 'summarize_up_to'] as const) : []),
		'nevermind',
	]
}

/** The dim line that changes with the focused option. */
export function conversationLine(option: RewindOption): string {
	switch (option) {
		case 'summarize':
			return 'Messages after this point will be summarized.'
		case 'summarize_up_to':
			return 'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.'
		case 'both':
		case 'conversation':
			return 'The conversation will be forked.'
		case 'code':
		case 'nevermind':
			return 'The conversation will be unchanged.'
	}
}

/** The dim line about the files, absent for a summary (it touches none). */
export function codeLine(option: RewindOption, files: RewindFiles): string | undefined {
	if (isSummarize(option)) return undefined
	if (files.kind === 'changes' && (option === 'both' || option === 'code')) {
		return restoreFilesLine(files)
	}
	return 'The code will be unchanged.'
}

export function confirmHeader(canRestoreCode: boolean): string {
	return `Confirm you want to restore ${canRestoreCode ? '' : 'the conversation '}to the point before you sent this message:`
}

export function listHeader(checkpointing: boolean): string {
	return checkpointing
		? 'Restore the code and/or conversation to the point before…'
		: 'Restore and fork the conversation to the point before…'
}

export const NOTHING_TO_REWIND = 'Nothing to rewind to yet.'

/** `just now`, `5 minutes ago`, `2 hours ago`, `3 days ago`. */
export function ageText(at: number | undefined, now: number): string | undefined {
	if (at === undefined || !Number.isFinite(at)) return undefined
	const seconds = Math.max(0, Math.floor((now - at) / 1000))
	if (seconds < 45) return 'just now'
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return plural(Math.max(1, minutes), 'minute')
	const hours = Math.round(minutes / 60)
	if (hours < 24) return plural(hours, 'hour')
	return plural(Math.round(hours / 24), 'day')
}

// -- state and keys ---------------------------------------------------------

export interface RewindState {
	readonly stage: 'list' | 'confirm'
	/** Index into the rows; the last row is the present. */
	readonly selected: number
	/** The row the options are for, in the confirm stage. */
	readonly target?: number
	readonly option: RewindOption
	readonly texts: { readonly summarize: string; readonly summarize_up_to: string }
	/** Set while a choice is being carried out; the keys are ignored. */
	readonly busy?: RewindOption
	/** Shown in red inside the dialog; the dialog stays open. */
	readonly error?: string
}

export function openRewind(rowCount: number): RewindState {
	return {
		stage: 'list',
		selected: Math.max(0, rowCount - 1),
		option: 'conversation',
		texts: { summarize: '', summarize_up_to: '' },
	}
}

export interface RewindKey {
	readonly escape?: boolean
	readonly return?: boolean
	readonly upArrow?: boolean
	readonly downArrow?: boolean
	readonly home?: boolean
	readonly end?: boolean
	readonly pageUp?: boolean
	readonly pageDown?: boolean
	readonly backspace?: boolean
	readonly delete?: boolean
	readonly ctrl?: boolean
	readonly meta?: boolean
	readonly tab?: boolean
}

export type RewindEffect =
	| { readonly kind: 'close' }
	| {
			readonly kind: 'choose'
			readonly row: number
			readonly option: Exclude<RewindOption, 'nevermind'>
			readonly context: string | undefined
	  }

export interface RewindStep {
	readonly state: RewindState
	readonly effect?: RewindEffect
}

export interface RewindEnv {
	readonly rows: readonly RewindRow[]
	readonly canSummarize: boolean
}

export function canRestoreCodeAt(row: RewindRow | undefined): boolean {
	return row?.files.kind === 'changes'
}

export function optionsFor(state: RewindState, env: RewindEnv): readonly RewindOption[] {
	const row = state.target === undefined ? undefined : env.rows[state.target]
	return rewindOptions(canRestoreCodeAt(row), env.canSummarize)
}

export function rewindKey(
	state: RewindState,
	input: string,
	key: RewindKey,
	env: RewindEnv,
): RewindStep {
	if (state.busy) return { state }
	if (state.stage === 'list') return listKey(state, key, env)
	return confirmKey(state, input, key, env)
}

function listKey(state: RewindState, key: RewindKey, env: RewindEnv): RewindStep {
	const count = env.rows.length
	if (key.escape) return { state, effect: { kind: 'close' } }
	const move = (movement: Parameters<typeof moveSelection>[2]): RewindStep => ({
		state: { ...state, selected: moveSelection(state.selected, count, movement), error: undefined },
	})
	if (key.upArrow) return move('previous')
	if (key.downArrow) return move('next')
	if (key.pageUp) return move('previous-page')
	if (key.pageDown) return move('next-page')
	if (key.home) return move('first')
	if (key.end) return move('last')
	if (key.return) {
		const row = env.rows[state.selected]
		if (!row || row.kind === 'current') return { state, effect: { kind: 'close' } }
		const options = rewindOptions(canRestoreCodeAt(row), env.canSummarize)
		return {
			state: {
				...state,
				stage: 'confirm',
				target: state.selected,
				option: options[0] as RewindOption,
				error: undefined,
			},
		}
	}
	return { state }
}

function confirmKey(state: RewindState, input: string, key: RewindKey, env: RewindEnv): RewindStep {
	const options = optionsFor(state, env)
	const index = Math.max(0, options.indexOf(state.option))
	const back = (): RewindStep => ({
		state: { ...state, stage: 'list', target: undefined, error: undefined },
	})
	if (key.escape) return back()
	const focus = (next: number): RewindStep => ({
		state: {
			...state,
			option: options[Math.max(0, Math.min(options.length - 1, next))] as RewindOption,
		},
	})
	if (key.upArrow) return focus(index - 1)
	if (key.downArrow || key.tab) return focus(index + 1)
	if (key.home) return focus(0)
	if (key.end) return focus(options.length - 1)
	if (key.return) {
		if (state.option === 'nevermind') return back()
		if (state.target === undefined) return { state }
		const context = isSummarize(state.option)
			? state.texts[state.option as 'summarize' | 'summarize_up_to'].trim() || undefined
			: undefined
		return {
			state: { ...state, error: undefined },
			effect: {
				kind: 'choose',
				row: state.target,
				option: state.option as Exclude<RewindOption, 'nevermind'>,
				context,
			},
		}
	}
	if (isSummarize(state.option)) {
		const slot = state.option as 'summarize' | 'summarize_up_to'
		if (key.backspace || key.delete) {
			return {
				state: {
					...state,
					texts: { ...state.texts, [slot]: [...state.texts[slot]].slice(0, -1).join('') },
				},
			}
		}
		if (input && !key.ctrl && !key.meta) {
			const printable = [...input].filter((ch) => !isControl(ch)).join('')
			if (printable) {
				return {
					state: { ...state, texts: { ...state.texts, [slot]: state.texts[slot] + printable } },
				}
			}
		}
	}
	return { state }
}

function isControl(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0
	return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}
