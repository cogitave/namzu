/**
 * One-line bottom status: cwd · provider · model · agent state.
 *
 * Kept dumb in M3 — just renders what App passes down. M4 will surface
 * token usage + cost when the SDK's `token_usage_updated` events get
 * threaded through.
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
	if (provider) segments.push(`${provider}${model ? ` · ${model}` : ''}`)
	segments.push(state)
	return (
		<Box>
			<Text color={theme.text.muted}>{segments.join('  ·  ')}</Text>
			{hint ? <Text color={theme.text.secondary}>{`   ${hint}`}</Text> : null}
		</Box>
	)
}

function shortenCwd(cwd: string): string {
	const home = process.env.HOME
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`
	}
	return cwd
}
