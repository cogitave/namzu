/**
 * One-line status footer.
 *
 * Layout: `cwd · provider · model · state    hint` (provider/model elided
 * when null). A `│` divider separates the metadata cluster from the hint
 * so the eye can find the help-text without parsing the whole line.
 */

import { Box, Text } from 'ink'

import { theme } from './theme.js'

export interface StatusBarProps {
	readonly cwd: string
	readonly provider: string | null
	readonly model: string | null
	readonly state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission'
	readonly hint?: string
}

export function StatusBar({ cwd, provider, model, state, hint }: StatusBarProps) {
	const segments: string[] = [shortenCwd(cwd)]
	if (provider) segments.push(provider)
	if (model) segments.push(model)
	const stateLabel = stateGlyph(state)
	return (
		<Box>
			<Text color={theme.text.muted}>{segments.join(' · ')}</Text>
			<Text color={theme.text.muted}> │ </Text>
			<Text color={colorForState(state)}>{stateLabel}</Text>
			{hint ? (
				<>
					<Text color={theme.text.muted}> │ </Text>
					<Text color={theme.text.secondary}>{hint}</Text>
				</>
			) : null}
		</Box>
	)
}

function stateGlyph(state: StatusBarProps['state']): string {
	switch (state) {
		case 'idle':
			return '● idle'
		case 'thinking':
			return '◐ thinking'
		case 'tool':
			return '◑ tool'
		case 'awaiting-permission':
			return '◓ approve?'
	}
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
