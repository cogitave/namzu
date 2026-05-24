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
	readonly usage?: { totalTokens: number; costUsd: number } | null
}

export function StatusBar({ cwd, provider, model, state, hint, usage }: StatusBarProps) {
	const segments: string[] = [shortenCwd(cwd)]
	if (provider) segments.push(provider)
	if (model) segments.push(model)
	if (usage && usage.totalTokens > 0) segments.push(formatUsage(usage))
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

function formatUsage(usage: { totalTokens: number; costUsd: number }): string {
	const tok =
		usage.totalTokens >= 1000
			? `${(usage.totalTokens / 1000).toFixed(1)}k tok`
			: `${usage.totalTokens} tok`
	return usage.costUsd > 0 ? `${tok} · $${usage.costUsd.toFixed(2)}` : tok
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`
	}
	return cwd
}
