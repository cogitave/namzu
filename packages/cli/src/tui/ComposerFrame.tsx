import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout, useWindowSize } from 'ink'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { theme } from './theme.js'

const HYPERMODE_GLOW_MS = 880
const HYPERMODE_GLOW_COLORS = ['ansi256(183)', theme.accent.hypermode, 'ansi256(97)'] as const
const MESSAGE_CAPTION_COLUMNS = 10

/** A bounded command frame; its content stays mounted while another prompt owns focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	mode,
	columns,
	activation = 0,
	animate = true,
	children,
}: {
	readonly focus: boolean
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
	const accent = focus ? theme.border.focus : theme.text.muted
	const frameColumns = Math.max(2, columns ?? terminal.columns ?? 80)
	// Keep the mode visible on small screens by giving its label the caption's
	// space. Only a frame too narrow to hold the complete word omits it.
	const showMode = mode !== undefined && frameColumns >= mode.length + 7
	const showCaption = !showMode || frameColumns >= 28
	const ruleColumns = Math.max(
		1,
		frameColumns - 2 - (showCaption ? MESSAGE_CAPTION_COLUMNS : 0) - (showMode ? mode.length + 3 : 0),
	)
	// Below this width the caption yields its space to the label, leaving the
	// rule on the left of the input center. A pulse there would appear off-center.
	const motion =
		animate && stdout.isTTY === true && !screenReader && showMode && showCaption && colourAllowed()
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
		<Box position="relative" flexDirection="column" width={frameColumns} marginTop={hidden ? 0 : 1}>
			<Box display={hidden ? 'none' : 'flex'} height={1} flexShrink={0}>
				<Box flexShrink={0}>
					<Text color={accent}>┌</Text>
				</Box>
				{showCaption ? (
					<Box minWidth={0}>
						<Text color={accent} wrap="truncate-end">
							─ <Text bold>MESSAGE</Text>{' '}
						</Text>
					</Box>
				) : null}
				{glowTime !== undefined ? (
					<GlowRule columns={ruleColumns} time={glowTime} />
				) : (
					<Rule />
				)}
				{showMode ? (
					<Box flexShrink={0}>
						<Text color={theme.accent.hypermode} bold>
							{' '}{mode}{' '}
						</Text>
						<Text color={theme.border.default}>─</Text>
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
