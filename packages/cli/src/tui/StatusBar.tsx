/**
 * One-line composer footer, directly below the input box.
 *
 * Left to right, items joined by a dim ` · `: the permission mode (`⏵⏵ bypass
 * permissions on`, colored by mode, with its cycle key while it fits), the
 * pull request for the branch (`PR #592`, underlined, colored by review
 * state), the background-shell pill (`2 shells`), the reasoning effort when
 * the operator has set one, then the hints: `esc to interrupt` while a turn
 * runs, `← 2 agents` when the empty composer's left arrow opens them, and
 * `↓ to manage` when the empty composer's down arrow reaches the shells or
 * the agents rail. Right-aligned: an interaction hint or a durable goal when
 * either is active, else the model identity, which is Namzu's own addition
 * and the first thing to go when the row is narrow. The right side owns its
 * columns first so a long mode label cannot erase the key that exits a
 * prompt. The folder is not here; the header names it.
 */

import { Text, useWindowSize } from 'ink'

import type { PermissionMode } from '../permissions/mode.js'
import { fitHintText } from './key-hints.js'
import type { PrFooterState, PrReview } from './pr-status.js'
import { terminalWebHyperlink } from './terminal-hyperlinks.js'
import { theme } from './theme.js'

export interface StatusBarProps {
	readonly provider: string | null
	readonly model: string | null
	/** An explicit reasoning-effort override; omitted/undefined means the model's own default, which this footer does not name. */
	readonly effort?: string | null
	/** Ambient durable goal status; interaction hints take precedence. */
	readonly goal?: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
	/** The mode governing undecided tool calls. Omitted or 'prompt' shows the quiet cycle reminder instead of a badge. */
	readonly permissionMode?: PermissionMode
	/** Whether Shift+Tab actually reaches `permissionMode` here, so the footer never advertises a dead key. */
	readonly canCycleMode?: boolean
	/**
	 * Whether a composer is on screen. Shift+Tab is the composer's key, so with
	 * none mounted (a picker, the trust prompt, a stopped start) the footer
	 * names no cycle key; the active mode is still a fact.
	 */
	readonly composerMounted?: boolean
	/** Background shells that are running now; 0 or omitted hides the pill. */
	readonly shellCount?: number
	/** The pull request for the current branch, from `pr-status.ts`. */
	readonly pr?: PrFooterState
	/** Whether the terminal understands OSC 8 links; the PR number is plain text without it. */
	readonly hyperlinks?: boolean
	/**
	 * Agents that are running now, offered as `← N agents`. Pass 0 (or omit it)
	 * whenever `←` would not open them: input typed, a panel open, the rail focused.
	 */
	readonly agentCount?: number
	/** Whether `↓` from the empty composer reaches the shells or the agents rail; adds `↓ to manage`. */
	readonly canManage?: boolean
	/** The shell pill holds the keyboard: it is drawn inverted and `enter to view shells` replaces `↓ to manage`. */
	readonly shellsSelected?: boolean
}

/**
 * The mode marks. `⏵⏵` is outside the emoji set; the pause mark a plan mode
 * would pair with, `⏸` (U+23F8), is an emoji code point that Windows Terminal
 * draws as a blue two-cell tile. `‖` (U+2016, DOUBLE VERTICAL LINE) says "held"
 * in one text cell with no emoji form.
 */
export const MODE_MARK = { moving: '⏵⏵', held: '‖' } as const

/** Icon, color and words for an active (non-default) permission mode; the footer adds ` on`. */
function modeGlyph(mode: PermissionMode): {
	readonly icon: string
	readonly color: string
	readonly label: string
} {
	switch (mode) {
		case 'auto':
			return { icon: MODE_MARK.moving, color: theme.status.error, label: 'bypass permissions' }
		case 'accept-edits':
			return { icon: MODE_MARK.moving, color: theme.accent.user, label: 'accept edits' }
		case 'plan':
			return { icon: MODE_MARK.held, color: theme.accent.plan, label: 'plan mode' }
		case 'strict':
			return { icon: MODE_MARK.held, color: theme.status.warn, label: 'preapproved only' }
		case 'prompt':
			return { icon: MODE_MARK.held, color: theme.text.muted, label: 'ask first' }
	}
}

const QUIET_MODE_HINT = 'shift+tab to cycle'
const CYCLE_SUFFIX = ' (shift+tab to cycle)'
const INTERRUPT_HINT = 'esc to interrupt'
const MANAGE_HINT = '↓ to manage'
const VIEW_SHELLS_HINT = 'enter to view shells'

