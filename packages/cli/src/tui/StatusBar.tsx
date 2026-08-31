/**
 * One-line status footer.
 *
 * Layout follows the operator's reading order: `model effort · cwd` on the
 * left, current goal or interaction status on the right. The right side owns
 * its columns first so a deep path cannot erase the key that exits a prompt.
 */

import { Text, useWindowSize } from 'ink'

import { theme } from './theme.js'

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	/** Ambient durable goal status; interaction hints take precedence. */
	readonly goal?: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
}

export function StatusBar({ cwd, provider, model, effort, goal, state, hint }: StatusBarProps) {
	const terminal = useWindowSize()
	const layout = fitStatusLine({
		// App gives the footer one cell of horizontal padding on each side. Ink's
		// stdout width is the whole terminal, so reserve those cells here rather
		// than letting its final two characters be clipped after fitting succeeds.
		columns: Math.max(0, terminal.columns - 2),
		cwd: shortenCwd(cwd),
		provider,
		model,
		effort: model ? (effort ?? 'default') : null,
		hint,
		goal,
	})
	return (
		<Text wrap="truncate-end">
			{layout.primary ? (
				<Text color={theme.status.warn} bold>
					{layout.primary}
				</Text>
			) : null}
			{layout.effort ? <Text color={theme.text.secondary}> {layout.effort}</Text> : null}
			{layout.cwd ? (
				<>
					{layout.primary ? <Text color={theme.text.muted}> · </Text> : null}
					<Text color={theme.status.ok}>{layout.cwd}</Text>
				</>
			) : null}
			<Text>{layout.gap}</Text>
			<Text color={goal && !hint ? theme.accent.system : colorForState(state)}>{layout.right}</Text>
		</Text>
	)
}

function colorForState(state: StatusBarProps['state']): string {
	switch (state) {
		case 'idle':
			return theme.status.ok
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
	readonly primary: string | null
	readonly effort: string | null
	readonly cwd: string | null
	readonly gap: string
	readonly right: string
}

/**
 * Fit the left identity around an authoritative right-side indicator.
 *
 * A hint can be the only on-screen explanation of how to leave a prompt, and
 * a goal label is the durable work state the screenshot is meant to expose.
 * Both therefore reserve their width before a path does. The path shortens
 * from the left; effort then yields; the model is the last left-side fact.
 */
export function fitStatusLine(input: {
	readonly columns: number
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly effort?: string | null
	readonly hint?: string | undefined
	readonly goal?: string | null | undefined
}): StatusLineLayout {
	const columns = Math.max(0, input.columns)
	let right = input.hint ?? input.goal ?? ''
	if (right.length > columns) right = shortenRightToFit(right, columns)

	const primarySource = input.model ?? input.provider
	let primary = primarySource
	let effort = primary && input.model ? (input.effort ?? null) : null
	let cwd: string | null = input.cwd.length > 0 ? input.cwd : null
	const gapWidth = right.length > 0 ? 1 : 0
	const leftBudget = Math.max(0, columns - right.length - gapWidth)

	const left = (): string => {
		const identity = [primary, effort].filter((value): value is string => Boolean(value)).join(' ')
		return [identity, cwd].filter((value): value is string => Boolean(value)).join(' · ')
	}

	if (left().length > leftBudget && cwd) {
		const identityWidth = [primary, effort]
			.filter((value): value is string => Boolean(value))
			.join(' ').length
		const room = leftBudget - identityWidth - (identityWidth > 0 ? 3 : 0)
		cwd = room >= 8 ? shortenPathToFit(cwd, room) : null
	}
	if (left().length > leftBudget) effort = null
	if (left().length > leftBudget) cwd = null
	if (left().length > leftBudget && primary) {
		primary = shortenRightToFit(primary, leftBudget)
	}
	if (left().length > leftBudget) primary = null

	const leftWidth = left().length
	const visibleGap = leftWidth > 0 && right.length > 0 ? 1 : 0
	const gap = ' '.repeat(Math.max(visibleGap, columns - leftWidth - right.length))
	return { primary, effort, cwd, gap, right }
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
