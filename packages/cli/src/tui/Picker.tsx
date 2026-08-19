/**
 * First-run / re-pick provider selector.
 *
 * Renders the credentials the discoverer found (env / keychain / local
 * probes) and lets the user pick a primary LLM provider for the TUI's own
 * chat. Keyboard-only. The dispatch path that turns the selection into a
 * live agent session lives in `agent.ts`.
 */

import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
	unsupportedProviderMessage,
} from '../integrations/providers/index.js'
import { type ModelListing, describeProviderModels, verifyCredential } from './agent.js'
import {
	classifyCredential,
	describeDisposition,
	keyLooksUsable,
	maskKey,
	sessionCredential,
} from './credential-entry.js'
import { type ModelStep, modelStep } from './model-choices.js'
import { theme } from './theme.js'

export interface PickerProps {
	readonly detected: readonly DetectedProvider[]
	readonly currentProvider?: string | null
	/** The model in force, so re-opening starts on it rather than the default. */
	readonly currentModel?: string | null
	readonly onSubmit: (
		selection: { provider: string; model?: string },
		signal: AbortSignal,
	) => void
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
		signal?: AbortSignal,
	) => Promise<ModelListing>
	/**
	 * A credential the operator typed, with the sentence describing what was
	 * done with it. Absent means this picker cannot take one.
	 */
	readonly onCredential?: (
		credential: DetectedProvider,
		disposition: string,
		signal: AbortSignal,
	) => void
	/**
	 * Start a subscription sign-in from this screen. Absent means this picker
	 * cannot start one.
	 *
	 * It has to be here, and the reason is the defect it repairs. The sign-in
	 * shipped as `/login`, a slash command; slash commands are typed into the
	 * composer; **the composer does not exist during this phase.** So the one
	 * operator who most needs it — no credential at all, routed straight here —
	 * was the one operator who could not reach it. The screen listed the
	 * sources it scans, offered a key to paste, and said to restart, while a
	 * working sign-in sat one unreachable keystroke away.
	 */
	readonly onLogin?: (signal: AbortSignal) => void
	/**
	 * Seam for tests: how a typed key is checked. Defaulted to the real thing,
	 * so no production caller knows this exists.
	 *
	 * Here for the same reason as `describeModels`: the alternative is a screen
	 * whose behaviour can only be checked by launching a terminal and typing a
	 * live credential into it.
	 */
	readonly verify?: typeof verifyCredential
	/**
	 * The provider a credential is MISSING for, when that is why this picker is
	 * open.
	 *
	 * Two things follow from it, and both were the difference between routing an
	 * operator here and helping them. Key entry becomes reachable on the
	 * populated screen — with a local server running, an operator with no key for
	 * their saved provider used to land on a list that offered no way to enter
	 * one — and the entry targets THIS provider rather than the first
	 * key-capable one in the registry, so the credential goes to the provider
	 * that needed it instead of to whichever happens to be listed first.
	 */
	readonly keyEntryFor?: ProviderId | null
	/**
	 * Why this picker is open, printed on it.
	 *
	 * A prop and not a transcript line, because the transcript is NOT RENDERED
	 * during this phase — the picker replaces it. Every refusal that routed here
	 * pushed its sentence into the transcript and then drew a screen that does
	 * not contain one, so the operator saw a provider list with no statement of
	 * what was wrong, and the explanation appeared only once they had already
	 * chosen and the transcript came back.
	 *
	 * That is the same shape as the defect this file's routing fixes, one layer
	 * down: an explanation delivered somewhere it cannot be read.
	 */
	readonly notice?: string | null
}

/** Providers that take a typed credential. Local servers do not. */
function keyCapableProviders(): ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter((e) => e.requiresApiKey)
}

/**
 * The provider `k` opens entry for.
 *
 * The saved one when this picker is open because its credential is missing;
 * otherwise the first key-capable provider, which is what the empty screen has
 * always done. Returns null when nothing here takes a typed credential.
 */
function keyEntryTarget(keyEntryFor: ProviderId | null | undefined): ProviderRegistryEntry | null {
	if (keyEntryFor) {
		const entry = PROVIDER_REGISTRY[keyEntryFor]
		if (entry?.requiresApiKey) return entry
	}
	return keyCapableProviders()[0] ?? null
}

