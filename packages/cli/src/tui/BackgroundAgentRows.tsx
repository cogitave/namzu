/**
 * The two live rows background work adds above the composer: the live group of
 * a batch the turn is waiting on (`Running 3 agents…`), and, once the turn is
 * over, the dim line naming what it still waits for. Data comes from
 * `background-agents.ts`; this only draws it.
 */

import { Box, Text } from 'ink'

import type { RunningGroup } from './background-agents.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export function BackgroundAgentRows(props: {
	readonly groups: readonly RunningGroup[]
	readonly waitLine: string | undefined
	readonly glyph: string
}) {
	const { groups, waitLine, glyph } = props
	if (groups.length === 0 && waitLine === undefined) return null
	return (
		<Box flexDirection="column">
			{groups.map((group, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: groups carry no id and are replaced whole.
				<Box key={index} flexDirection="column">
					<Text color={theme.text.secondary}>{group.header}</Text>
					{group.agents.map((agent, position) => {
						const last = position === group.agents.length - 1
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: one fixed row per batch member.
							<Box key={position} flexDirection="column" paddingLeft={2}>
								<Text color={theme.text.secondary} wrap="truncate-end">
									{last ? '└ ' : '├ '}
									{terminalDisplayText(agent.line)}
								</Text>
								<Text color={theme.text.muted} wrap="truncate-end">
									{last ? '  ' : '│ '}⎿ {terminalDisplayText(agent.status)}
								</Text>
							</Box>
						)
					})}
				</Box>
			))}
			{waitLine !== undefined ? (
				<Text color={theme.text.muted}>
					{glyph} {waitLine}
				</Text>
			) : null}
		</Box>
	)
}
