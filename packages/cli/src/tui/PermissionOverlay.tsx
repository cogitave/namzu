/**
 * Tool-permission overlay. Shown when the agent wants to run a
 * non-read-only tool batch. Lists each proposed call with a one-line
 * summary, and for `edit`/`write` a compact diff/content preview, then
 * waits for Approve (y) / Reject (n) / Approve-all (a). The parent (App)
 * owns the keypress handling and resolves the pending decision; this
 * component is presentational.
 */

import { Box, Text } from 'ink'

import type { PermissionToolCall } from './agent.js'
import { theme } from './theme.js'

export interface PermissionOverlayProps {
	readonly toolCalls: readonly PermissionToolCall[]
}

function previewColor(line: string): string {
	if (line.startsWith('+')) return theme.status.ok
	if (line.startsWith('-')) return theme.status.error
	return theme.text.muted
}

export function PermissionOverlay({ toolCalls }: PermissionOverlayProps) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Text color={theme.status.warn} bold>
				⚠ namzu wants to run {toolCalls.length === 1 ? 'a tool' : `${toolCalls.length} tools`}
			</Text>
			<Box flexDirection="column" paddingTop={1}>
				{toolCalls.map((tc) => (
					<Box key={tc.id} flexDirection="column" paddingBottom={1}>
						<Text>
							<Text color={theme.accent.tool} bold>
								⚙ {tc.name}
							</Text>
							<Text color={theme.text.secondary}> {tc.summary}</Text>
							{tc.isDestructive ? <Text color={theme.status.error}> (destructive)</Text> : null}
						</Text>
						{tc.preview && tc.preview.length > 0 ? (
							<Box flexDirection="column" paddingLeft={2}>
								{tc.preview.map((line, i) => (
									<Text key={`${tc.id}-${i}`} color={previewColor(line)}>
										{line}
									</Text>
								))}
							</Box>
						) : null}
					</Box>
				))}
			</Box>
			<Box>
				<Text color={theme.text.muted}>
					<Text color={theme.status.ok} bold>
						y
					</Text>{' '}
					approve ·{' '}
					<Text color={theme.status.error} bold>
						n
					</Text>{' '}
					reject ·{' '}
					<Text color={theme.accent.user} bold>
						a
					</Text>{' '}
					approve all for this session
				</Text>
			</Box>
		</Box>
	)
}
