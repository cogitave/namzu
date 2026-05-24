/**
 * First-run / re-pick provider selector.
 *
 * Renders the credentials the discoverer found (env / clawtool secrets /
 * local probes) and lets the user pick a primary LLM provider for the
 * TUI's own chat. Keyboard-only. The dispatch path that turns the
 * selection into a live agent session lives in `agent.ts`.
 */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import type { DetectedProvider } from '../integrations/providers/index.js'
import { theme } from './theme.js'

export interface PickerProps {
	readonly detected: readonly DetectedProvider[]
	readonly currentProvider?: string | null
	readonly onSubmit: (selection: { provider: string; model?: string }) => void
	readonly onCancel: () => void
}

export function Picker({ detected, currentProvider, onSubmit, onCancel }: PickerProps) {
	const initialIndex =
		(currentProvider !== null && currentProvider !== undefined
			? detected.findIndex((d) => d.entry.id === currentProvider)
			: 0) || 0
	const [cursor, setCursor] = useState<number>(Math.max(0, initialIndex))
	const [errorHint, setErrorHint] = useState<string | null>(null)

	useInput((input, key) => {
		if (key.upArrow) {
			setCursor((c) => Math.max(0, c - 1))
			return
		}
		if (key.downArrow) {
			setCursor((c) => Math.min(Math.max(0, detected.length - 1), c + 1))
			return
		}
		if (key.return) {
			const current = detected[cursor]
			if (!current) {
				setErrorHint('No provider available.')
				return
			}
			onSubmit({ provider: current.entry.id })
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		// Numeric quick-select.
		const n = Number.parseInt(input, 10)
		if (Number.isFinite(n) && n >= 1 && n <= detected.length) {
			setCursor(n - 1)
		}
	})

	if (detected.length === 0) {
		return (
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.status.warn}
				paddingX={1}
			>
				<Text color={theme.status.warn} bold>
					No providers detected
				</Text>
				<Box paddingTop={1} flexDirection="column">
					<Text color={theme.text.primary}>
						namzu scans these sources, in order, for an LLM credential:
					</Text>
					<Text color={theme.text.muted}>
						{' '}
						· env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, …)
					</Text>
					<Text color={theme.text.muted}>
						{' '}
						· ~/.config/clawtool/secrets.toml [secrets.*] sections
					</Text>
					<Text color={theme.text.muted}>
						{' '}
						· local servers (Ollama localhost:11434, LM Studio localhost:1234)
					</Text>
				</Box>
				<Box paddingTop={1}>
					<Text color={theme.text.secondary}>
						Set one of the env vars above (or start a local server), then restart namzu.
					</Text>
				</Box>
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>esc: exit picker</Text>
				</Box>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box flexDirection="column" paddingBottom={1}>
				<Text color={theme.accent.system} bold>
					Choose a provider
				</Text>
				<Text color={theme.text.muted}>
					{detected.length} detected · credentials resolved from env / clawtool / local probes
				</Text>
			</Box>
			<Box flexDirection="column">
				{detected.map((d, i) => (
					<ProviderRow
						key={d.entry.id}
						detected={d}
						index={i}
						selected={i === cursor}
						isCurrent={d.entry.id === currentProvider}
					/>
				))}
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.muted}>↑↓ or 1-9 navigate · enter accept · esc cancel</Text>
				{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
			</Box>
		</Box>
	)
}

function ProviderRow({
	detected,
	index,
	selected,
	isCurrent,
}: {
	readonly detected: DetectedProvider
	readonly index: number
	readonly selected: boolean
	readonly isCurrent: boolean
}) {
	const cursor = selected ? '›' : ' '
	const number = `${index + 1}.`
	const label = detected.entry.label
	const sourceLabel = describeSource(detected)
	const currentMark = isCurrent ? '  ← current' : ''
	return (
		<Box>
			<Text color={selected ? theme.border.focus : theme.text.muted}>{cursor} </Text>
			<Text color={theme.text.muted}>{number} </Text>
			<Text color={selected ? theme.border.focus : theme.text.primary} bold={selected}>
				{label.padEnd(28)}
			</Text>
			<Text color={theme.text.muted}>{sourceLabel}</Text>
			{isCurrent ? <Text color={theme.accent.system}>{currentMark}</Text> : null}
		</Box>
	)
}

function describeSource(d: DetectedProvider): string {
	switch (d.source.kind) {
		case 'env':
			return `via ${d.source.envName}`
		case 'secrets-toml':
			return `via clawtool [secrets.${d.source.scope}] · ${d.source.envName}`
		case 'probe':
			return `local · ${d.source.url}`
	}
}
