/**
 * First-run / re-pick provider selector.
 *
 * Renders the credentials the discoverer found (env / keychain / local
 * probes) and lets the user pick a primary LLM provider for the TUI's own
 * chat. Keyboard-only. The dispatch path that turns the selection into a
 * live agent session lives in `agent.ts`.
 */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import type { DetectedProvider, ProviderId } from '../integrations/providers/index.js'
import { type ModelListing, describeProviderModels } from './agent.js'
import { type ModelStep, modelStep } from './model-choices.js'
import { theme } from './theme.js'

export interface PickerProps {
	readonly detected: readonly DetectedProvider[]
	readonly currentProvider?: string | null
	/** The model in force, so re-opening starts on it rather than the default. */
	readonly currentModel?: string | null
	readonly onSubmit: (selection: { provider: string; model?: string }) => void
	readonly onCancel: () => void
	/**
	 * Seam for tests: how the picker asks a provider what it has.
	 *
	 * Defaulted to the real thing, so production wiring is unchanged and no
	 * caller has to know this exists. It is here because the alternative is a
	 * screen whose behaviour can only be checked by launching a terminal.
	 */
	readonly describeModels?: (
		id: ProviderId,
		det: DetectedProvider,
	) => Promise<ModelListing>
}

export function Picker({
	detected,
	currentProvider,
	currentModel,
	onSubmit,
	onCancel,
	describeModels = describeProviderModels,
}: PickerProps) {
	const initialIndex =
		(currentProvider !== null && currentProvider !== undefined
			? detected.findIndex((d) => d.entry.id === currentProvider)
			: 0) || 0
	const [cursor, setCursor] = useState<number>(Math.max(0, initialIndex))
	const [errorHint, setErrorHint] = useState<string | null>(null)
	// `null` while choosing a provider. Once a provider is accepted this holds
	// the model step, and `undefined` inside it means the listing is in flight.
	const [modelPhase, setModelPhase] = useState<{
		readonly provider: DetectedProvider
		readonly step: ModelStep | undefined
	} | null>(null)

	useInput((input, key) => {
		if (key.escape) {
			// From the model step, back to the provider list rather than out of
			// the picker: escape should undo one decision, not two.
			if (modelPhase) {
				setModelPhase(null)
				return
			}
			onCancel()
			return
		}

		if (modelPhase) {
			const step = modelPhase.step
			if (!step) return // still listing; ignore input rather than act on a stale list
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1))
				return
			}
			if (key.downArrow) {
				setCursor((c) => Math.min(step.choices.length - 1, c + 1))
				return
			}
			if (key.return) {
				const chosen = step.choices[cursor]
				if (!chosen) {
					setErrorHint('No model available.')
					return
				}
				onSubmit({ provider: modelPhase.provider.entry.id, model: chosen.id })
				return
			}
			const n = Number.parseInt(input, 10)
			if (Number.isFinite(n) && n >= 1 && n <= step.choices.length) setCursor(n - 1)
			return
		}

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
			// Ask the provider what it has, then show the model step. The list is
			// raced against 3s inside `describeProviderModels`, so this resolves
			// either way and the step always has at least the default.
			setModelPhase({ provider: current, step: undefined })
			setCursor(0)
			void describeModels(current.entry.id, current).then((listing) => {
				const step = modelStep(current.entry.defaultModel, listing, currentModel ?? undefined)
				setModelPhase({ provider: current, step })
				setCursor(step.initialIndex)
			})
			return
		}
		// Numeric quick-select.
		const n = Number.parseInt(input, 10)
		if (Number.isFinite(n) && n >= 1 && n <= detected.length) {
			setCursor(n - 1)
		}
	})

	if (modelPhase) {
		return (
			<ModelStepView
				providerLabel={modelPhase.provider.entry.label}
				step={modelPhase.step}
				cursor={cursor}
				errorHint={errorHint}
			/>
		)
	}

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
					{/* The summary line on the populated screen names three sources; this
					    list is the same set and must not name fewer. It is the screen
					    shown to the person with no credential, so an omission here is a
					    source they are never told to try. */}
					<Text color={theme.text.muted}>
						{' '}
						· macOS Keychain (an existing OAuth sign-in; macOS only)
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
					{detected.length} detected · credentials resolved from env / keychain / local probes
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

function ModelStepView({
	providerLabel,
	step,
	cursor,
	errorHint,
}: {
	readonly providerLabel: string
	readonly step: ModelStep | undefined
	readonly cursor: number
	readonly errorHint: string | null
}) {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box flexDirection="column" paddingBottom={1}>
				<Text color={theme.accent.system} bold>
					Choose a model
				</Text>
				<Text color={theme.text.muted}>{providerLabel}</Text>
			</Box>
			{step === undefined ? (
				<Text color={theme.text.muted}>Asking {providerLabel} what it has…</Text>
			) : (
				<>
					{step.notice ? (
						<Box paddingBottom={1}>
							<Text color={theme.status.warn}>{step.notice}</Text>
						</Box>
					) : null}
					<Box flexDirection="column">
						{step.choices.map((c, i) => (
							<Text
								key={c.id}
								color={i === cursor ? theme.accent.system : theme.text.primary}
							>
								{i === cursor ? '❯ ' : '  '}
								{i + 1}. {c.label}
								{c.note ? ` ${c.note}` : ''}
							</Text>
						))}
					</Box>
				</>
			)}
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.muted}>↑↓ or 1-9 navigate · enter accept · esc back</Text>
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
			return `env · ${d.source.envName}`
		case 'probe':
			return `local · ${d.source.url.replace(/^https?:\/\//, '')}`
		case 'keychain':
			return `keychain · ${d.source.service}`
	}
}