const PR_COLOR: Readonly<Record<PrReview, string | null>> = {
	approved: theme.status.ok,
	changes: theme.status.error,
	pending: theme.status.warn,
	merged: theme.status.merged,
	draft: null,
}

export function StatusBar({
	provider,
	model,
	effort,
	goal,
	state,
	hint,
	permissionMode,
	canCycleMode,
	composerMounted = true,
	shellCount = 0,
	pr,
	hyperlinks = false,
	agentCount = 0,
	canManage = false,
	shellsSelected = false,
}: StatusBarProps) {
	const terminal = useWindowSize()
	const activeMode =
		permissionMode !== undefined && permissionMode !== 'prompt' ? modeGlyph(permissionMode) : null
	const working = state !== 'idle'
	const hasPr = pr !== undefined && pr.kind !== 'none'
	// Nothing else on the row: only then is the quiet reminder worth a column.
	const nothingElse =
		!activeMode && shellCount === 0 && !hasPr && agentCount === 0 && !canManage && !shellsSelected
	const layout = fitStatusLine({
		// App gives the footer one cell of horizontal padding on each side. Ink's
		// stdout width is the whole terminal, so reserve those cells here rather
		// than letting its final two characters be clipped after fitting succeeds.
		columns: Math.max(0, terminal.columns - 2),
		model,
		provider,
		effort: effort ?? null,
		hint,
		goal,
		modeLabel: activeMode
			? `${activeMode.icon} ${activeMode.label} on`
			: composerMounted && !working && nothingElse
				? QUIET_MODE_HINT
				: '',
		// The reference drops the cycle key as soon as a background task is on
		// the row: the pill is what the row is about then.
		cycleSuffix:
			activeMode && canCycleMode && composerMounted && shellCount === 0 ? CYCLE_SUFFIX : null,
		interrupt: working && !hint ? INTERRUPT_HINT : null,
		shells: shellCount > 0 ? `${shellCount} ${shellCount === 1 ? 'shell' : 'shells'}` : null,
		agents:
			agentCount > 0
				? `← ${agentCount > 99 ? '99+' : agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`
				: null,
		manage: shellsSelected && shellCount > 0 ? VIEW_SHELLS_HINT : canManage ? MANAGE_HINT : null,
		pr:
			pr === undefined || pr.kind === 'none'
				? null
				: pr.kind === 'pr'
					? { prefix: 'PR', label: `#${pr.number}` }
					: { prefix: null, label: pr.text },
	})
	const sep = <Text color={theme.text.muted}> · </Text>
	const parts: React.ReactElement[] = []
	if (layout.mode) {
		parts.push(
			<Text key="mode">
				<Text color={activeMode ? activeMode.color : theme.text.muted}>{layout.mode}</Text>
				{layout.cycleSuffix ? <Text color={theme.text.muted}>{layout.cycleSuffix}</Text> : null}
			</Text>,
		)
	}
	if (layout.pr) {
		parts.push(
			<Text key="pr">
				{pr?.kind === 'pr' && layout.pr.prefix ? (
					<>
						<Text color={theme.text.muted}>{layout.pr.prefix} </Text>
						<PrLabel pr={pr} label={layout.pr.label} hyperlinks={hyperlinks} />
					</>
				) : (
					<Text color={theme.text.muted}>{layout.pr.label}</Text>
				)}
			</Text>,
		)
	}
	if (layout.shells) {
		parts.push(
			<Text key="shells" color={theme.accent.shells} inverse={shellsSelected}>
				{layout.shells}
			</Text>,
		)
	}
	if (layout.effort) {
		parts.push(
			<Text key="effort" color={theme.text.secondary}>
				{layout.effort}
			</Text>,
		)
	}
	if (layout.interrupt) {
		parts.push(
			<Text key="interrupt" color={theme.text.muted}>
				{layout.interrupt}
			</Text>,
		)
	}
	if (layout.agents) {
		parts.push(
			<Text key="agents" color={theme.text.muted}>
				{layout.agents}
			</Text>,
		)
	}
	if (layout.manage) {
		parts.push(
			<Text key="manage" color={theme.text.muted}>
				{layout.manage}
			</Text>,
		)
	}
	return (
		<Text wrap="truncate-end">
			{parts.flatMap((part, index) =>
				index === 0 ? [part] : [<Text key={`sep-${part.key}`}>{sep}</Text>, part],
			)}
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

function PrLabel({
	pr,
	label,
	hyperlinks,
}: {
	readonly pr: Extract<PrFooterState, { kind: 'pr' }>
	readonly label: string
	readonly hyperlinks: boolean
}) {
	const linked = hyperlinks ? terminalWebHyperlink(label, pr.url) : null
	return (
		<Text underline color={PR_COLOR[pr.review] ?? theme.text.muted}>
			{linked ?? label}
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

export interface StatusLineLayout {
	readonly mode: string | null
	readonly cycleSuffix: string | null
	readonly interrupt: string | null
	readonly shells: string | null
	readonly pr: { readonly prefix: string | null; readonly label: string } | null
	readonly effort: string | null
	readonly agents: string | null
	readonly manage: string | null
	readonly gap: string
	readonly right:
		| { readonly kind: 'text'; readonly text: string; readonly isGoal: boolean }
		| { readonly kind: 'model'; readonly model: string | null }
}

/**
 * Fit the footer's items around an authoritative right-side indicator.
 *
 * A hint can be the only on-screen explanation of how to leave a prompt, and
 * a goal label is the durable work state, so both reserve their width before
 * the model identity does. The model is Namzu's own addition and shows only
 * while the whole row fits beside it. Past that the row loses items from its
 * right end, the way the reference's clipped row does: `↓ to manage`,
 * `← N agents`, `esc to interrupt`, then the cycle key (the reference hides
 * it first once a task is running), the effort label, the shell pill, the
 * pull request item; after that the quiet reminder goes, then the mode
 * truncates, and last of all it goes. A line too wide for its room loses
 * whole items, never half of one, except the mode, which is the state itself.
 */
export function fitStatusLine(input: {
	readonly columns: number
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	readonly hint?: string | undefined
	readonly goal?: string | null | undefined
	readonly modeLabel: string
	readonly cycleSuffix?: string | null
	readonly interrupt?: string | null
	readonly shells?: string | null
	readonly agents?: string | null
	readonly manage?: string | null
	readonly pr?: { readonly prefix: string | null; readonly label: string } | null
}): StatusLineLayout {
	const columns = Math.max(0, input.columns)
	const isGoal = Boolean(input.goal) && !input.hint
	// `hint` can arrive as '' (no hint right now, as opposed to none ever
	// wired up) — `??` does not treat that as absent, and an empty string
	// would otherwise win the slot a model needs to fall through to.
	let rightText: string | null = input.hint || input.goal || null
	// A line too wide for its room loses whole hints, never half of one.
	if (rightText !== null) rightText = fitHintText(rightText, columns)

	let modelLabel: string | null = input.model ?? input.provider
	const right = (): string => (rightText !== null ? rightText : (modelLabel ?? ''))

	let gapWidth = right().length > 0 ? 1 : 0
	let leftBudget = Math.max(0, columns - right().length - gapWidth)

	let mode: string | null = input.modeLabel.length > 0 ? input.modeLabel : null
	let cycleSuffix: string | null = input.cycleSuffix ?? null
	let interrupt: string | null = input.interrupt ?? null
	let shells: string | null = input.shells ?? null
	let agents: string | null = input.agents ?? null
	let manage: string | null = input.manage ?? null
	let pr = input.pr ?? null
	let effort: string | null = input.effort ? `effort ${input.effort}` : null

	const parts = (): string[] =>
		[
			mode ? `${mode}${cycleSuffix ?? ''}` : null,
			pr ? `${pr.prefix ? `${pr.prefix} ` : ''}${pr.label}` : null,
			shells,
			effort,
			interrupt,
			agents,
			manage,
		].filter((value): value is string => Boolean(value))
	const left = (): string => parts().join(' · ')
	const over = (): boolean => left().length > leftBudget

	if (over() && rightText === null && modelLabel !== null) {
		// The model is recoverable from `/status`; nothing on the left is.
		modelLabel = null
		gapWidth = 0
		leftBudget = columns
	}
	if (over()) manage = null
	if (over()) agents = null
	if (over()) interrupt = null
	if (over()) cycleSuffix = null
	if (over()) effort = null
	if (over()) shells = null
	if (over()) pr = null
	// The quiet reminder is only a reminder: cut in half it reads as "shift…cycle".
	if (over() && mode === QUIET_MODE_HINT) mode = null
	if (over() && mode) {
		const whole: string = mode
		mode = null
		const rest = left().length
		const room = leftBudget - rest - (rest > 0 ? 3 : 0)
		mode = room >= 4 ? shortenRightToFit(whole, room) : null
	}
	if (over()) mode = null

	const leftWidth = left().length
	const rightWidth = right().length
	const visibleGap = leftWidth > 0 && rightWidth > 0 ? 1 : 0
	const gap = ' '.repeat(Math.max(visibleGap, columns - leftWidth - rightWidth))

	return {
		mode,
		cycleSuffix: mode ? cycleSuffix : null,
		interrupt,
		shells,
		pr,
		effort,
		agents,
		manage,
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