export function Picker({
	detected,
	currentProvider,
	currentModel,
	onSubmit,
	onCancel,
	describeModels = describeProviderModels,
	onCredential,
	onLogin,
	verify = verifyCredential,
	keyEntryFor,
	notice,
}: PickerProps) {
	/**
	 * The one foreign operation still allowed to publish into this picker.
	 *
	 * A promise is not cancelled by unmounting the component that started it.
	 * The generation prevents a late result from writing state or invoking an
	 * external callback; the controller releases cooperative transports as soon
	 * as the operator changes their mind.
	 */
	const operationGenerationRef = useRef(0)
	const operationRef = useRef<{ generation: number; controller: AbortController } | null>(null)
	const invalidateOperation = useCallback(() => {
		operationGenerationRef.current += 1
		operationRef.current?.controller.abort(new Error('The picker operation was cancelled.'))
		operationRef.current = null
	}, [])
	const beginOperation = useCallback(() => {
		invalidateOperation()
		const operation = {
			generation: operationGenerationRef.current,
			controller: new AbortController(),
		}
		operationRef.current = operation
		return operation
	}, [invalidateOperation])
	const ownsOperation = useCallback(
		(operation: { generation: number; controller: AbortController }): boolean =>
			operationRef.current === operation &&
			operationGenerationRef.current === operation.generation &&
			!operation.controller.signal.aborted,
		[],
	)
	const finishOperation = useCallback(
		(operation: { generation: number; controller: AbortController }) => {
			if (operationRef.current === operation) operationRef.current = null
		},
		[],
	)
	useEffect(() => invalidateOperation, [invalidateOperation])
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
	//
	// The provider is held as the ENTRY, not as an index into a filtered registry
	// list. The index form could only ever address the first key-capable
	// provider, because nothing on this screen changed it — so a credential typed
	// for a saved provider would have been built for a different one.
	const [keyEntry, setKeyEntry] = useState<{
		readonly entry: ProviderRegistryEntry
		readonly value: string
		readonly status: 'typing' | 'checking'
		readonly problem?: string
	} | null>(null)

	const acceptKey = async (): Promise<void> => {
		const state = keyEntry
		if (!state) return
		const { entry } = state

		const shape = keyLooksUsable(state.value)
		if (!shape.ok) {
			setKeyEntry({ ...state, status: 'typing', problem: shape.reason })
			return
		}

		setKeyEntry({ ...state, status: 'checking' })
		const cred = sessionCredential(entry, state.value)
		// Classified from the value the operator pasted, and read from the SAME
		// function the session layer picks the wire header with, so the sentence
		// on screen cannot disagree with the request that follows it.
		const kind = classifyCredential(entry, state.value)
		const operation = beginOperation()
		let verification: Awaited<ReturnType<typeof verify>>
		try {
			verification = await verify(entry.id, cred, operation.controller.signal)
		} catch {
			if (!ownsOperation(operation)) return
			finishOperation(operation)
			setKeyEntry({
				...state,
				status: 'typing',
				problem: 'The credential check failed before the provider answered. Nothing was stored.',
			})
			return
		}
		if (!ownsOperation(operation)) return

		if (verification.kind === 'rejected') {
			finishOperation(operation)
			// Stays on the screen with the key intact so a one-character typo is
			// fixable. The reason is the provider's, never the key.
			setKeyEntry({
				...state,
				status: 'typing',
				problem: describeDisposition(entry, verification, kind),
			})
			return
		}
		// Keep this generation owned through App's session construction. Esc or
		// another choice aborts it, so a late session cannot replace the newer one.
		onCredential?.(
			cred,
			describeDisposition(entry, verification, kind),
			operation.controller.signal,
		)
	}

	useInput((input, key) => {
		// Key entry owns the keyboard while it is open: every printable character
		// is part of a secret, so nothing here may fall through to a shortcut.
		if (keyEntry) {
			if (key.escape) {
				invalidateOperation()
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

		// `k` opens credential entry. Two screens offer it, for two reasons.
		//
		// The empty one always has: with nothing detected, entering a credential
		// is the only thing that can happen here.
		//
		// The POPULATED one offers it when `keyEntryFor` is set, which was the
		// gap. The old rule was "empty screen only", reasoned as "someone with a
		// working credential is not the person this is for" — true then, and false
		// for the person this change routes here, who has a saved provider with no
		// credential and a local server that happens to be running. They arrived
		// at a list that named every provider except a way to fix the one they
		// chose. The letter does not collide with anything: navigation is arrows
		// and digits.
		// `l` starts a subscription sign-in, on exactly the screens `k` is live
		// on and for the same reason: these are the two states an operator
		// reaches with nothing usable. Checked BEFORE `k` only in the sense of
		// sitting beside it — the letters do not collide, and navigation is
		// arrows and digits.
		if ((detected.length === 0 || keyEntryFor) && onLogin && (input === 'l' || input === 'L')) {
			const operation = beginOperation()
			try {
				onLogin(operation.controller.signal)
			} catch (error) {
				if (ownsOperation(operation)) {
					finishOperation(operation)
					setErrorHint(
						`Could not start sign-in: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			return
		}

		if (
			(detected.length === 0 || keyEntryFor) &&
			onCredential &&
			(input === 'k' || input === 'K')
		) {
			const target = keyEntryTarget(keyEntryFor)
			if (target) {
				invalidateOperation()
				setKeyEntry({ entry: target, value: '', status: 'typing' })
			} else {
				setErrorHint('No provider here takes a typed credential.')
			}
			return
		}

		if (key.escape) {
			// From the model step, back to the provider list rather than out of
			// the picker: escape should undo one decision, not two.
			if (modelPhase) {
				invalidateOperation()
				setModelPhase(null)
				return
			}
			invalidateOperation()
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
				const operation = beginOperation()
				onSubmit(
					{ provider: modelPhase.provider.entry.id, model: chosen.id },
					operation.controller.signal,
				)
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
			// Detected, and still not choosable. The row stays visible on purpose
			// — see the list below — so this is the only place that can decline
			// it, and declining with the reason is the point: accepting would
			// write the choice to preferences and hand the operator a session
			// that refuses to start.
			if (!current.entry.constructible) {
				setErrorHint(unsupportedProviderMessage(current.entry.id))
				return
			}
			// Ask the provider what it has, then show the model step. The list is
			// raced against 3s inside `describeProviderModels`, so this resolves
			// either way and the step always has at least the default.
			const operation = beginOperation()
			setModelPhase({ provider: current, step: undefined })
			setCursor(0)
			void describeModels(current.entry.id, current, operation.controller.signal)
				.then((listing) => {
					if (!ownsOperation(operation)) return
					finishOperation(operation)
					const step = modelStep(current.entry.defaultModel, listing, currentModel ?? undefined)
					setModelPhase({ provider: current, step })
					setCursor(step.initialIndex)
				})
				.catch((error: unknown) => {
					if (!ownsOperation(operation)) return
					finishOperation(operation)
					const step = modelStep(
						current.entry.defaultModel,
						{ kind: 'failed', reason: error instanceof Error ? error.message : String(error) },
						currentModel ?? undefined,
					)
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

	// Above every screen this picker draws, so the reason is on the same frame as
	// the choice it is asking for.
	const noticeBox = notice ? (
		<Box paddingBottom={1}>
			<Text color={theme.status.warn}>{notice}</Text>
		</Box>
	) : null

	if (keyEntry) {
		const { entry } = keyEntry
		// What the operator has typed SO FAR, classified live. It settles as they
		// finish pasting, and it is the same question `acceptKey` asks — so the
		// line below is a preview of the sentence they will get, not a second
		// opinion about it.
		const kind = classifyCredential(entry, keyEntry.value)
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				{noticeBox}
				<Box flexDirection="column" paddingBottom={1}>
					<Text color={theme.accent.system} bold>
						Paste a credential for {entry.label}
					</Text>
					{/* Both kinds are named because both are accepted, and someone
					    holding a subscription token has no way to guess that a field
					    labelled "key" wants it. */}
					<Text color={theme.text.muted}>
						An API key or a subscription token. Type or paste, then enter. esc cancels.
					</Text>
				</Box>
				{/* The mask, never the value. */}
				<Text color={theme.text.primary}>
					{maskKey(keyEntry.value) || <Text color={theme.text.muted}>(nothing typed yet)</Text>}
				</Text>
				<Box paddingTop={1} flexDirection="column">
					{keyEntry.status === 'checking' ? (
						<Text color={theme.text.muted}>Checking it with {entry.label}…</Text>
					) : (
						<Text color={theme.text.secondary}>
							Used for this session only — it is not written anywhere.
						</Text>
					)}
					{keyEntry.value.length > 0 && kind === 'subscription-token' ? (
						<Text color={theme.status.warn}>
							Reads as a subscription token — it expires in a few hours and namzu has no
							refresh data for a pasted one.
						</Text>
					) : null}
					{keyEntry.problem ? <Text color={theme.status.warn}>{keyEntry.problem}</Text> : null}
				</Box>
			</Box>
		)
	}

	if (modelPhase) {
		return (
			<Box flexDirection="column">
				{noticeBox}
				<ModelStepView
					providerLabel={modelPhase.provider.entry.label}
					step={modelPhase.step}
					cursor={cursor}
					errorHint={errorHint}
				/>
			</Box>
		)
	}

	// Non-null exactly when `k` is live on the populated list — the same
	// condition the key handler uses, read from one place so the hint and the
	// keyboard cannot drift apart.
	const entryTarget = keyEntryFor && onCredential ? keyEntryTarget(keyEntryFor) : null

	if (detected.length === 0) {
		return (
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.status.warn}
				paddingX={1}
			>
				{noticeBox}
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
					{/* The summary line on the populated screen names the same sources;
					    this list is the same set and must not name fewer. It is the
					    screen shown to the person with no credential, so an omission
					    here is a source they are never told to try — which is exactly
					    what happened to the store below when the sign-in shipped. */}
					<Text color={theme.text.muted}>
						{' '}
						· a subscription signed in to from namzu (~/.namzu/credentials.json)
					</Text>
					<Text color={theme.text.muted}>
						{' '}
						· macOS Keychain (an existing OAuth sign-in; macOS only)
					</Text>
					<Text color={theme.text.muted}>
						{' '}
						· local servers (Ollama localhost:11434, LM Studio localhost:1234)
					</Text>
				</Box>
				{onLogin ? (
					<Box paddingTop={1}>
						<Text color={theme.text.primary}>
							Press <Text color={theme.accent.system}>l</Text> to sign in with a subscription —
							no API key, and namzu keeps it for next time.
						</Text>
					</Box>
				) : null}
				<Box paddingTop={1}>
					<Text color={theme.text.primary}>
						Or press <Text color={theme.accent.system}>k</Text> to paste a credential now and use
						it for this session.
					</Text>
				</Box>
				<Box paddingTop={1}>
					<Text color={theme.text.secondary}>
						You can also set one of the env vars above (or start a local server) and restart.
					</Text>
				</Box>
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>
						{onLogin ? 'l: sign in · ' : ''}k: enter a credential · esc: exit picker
					</Text>
				</Box>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			{noticeBox}
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
				{/* Named only when the key actually does something. A hint that
				    advertises a key this screen ignores is the same defect as a
				    message whose advice cannot be followed, one size down. */}
				<Text color={theme.text.muted}>
					↑↓ or 1-9 navigate · enter accept
					{entryTarget ? ` · k enter a credential for ${entryTarget.label}` : ''}
					{keyEntryFor && onLogin ? ' · l sign in with a subscription' : ''} · esc cancel
				</Text>
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
	// What was found stays what is shown. A provider this build cannot construct
	// is still genuinely on the machine, and replacing "local · localhost:1234"
	// with the refusal would hide the discovery that makes the refusal make
	// sense. The reason goes in the source column, where the row says what namzu
	// knows about it.
	const usable = detected.entry.constructible
	const sourceLabel = usable
		? describeSource(detected)
		: `${describeSource(detected)} · unavailable in this build`
	const currentMark = isCurrent ? '  ← current' : ''
	return (
		<Box>
			<Text color={selected ? theme.border.focus : theme.text.muted}>{cursor} </Text>
			<Text color={theme.text.muted}>{number} </Text>
			<Text
				color={
					usable
						? selected
							? theme.border.focus
							: theme.text.primary
						: theme.text.muted
				}
				bold={usable && selected}
				dimColor={!usable}
			>
				{label.padEnd(28)}
			</Text>
			<Text color={usable ? theme.text.muted : theme.status.warn} dimColor={!usable}>
				{sourceLabel}
			</Text>
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
		case 'stored':
			// Named for what the operator DID, not for where the bytes live. They
			// signed in; the path is in `/doctor` for when it matters.
			return 'signed in · this machine'
		case 'session':
			// Named as temporary wherever it is listed. Someone scanning this
			// column should be able to see which credential disappears when they
			// close the terminal without having to remember typing it.
			return 'typed · this session only'
	}
}
