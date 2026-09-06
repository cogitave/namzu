import {
	Box,
	type DOMElement,
	Text,
	measureElement,
	useAnimation,
	useIsScreenReaderEnabled,
	useStdout,
} from 'ink'
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'

import { theme } from './theme.js'

/** A bounded command frame; its content stays mounted while another prompt owns focus. */
export function ComposerFrame({
	focus,
	hidden = false,
	working = false,
	animate = true,
	children,
}: {
	readonly focus: boolean
	readonly hidden?: boolean
	readonly working?: boolean
	readonly animate?: boolean
	readonly children: ReactNode
}) {
	const frame = useRef<DOMElement>(null)
	const accent = focus ? theme.border.focus : theme.text.muted
	return (
		<Box ref={frame} position="relative" flexDirection="column" marginTop={hidden ? 0 : 1}>
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
				<Rule />
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
			<FrameShimmer frame={frame} active={working && focus && !hidden && animate} />
		</Box>
	)
}

// A pale leading edge fades through green into the frame's dark surroundings.
const SHIMMER_COLORS = [194, 120, 83, 77, 40, 34, 28, 22] as const

/** Paint only border cells. Animation updates never render the input or transcript. */
function FrameShimmer({
	frame,
	active,
}: {
	readonly frame: RefObject<DOMElement | null>
	readonly active: boolean
}) {
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	const enabled =
		active &&
		stdout.isTTY === true &&
		!screenReader &&
		!process.env.NO_COLOR &&
		process.env.FORCE_COLOR !== '0' &&
		process.env.TERM !== 'dumb'
	const { time } = useAnimation({ interval: 80, isActive: enabled })
	const [size, setSize] = useState({ width: 0, height: 0 })
	// Re-measure after overlay commits. Bottom/right anchors below keep the light
	// on the border even when the draft wraps before the next animation tick.
	// The absolutely positioned light never contributes to the measured geometry.
	useLayoutEffect(() => {
		if (!enabled || !frame.current) return
		const { width, height } = measureElement(frame.current)
		setSize((previous) =>
			previous.width === width && previous.height === height ? previous : { width, height },
		)
	})
	if (!enabled || size.width < 12 || size.height < 3) return null

	const { width, height } = size
	// Terminal cells are approximately twice as tall as they are wide. Weight
	// vertical travel accordingly so the light does not jump around the corners.
	const horizontal = width - 1
	const vertical = 2 * (height - 1)
	const perimeter = 2 * (horizontal + vertical)
	const head = Math.floor((time / 1_000) * 40) % perimeter
	const length = Math.min(16, Math.floor(perimeter / 6))
	const cells = new Map<string, { x: number; y: number; glyph: string; color: number }>()
	for (let distance = 0; distance < length; distance += 1) {
		const position = (head - distance + perimeter) % perimeter
		let x: number
		let y: number
		if (position < horizontal) {
			x = position
			y = 0
		} else if (position < horizontal + vertical) {
			x = width - 1
			y = Math.floor((position - horizontal) / 2)
		} else if (position < 2 * horizontal + vertical) {
			x = width - 1 - (position - horizontal - vertical)
			y = height - 1
		} else {
			x = 0
			y = height - 1 - Math.floor((position - 2 * horizontal - vertical) / 2)
		}
		// Leave the MESSAGE label and its surrounding spaces steady.
		if (y === 0 && x >= 2 && x <= 10) continue
		const key = `${x},${y}`
		if (cells.has(key)) continue
		const glyph =
			y === 0
				? x === 0
					? '┌'
					: x === width - 1
						? '┐'
						: '─'
				: y === height - 1
					? x === 0
						? '└'
						: x === width - 1
							? '┘'
							: '─'
					: '│'
		const color =
			SHIMMER_COLORS[Math.floor((distance / (length - 1)) * (SHIMMER_COLORS.length - 1))] ?? 22
		cells.set(key, { x, y, glyph, color })
	}
	return (
		<Box position="absolute" top={0} bottom={0} left={0} right={0} overflow="hidden" aria-hidden>
			{[...cells].map(([key, cell]) => (
				<Box
					key={key}
					position="absolute"
					{...(cell.x === width - 1 ? { right: 0 } : { left: cell.x })}
					{...(cell.y === height - 1 ? { bottom: 0 } : { top: cell.y })}
					width={1}
					height={1}
				>
					<Text color={`ansi256(${cell.color})`}>{cell.glyph}</Text>
				</Box>
			))}
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
