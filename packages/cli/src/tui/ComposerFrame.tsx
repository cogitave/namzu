import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout, useWindowSize } from 'ink'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { HYPERMODE_RULE_COLORS, theme } from './theme.js'

const HYPERMODE_RULE_MIN_COLUMNS = 40
const HYPERMODE_IGNITION_MS = 1_200
const HYPERMODE_IGNITION_COLORS = [
	'ansi256(231)',
	'ansi256(225)',
	'ansi256(219)',
	'ansi256(177)',
	'ansi256(141)',
	'ansi256(105)',
	'ansi256(63)',
] as const

/** A bounded command frame; its content stays mounted while another prompt owns focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	mode,
	activation = 0,
	animate = true,
	children,
}: {
	readonly focus: boolean
	readonly hidden?: boolean
	readonly working?: boolean
	readonly animate?: boolean
	/**
	 * A session mode with a coloured top rule — today only `hypermode`. The
	 * footer names it once; the border never repeats the label.
	 */
	readonly mode?: string
	/** Increment only when the operator successfully turns the session mode on. */
	readonly activation?: number
	readonly children: ReactNode
}) {
	const terminal = useWindowSize()
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	const accent = focus ? theme.border.focus : theme.text.muted
	const gradient =
		mode !== undefined && (terminal.columns ?? 80) >= HYPERMODE_RULE_MIN_COLUMNS && colourAllowed()
	const motion = animate && stdout.isTTY === true && !screenReader && gradient
	const [igniting, setIgniting] = useState(false)
	const previousActivation = useRef(activation)
	const { time, reset } = useAnimation({
		isActive: igniting && motion && !hidden,
		interval: 80,
	})
	useEffect(() => {
		if (previousActivation.current === activation) return
		previousActivation.current = activation
		if (motion && !hidden) {
			reset()
			setIgniting(true)
		} else setIgniting(false)
	}, [activation, hidden, motion, reset])
	useEffect(() => {
		if (igniting && (time >= HYPERMODE_IGNITION_MS || !motion || hidden)) setIgniting(false)
	}, [hidden, igniting, motion, time])
	const ignitionTime = igniting && time < HYPERMODE_IGNITION_MS ? time : undefined
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
				{gradient ? (
					<GradientRule columns={terminal.columns ?? 80} ignitionTime={ignitionTime} />
				) : (
					<Rule />
				)}
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
 * The top rule in a colour run. Yoga still sizes it: the text is a run
 * of `─` at least as long as the terminal is wide, hard-wrapped by the layout
 * and clipped to one row, so no width is computed here that could disagree
 * with the box's own.
 */
function GradientRule({
	columns,
	ignitionTime,
}: {
	readonly columns: number
	readonly ignitionTime?: number
}) {
	const cells = Math.max(1, columns)
	const sweep =
		ignitionTime === undefined
			? null
			: Math.floor((ignitionTime / HYPERMODE_IGNITION_MS) * (cells + 12)) - 6
	return (
		<Box flexGrow={1} flexBasis={0} minWidth={0} height={1} overflow="hidden">
			<Text wrap="wrap">
				{Array.from({ length: cells }, (_, index) => {
					const trail = sweep === null ? -1 : sweep - index
					const color =
						trail >= 0 && trail < HYPERMODE_IGNITION_COLORS.length
							? HYPERMODE_IGNITION_COLORS[trail]
							: HYPERMODE_RULE_COLORS[index % HYPERMODE_RULE_COLORS.length]
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: one fixed cell per column; nothing reorders.
						<Text key={index} color={color}>
							─
						</Text>
					)
				})}
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
