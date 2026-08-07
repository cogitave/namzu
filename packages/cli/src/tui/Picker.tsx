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

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
} from '../integrations/providers/index.js'
import { type ModelListing, describeProviderModels, verifyCredential } from './agent.js'
import { describeDisposition, keyLooksUsable, maskKey, sessionCredential } from './credential-entry.js'
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
	/**
	 * A credential the operator typed, with the sentence describing what was
	 * done with it. Absent means this picker cannot take one.
	 */
	readonly onCredential?: (credential: DetectedProvider, disposition: string) => void
}

/** Providers that take a typed API key. Local servers do not. */
function keyCapableProviders(): ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter((e) => e.requiresApiKey)
}

export function Picker({
	detected,
	currentProvider,
	currentModel,
	onSubmit,
	onCancel,
	describeModels = describeProviderModels,
	onCredential,
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
	// Key entry. `value` is the secret and never leaves this component except as
	// a mask or as the credential handed to `onCredential`.
	const [keyEntry, setKeyEntry] = useState<{
		readonly providerIndex: number
		readonly value: string
		readonly status: 'typing' | 'checking'
		readonly problem?: string
	} | null>(null)

	const acceptKey = async (): Promise<void> => {
		const state = keyEntry
		if (!state) return
		const entry = keyCapableProviders()[state.providerIndex]
		if (!entry) return

		const shape = keyLooksUsable(state.value)
		if (!shape.ok) {
			setKeyEntry({ ...state, status: 'typing', problem: shape.reason })
			return
		}

		setKeyEntry({ ...state, status: 'checking' })
		const cred = sessionCredential(entry, state.value)
		const verification = await verifyCredential(entry.id, cred)

		if (verification.kind === 'rejected') {
			// Stays on the screen with the key intact so a one-character typo is
			// fixable. The reason is the provider's, never the key.
			setKeyEntry({
				...state,
				status: 'typing',
				problem: describeDisposition(entry, verification),
			})
			return
		}
		onCredential?.(cred, describeDisposition(entry, verification))
	}

	useInput((input, key) => {
		// Key entry owns the keyboard while it is open: every printable character
		// is part of a secret, so nothing here may fall through to a shortcut.
		if (keyEntry) {
			if (key.escape) {
				setKeyEntry(null)
				return
			}
			if (keyEntry.status === 'checking') return
			if (key.return) {
				void acceptKey()
				return
			}
			if (key.backspace || key.delete) {
				setKeyEntry((k) => (k ? { ...k, value: k.value.slice(0, -1), status: 'typing' } : k))
				return
			}
			if (input && !key.ctrl && !key.meta) {
				setKeyEntry((k) => (k ? { ...k, value: k.value + input, status: 'typing' } : k))
			}
			return
		}

		// `k` from the empty screen. Only there: on a populated picker the letter
		// would collide with navigation, and someone with a working credential is
		// not the person this is for.
		if (detected.length === 0 && onCredential && (input === 'k' || input === 'K')) {
			if (keyCapableProviders().length > 0) {
				setKeyEntry({ providerIndex: 0, value: '', status: 'typing' })
			} else {
				setErrorHint('No provider here takes a typed key.')
			}
			return
		}

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

	if (keyEntry) {
		const entry = keyCapableProviders()[keyEntry.providerIndex]
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				<Box flexDirection="column" paddingBottom={1}>
					<Text color={theme.accent.system} bold>
						Paste a key for {entry?.label ?? 'this provider'}
					</Text>
					<Text color={theme.text.muted}>
						↑↓ is not needed — type or paste, then enter. esc cancels.
					</Text>
				</Box>
				{/* The mask, never the value. */}
				<Text color={theme.text.primary}>
					{maskKey(keyEntry.value) || <Text color={theme.text.muted}>(nothing typed yet)</Text>}
				</Text>
				<Box paddingTop={1} flexDirection="column">
					{keyEntry.status === 'checking' ? (
						<Text color={theme.text.muted}>Checking it with {entry?.label}…</Text>
					) : (
						<Text color={theme.text.secondary}>
							Used for this session only — it is not written anywhere.
						</Text>
					)}
					{keyEntry.problem ? <Text color={theme.status.warn}>{keyEntry.problem}</Text> : null}
				</Box>
			</Box>
		)
	}

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
					<Text color={theme.text.primary}>
						Or press <Text color={theme.accent.system}>k</Text> to paste a key now and use it for
						this session.
					</Text>
				</Box>
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>k: enter a key · esc: exit picker</Text>
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
		case 'session':
			// Named as temporary wherever it is listed. Someone scanning this
			// column should be able to see which credential disappears when they
			// close the terminal without having to remember typing it.
			return 'typed · this session only'
	}
}
