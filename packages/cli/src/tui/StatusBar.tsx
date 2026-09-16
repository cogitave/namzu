/**
 * One-line composer footer, directly below the input box.
 *
 * Left to right: the active permission mode (colored by mode, with its
 * cycle key) or, when no special mode is active, a quiet reminder that the
 * key exists; the reasoning effort beside it when the operator has set one;
 * the working directory. Right-aligned: an interaction hint or a durable
 * goal when either is active, else the model identity. The right side owns
 * its columns first so a deep path or a long mode label cannot erase the key
 * that exits a prompt.
 */

import { Text, useWindowSize } from 'ink'

import { type PermissionMode, permissionModeLabel } from '../permissions/mode.js'
import { theme } from './theme.js'

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	/** An explicit reasoning-effort override; omitted/undefined means the model's own default, which this footer does not name. */
	readonly effort?: string | null
	/** The session's orchestrate mode (`/orchestrate`) — a setting shown beside effort, never as a level of it. */
	readonly orchestrate?: boolean
	/** Ambient durable goal status; interaction hints take precedence. */
	readonly goal?: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
	/** The mode governing undecided tool calls. Omitted or 'prompt' shows the quiet cycle reminder instead of a badge. */
	readonly permissionMode?: PermissionMode
	/** Whether Shift+Tab actually reaches `permissionMode` here, so the footer never advertises a dead key. */
	readonly canCycleMode?: boolean
}

/** Icon, color and label for an active (non-default) permission mode. */
function modeGlyph(
	mode: PermissionMode,
): { readonly icon: string; readonly color: string; readonly label: string } {
	return {
		icon: mode === 'accept-edits' || mode === 'auto' ? '⏵⏵' : '⏸',
		color: mode === 'strict' ? theme.status.warn : theme.accent.user,
		label: permissionModeLabel(mode),
	}
}

const QUIET_MODE_HINT = 'shift+tab to cycle'
const CYCLE_SUFFIX = ' (shift+tab to cycle)'

export function StatusBar({
	cwd,
	provider,
	model,
	effort,
	orchestrate,
	goal,
	state,
	hint,
	permissionMode,
	canCycleMode,
}: StatusBarProps) {
	const terminal = useWindowSize()
	const activeMode =
		permissionMode !== undefined && permissionMode !== 'prompt' ? modeGlyph(permissionMode) : null
	const layout = fitStatusLine({
		// App gives the footer one cell of horizontal padding on each side. Ink's
		// stdout width is the whole terminal, so reserve those cells here rather
		// than letting its final two characters be clipped after fitting succeeds.
		columns: Math.max(0, terminal.columns - 2),
		cwd: shortenCwd(cwd),
		model,
		provider,
		effort: effort ?? null,
		orchestrate: orchestrate ?? false,
		hint,
		goal,
		modeLabel: activeMode ? `${activeMode.icon} ${activeMode.label}` : QUIET_MODE_HINT,
		cycleSuffix: activeMode && canCycleMode ? CYCLE_SUFFIX : null,
	})
	return (
		<Text wrap="truncate-end">
			{layout.mode ? (
				<Text color={activeMode ? activeMode.color : theme.text.muted}>{layout.mode}</Text>
			) : null}
			{layout.cycleSuffix ? <Text color={theme.text.muted}>{layout.cycleSuffix}</Text> : null}
			{layout.effort ? (
				<>
					<Text color={theme.text.muted}> · </Text>
					<Text color={theme.text.secondary}>{layout.effort}</Text>
				</>
			) : null}
			{layout.cwd ? (
				<>
					<Text color={theme.text.muted}> · </Text>
					<Text color={theme.text.secondary}>{layout.cwd}</Text>
				</>
			) : null}
			<Text>{layout.gap}</Text>
			{layout.right.kind === 'text' ? (
				<Text color={layout.right.isGoal ? theme.accent.system : colorForState(state)}>
					{layout.right.text}
				</Text>
			) : layout.right.model ? (
				<Text color={theme.text.primary} bold>
					{layout.right.model}
				</Text>
			) : null}
		</Text>
	)
}

