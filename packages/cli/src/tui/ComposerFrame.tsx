import { Box, Text, useWindowSize } from 'ink'
import type { ReactNode } from 'react'

import { ORCHESTRATE_RULE_COLORS, theme } from './theme.js'

/** Below this many columns the mode tag leaves the border whole; the footer still names the mode. */
export const COMPOSER_MODE_TAG_MIN_COLUMNS = 40

/** A bounded command frame; its content stays mounted while another prompt owns focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	mode,
	children,
}: {
	readonly focus: boolean
	readonly hidden?: boolean
	readonly working?: boolean
	readonly animate?: boolean
	/**
	 * A session mode to name on the top border's right, in its own colour —
	 * today only `orchestrate`. The run of `─` before it takes a still colour
	 * gradient where colour is available, so the mode is visible where the
	 * operator is looking without spending a row.
	 */
	readonly mode?: string
	readonly children: ReactNode
}) {
	const terminal = useWindowSize()
	const accent = focus ? theme.border.focus : theme.text.muted
	const showMode = mode !== undefined && (terminal.columns ?? 80) >= COMPOSER_MODE_TAG_MIN_COLUMNS
	const gradient = showMode && colourAllowed()
	return (
		<Box position="relative" flexDirection="column" marginTop={hidden ? 0 : 1}>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Box flexShrink={0}>
					<Text color={accent}>┌</Text>
				</Box>
				{/* The caption yields to narrow widths while both corners stay fixed. */}
				<Box minWidth={0}>
					<Text color={accent} wrap="truncate-end">
						─ <Text bold>MESSAGE</Text>{' '}
					</Text>
				</Box>
				{gradient ? <GradientRule columns={terminal.columns ?? 80} /> : <Rule />}
				{showMode ? (
					<Box flexShrink={0}>
						<Text color={theme.accent.orchestrate} bold>
							{' '}
							{mode}{' '}
						</Text>
						<Text color={gradient ? ORCHESTRATE_RULE_COLORS.at(-1) : theme.border.default}>─</Text>
					</Box>
				) : null}
				<Box flexShrink={0}>
					<Text color={accent}>┐</Text>
				</Box>
			</Box>
			<Box
				flexDirection="column"
				{...(hidden ? {} : { borderStyle: 'single' as const })}
				borderTop={false}
				borderBottom={false}
				borderLeft={!hidden}
				borderRight={!hidden}
				borderColor={theme.border.default}
			>
				{children}
			</Box>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Box flexShrink={0}>
					<Text color={accent}>└</Text>
				</Box>
				<Box minWidth={0}>
					<Text color={accent} wrap="truncate-end">
						─
					</Text>
				</Box>
				<Rule />
				<Box flexShrink={0}>
					<Text color={accent}>┘</Text>
				</Box>
			</Box>
		</Box>
	)
}

/** Yoga sizes the rule; a repeated text string would truncate with an ellipsis. */
function Rule() {
	return (
		<Box
			flexGrow={1}
			minWidth={0}
			height={1}
			borderStyle="single"
			borderBottom={false}
			borderLeft={false}
			borderRight={false}
			borderColor={theme.border.default}
		/>
	)
}

/**
 * The top rule in a still colour run. Yoga still sizes it: the text is a run
 * of `─` at least as long as the terminal is wide, hard-wrapped by the layout
 * and clipped to one row, so no width is computed here that could disagree
 * with the box's own.
 */
function GradientRule({ columns }: { readonly columns: number }) {
	const cells = Math.max(1, columns)
	return (
		<Box flexGrow={1} flexBasis={0} minWidth={0} height={1} overflow="hidden">
			<Text wrap="wrap">
				{Array.from({ length: cells }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: one cell per column; nothing reorders.
					<Text key={index} color={ORCHESTRATE_RULE_COLORS[index % ORCHESTRATE_RULE_COLORS.length]}>
						─
					</Text>
				))}
			</Text>
		</Box>
	)
}

/** The gradient is decoration; wherever colour is refused, the plain rule is drawn instead. */
function colourAllowed(): boolean {
	return (
		process.env.NO_COLOR === undefined &&
		process.env.FORCE_COLOR !== '0' &&
		process.env.TERM !== 'dumb'
	)
}
