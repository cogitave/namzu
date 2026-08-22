import { Box, Text } from 'ink'

import type { CopyResponseTarget } from './copy-targets.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export interface CopyPickerProps {
	readonly targets: readonly CopyResponseTarget[]
	readonly selected: number
}

/** Source-target chooser; App owns keys, clipboard output and queue admission. */
export function CopyPicker({ targets, selected }: CopyPickerProps) {
	const windowSize = 7
	const start = Math.max(0, Math.min(selected - 3, targets.length - windowSize))
	const visible = targets.slice(start, start + windowSize)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.border.focus}
			paddingX={1}
		>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					Copy from response
				</Text>
				<Text color={theme.text.muted}>
					{selected + 1}/{targets.length}
				</Text>
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				{visible.map((target, visibleIndex) => {
					const index = start + visibleIndex
					return (
						<Box key={`${target.kind}-${index}`}>
							<Box width={4} flexShrink={0}>
								<Text color={theme.accent.user}>
									{index === selected ? '›' : ' '}
									{index < 9 ? `${index + 1}.` : '  '}
								</Text>
							</Box>
							<Box width={22} flexShrink={0}>
								<Text
									color={index === selected ? theme.text.primary : theme.text.secondary}
									bold={index === selected}
									wrap="truncate-end"
								>
									{terminalDisplayText(target.label)}
								</Text>
							</Box>
							<Box flexGrow={1}>
								<Text color={theme.text.muted} wrap="truncate-end">
									{preview(target.text)}
								</Text>
							</Box>
						</Box>
					)
				})}
			</Box>
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					↑↓ navigate · 1–9 select · enter send request · esc cancel
				</Text>
			</Box>
		</Box>
	)
}

function preview(source: string): string {
	const safe = terminalDisplayText(source)
	const first = safe.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '(empty)'
	return [...first].slice(0, 72).join('')
}