function colorForState(state: StatusBarProps['state']): string {
	switch (state) {
		case 'idle':
			return theme.text.secondary
		case 'thinking':
			return theme.accent.system
		case 'tool':
		case 'awaiting-permission':
			return theme.status.warn
	}
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`
	}
	return cwd
}

/**
 * A path shortened from the LEFT, keeping the leaf.
 *
 * The end of a path is the informative end: `core` says which package you are
 * in, `/home` says nothing you did not know. Cutting resumes at a separator
 * when one is near the cut, so the result still reads as a path rather than as
 * a word broken in half.
 */
export function shortenPathToFit(path: string, max: number): string {
	if (max <= 0) return ''
	if (path.length <= max) return path
	if (max === 1) return '…'
	const tail = path.slice(-(max - 1))
	const slash = tail.indexOf('/')
	// Only snap to a separator if one is close, or a long leading segment would
	// cost more than it explains.
	const snapped = slash >= 0 && slash <= 12 ? tail.slice(slash) : tail
	return `…${snapped}`
}

export interface StatusLineLayout {
	readonly mode: string | null
	readonly cycleSuffix: string | null
	readonly effort: string | null
	readonly cwd: string | null
	readonly gap: string
	readonly right:
		| { readonly kind: 'text'; readonly text: string; readonly isGoal: boolean }
		| { readonly kind: 'model'; readonly model: string | null }
}

/**
 * Fit the mode identity around an authoritative right-side indicator.
 *
 * A hint can be the only on-screen explanation of how to leave a prompt, and
 * a goal label is the durable work state the screenshot is meant to expose.
 * Both therefore reserve their width before the model identity does, exactly
 * as they did before the model moved to this side. On the left, the mode
 * badge is the whole point of this line and yields last: the working
 * directory shrinks and drops first — a path is recoverable from `/status`
 * and a deep worktree checkout should not be what costs the operator their
 * only advertisement of Shift+Tab — then the effort label, then the cycle
 * key reminder, then the model on the right is dropped entirely, and only
 * then does the badge itself truncate.
 */
export function fitStatusLine(input: {
	readonly columns: number
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	/** Session orchestrate mode. Shown beside `effort`, and alone (never as a fabricated effort value) when there is no effort to show it beside. */
	readonly orchestrate?: boolean
	readonly hint?: string | undefined
	readonly goal?: string | null | undefined
	readonly modeLabel: string
	readonly cycleSuffix?: string | null
}): StatusLineLayout {
	const columns = Math.max(0, input.columns)
	const isGoal = Boolean(input.goal) && !input.hint
	// `hint` can arrive as '' (no hint right now, as opposed to none ever
	// wired up) — `??` does not treat that as absent, and an empty string
	// would otherwise win the slot a model needs to fall through to.
	let rightText: string | null = input.hint || input.goal || null
	// Prefer the familiar Return symbol before cutting an action word in half.
	if (input.hint && rightText && rightText.length > columns) rightText = rightText.replace(/\benter\b/g, '↵')
	if (rightText !== null && rightText.length > columns) rightText = shortenRightToFit(rightText, columns)

	let modelLabel: string | null = input.model ?? input.provider
	const right = (): string => (rightText !== null ? rightText : (modelLabel ?? ''))

	let gapWidth = right().length > 0 ? 1 : 0
	let leftBudget = Math.max(0, columns - right().length - gapWidth)

	let mode: string | null = input.modeLabel
	let cycleSuffix: string | null = input.cycleSuffix ?? null
	// Orchestrate rides beside a real effort value ("effort high · orchestrate")
	// but never borrows the "effort" word on its own ("effort orchestrate"),
	// which would misread as a level a provider published.
	let effort: string | null = input.effort
		? `effort ${input.effort}${input.orchestrate ? ' · orchestrate' : ''}`
		: input.orchestrate
			? 'orchestrate'
			: null
	let cwd: string | null = input.cwd.length > 0 ? input.cwd : null

	const left = (): string => {
		const withMode = `${mode ?? ''}${cycleSuffix ?? ''}`
		const withEffort = [withMode, effort].filter((value): value is string => Boolean(value)).join(' · ')
		return [withEffort, cwd].filter((value): value is string => Boolean(value)).join(' · ')
	}

	if (left().length > leftBudget && cwd) {
		const identityWidth = left().length - (cwd.length + 3)
		const room = leftBudget - identityWidth - 3
		cwd = room >= 8 ? shortenPathToFit(cwd, room) : null
	}
	if (left().length > leftBudget) cwd = null
	if (left().length > leftBudget) effort = null
	if (left().length > leftBudget) cycleSuffix = null
	if (left().length > leftBudget && rightText === null && modelLabel !== null) {
		// The model is the least essential fact once the mode line needs the
		// room: it is recoverable from `/status`, and the mode is not.
		modelLabel = null
		gapWidth = 0
		leftBudget = columns
	}
	if (left().length > leftBudget && mode) {
		mode = shortenRightToFit(mode, leftBudget)
	}
	if (left().length > leftBudget) mode = null

	const leftWidth = left().length
	const rightWidth = right().length
	const visibleGap = leftWidth > 0 && rightWidth > 0 ? 1 : 0
	const gap = ' '.repeat(Math.max(visibleGap, columns - leftWidth - rightWidth))

	return {
		mode,
		cycleSuffix: mode ? cycleSuffix : null,
		effort: mode ? effort : null,
		cwd,
		gap,
		right:
			rightText !== null
				? { kind: 'text', text: rightText, isGoal }
				: { kind: 'model', model: modelLabel },
	}
}

/** Preserve both the status identity and its trailing key/action on tiny screens. */
function shortenRightToFit(value: string, max: number): string {
	if (max <= 0) return ''
	if (value.length <= max) return value
	if (max === 1) return '…'
	const available = max - 1
	const head = Math.ceil(available * 0.45)
	return `${value.slice(0, head)}…${value.slice(-(available - head))}`
}
