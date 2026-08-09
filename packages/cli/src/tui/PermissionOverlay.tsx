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
			{/* Every key that decides this prompt, and what each one decides.
			    `Ctrl+C` was missing, and it is the only one with a DIFFERENT
			    outcome: `n` and `esc` decline this batch and the turn carries on
			    trying something else, while `Ctrl+C` ends the turn. So someone
			    who wanted namzu to stop pressed `n`, watched it continue, and had
			    no way to learn otherwise from this screen — the distinction was
			    written down only in `docs/cli/tools.md`.

			    Two rows rather than one: at four keys the line wraps on a narrow
			    terminal and wraps mid-key, and this is the box an operator reads
			    while deciding. Grouped by outcome, so the reading is "these two
			    let it continue, this one does not" rather than a list of four
			    equals. The status bar keeps the compact three-key echo — it is
			    budget-constrained by construction and this box is on screen
			    whenever it applies. */}
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					<Text color={theme.status.ok} bold>
						y
					</Text>{' '}
					approve ·{' '}
					<Text color={theme.accent.user} bold>
						a
					</Text>{' '}
					approve all for this session
				</Text>
				<Text color={theme.text.muted}>
					<Text color={theme.status.error} bold>
						n
					</Text>{' '}
					or{' '}
					<Text color={theme.status.error} bold>
						esc
					</Text>{' '}
					decline, and the agent tries something else ·{' '}
					<Text color={theme.status.error} bold>
						ctrl+c
					</Text>{' '}
					decline and stop the turn
				</Text>
			</Box>
		</Box>
	)
}
