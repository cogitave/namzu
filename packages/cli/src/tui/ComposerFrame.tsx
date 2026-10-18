import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout, useWindowSize } from 'ink'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { theme } from './theme.js'

const HYPERMODE_GLOW_MS = 880
const HYPERMODE_GLOW_COLORS = ['ansi256(183)', theme.accent.hypermode, 'ansi256(97)'] as const

/**
 * The composer's frame: a plain horizontal rule above and below the input and
 * nothing at the sides, no corners and no title, as the reference draws it.
 * Its content stays mounted while another prompt owns focus. The one thing
 * written on a rule is the session mode (today only `hypermode`), at the right
 * end of the upper one.
 */
export function ComposerFrame({
	hidden = false,
	mode,
	columns,
	activation = 0,
	animate = true,
	children,
}: {
	/** Kept for the callers that say whether the input owns the keyboard; the rules look the same either way. */
	readonly focus?: boolean
	readonly hidden?: boolean
	readonly working?: boolean
	readonly animate?: boolean
	/**
	 * A session mode named on the frame's upper right — today only `hypermode`.
	 */
	readonly mode?: string
	/** The frame's actual width, excluding a parent's horizontal padding. */
	readonly columns?: number
	/** Increment only when the operator successfully turns the session mode on. */
	readonly activation?: number
	readonly children: ReactNode
}) {
	const terminal = useWindowSize()
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	const frameColumns = Math.max(2, columns ?? terminal.columns ?? 80)
	// Only a frame too narrow to hold the complete word omits it.
	const showMode = mode !== undefined && frameColumns >= mode.length + 5
	const ruleColumns = Math.max(1, frameColumns - (showMode ? mode.length + 3 : 0))
	// A pulse needs a rule long enough to have a visible center.
	const motion = animate && stdout.isTTY === true && !screenReader && showMode && colourAllowed()
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
		if (igniting && (time >= HYPERMODE_GLOW_MS || !motion || hidden)) setIgniting(false)
	}, [hidden, igniting, motion, time])
	const glowTime = igniting && motion && !hidden && time < HYPERMODE_GLOW_MS ? time : undefined
	return (
		<Box flexDirection="column" width={frameColumns} marginTop={hidden ? 0 : 1}>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				{glowTime !== undefined ? <GlowRule columns={ruleColumns} time={glowTime} /> : <Rule />}
				{showMode ? (
					<Box flexShrink={0}>
						<Text color={theme.accent.hypermode} bold>
							{' '}
							{mode}{' '}
						</Text>
						<Text color={theme.border.default}>─</Text>
					</Box>
				) : null}
			</Box>
			<Box flexDirection="column">{children}</Box>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Rule />
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
 * A single violet/lavender pulse travels from the rule's center toward both
 * ends. The settled rule is plain graphite, so no colour cycles behind a draft.
 */
function GlowRule({
	columns,
	time,
}: {
	readonly columns: number
	readonly time: number
}) {
	const cells = Math.max(1, columns)
	const center = (cells - 1) / 2
	const radius = 1 + (time / HYPERMODE_GLOW_MS) * (center + 9)
	return (
		<Box flexGrow={1} flexBasis={0} minWidth={0} height={1} overflow="hidden">
			<Text wrap="wrap">
				{Array.from({ length: cells }, (_, index) => {
					const trail = radius - Math.abs(index - center)
					const color =
						trail >= 0 && trail < 2
							? HYPERMODE_GLOW_COLORS[0]
							: trail >= 2 && trail < 5
								? HYPERMODE_GLOW_COLORS[1]
								: trail >= 5 && trail < 9
									? HYPERMODE_GLOW_COLORS[2]
									: theme.border.default
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

/** The pulse is decoration; wherever colour is refused, the plain rule is drawn instead. */
function colourAllowed(): boolean {
	return (
		process.env.NO_COLOR === undefined &&
		process.env.FORCE_COLOR !== '0' &&
		process.env.TERM !== 'dumb'
	)
}
