/**
 * First-run / re-pick provider selector.
 *
 * Renders the credentials the discoverer found (env / keychain / local
 * probes) and lets the user pick a primary LLM provider for the TUI's own
 * chat. Keyboard-only. The dispatch path that turns the selection into a
 * live agent session lives in `agent.ts`.
 */

import { Box, Text, useInput, useWindowSize } from 'ink'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import { canSelectModel } from '../integrations/providers/access.js'

import {
	ALL_PROVIDER_IDS,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderId,
	type ProviderRegistryEntry,
	type SubscriptionProviderId,
	signedInSubscriptionProviders,
	unsupportedProviderMessage,
	type VendorId,
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
import { filterModelChoices } from './model-search.js'
import {
	credentialNeed,
	initialProviderRow,
	pathProviderId,
	providerListRows,
	rowCredentialNeed,
	rowHasProvider,
	rowIndexOfProvider,
	rowIsUsable,
	rowNeedsChoice,
	typedCredentialEntry,
	type VendorPath,
	type VendorRow,
} from './provider-list.js'
import {
	moveSelection,
	type SelectionWindow,
	selectionWindow,
} from './selection-window.js'
import {
	capChoiceLines,
	choiceDisplayWidth,
	eraseLastChoiceGrapheme,
	truncateChoiceText,
	wrapChoiceText,
} from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import { useSelectionIndex } from './use-selection-index.js'

export interface PickerProps {
	readonly detected: readonly DetectedProvider[]
	readonly currentProvider?: string | null
	/**
	 * A first-run choice between credentials that are already signed in needs
	 * only a provider decision. Model selection remains available later through
	 * `/model`; asking it here would turn "use the session already on this
	 * device" back into a two-screen setup flow.
	 */
	readonly selectionKind?: 'provider-and-model' | 'signed-in-subscription'
	/** `/model` opens the active provider's models; `/login` opens subscriptions. */
	readonly initialView?: 'providers' | 'subscriptions' | 'models'
	/** The model in force, so re-opening starts on it rather than the default. */
	readonly currentModel?: string | null
	readonly onSubmit: (selection: { provider: string; model?: string }, signal: AbortSignal) => void
	readonly onCancel: () => void
	readonly onSetup?: () => void
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
	readonly onLogin?: (
		provider: SubscriptionProviderId,
		signal: AbortSignal,
	) => Promise<'awaiting-input' | 'finished' | 'failed'>
	/** Finish the browser flow from the code/address pasted into this picker. */
	readonly onLoginComplete?: (input: string, signal: AbortSignal) => Promise<'retry' | 'finished'>
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
	/**
	 * Whether `esc` leaves namzu itself rather than returning to a session.
	 *
	 * True exactly when the picker is the startup screen and nothing behind it
	 * can be returned to: `handlePickerCancel` exits the program in that case,
	 * and the footers used to say `esc cancel` — naming something the operator
	 * would not see happen, because the whole screen closes. The default is the
	 * ordinary case (a session is running behind the picker), so no existing
	 * caller changes.
	 */
	readonly cancelExits?: boolean
}

/**
 * Columns this screen's text area has, given the terminal's width.
 *
 * Derived rather than written down, because the number this replaces was a
 * literal that counted two of the three things that take columns and forgot the
 * third. In order:
 *
 *  - `HOST_INSET_X` — the app draws every screen inside a box with one column
 *    of padding on each side (`App.tsx`'s root), so this picker's own box starts
 *    one column in and ends one column short of the terminal.
 *  - `BORDER_X` — this box's round border, one column per side.
 *  - `BOX_PADDING_X` — this box's `paddingX={1}`, one column per side.
 *
 * The old arithmetic was `columns - 4`: the border and the padding, minus the
 * host's inset. At 60 columns that budgeted 56 columns of text for an area of
 * 54 — measured from a 60-column capture, where the two borders sit at columns
 * 1 and 58, leaving 56 between them and 54 inside the padding. Every row the
 * screen measured as fitting therefore wrapped, and the text it wrapped was the
 * row the cursor was on.
 */
const HOST_INSET_X = 2
const BORDER_X = 2
const BOX_PADDING_X = 2

/** Columns a row of this screen's content may occupy. */
export function pickerContentWidth(columns: number): number {
	return Math.max(1, columns - HOST_INSET_X - BORDER_X - BOX_PADDING_X)
}

/**
 * Columns a row spends before its source: the marker, the number and the
 * vendor's name, each written over its own width.
 *
 * Derived from the three, because 32 was written down here once and was the
 * width of the BROKEN row — the one whose marker had lost the space beside it.
 * A source measured against a row one column narrower than it is a source that
 * wraps in the renderer after the screen has counted it as one line, which is
 * the defect this whole window exists to prevent.
 */
const ROW_MARKER_WIDTH = 2
const ROW_NUMBER_WIDTH = 3
const ROW_LABEL_WIDTH = 28
const ROW_PREFIX_WIDTH = ROW_MARKER_WIDTH + ROW_NUMBER_WIDTH + ROW_LABEL_WIDTH
/** What a wrapped source line is indented by, so it lines up under the name. */
const ROW_INDENT = ' '.repeat(ROW_PREFIX_WIDTH)

/**
 * Lines a row's source column may take before the rest is cut.
 *
 * Three is what a variable name needs at the width this was measured against
 * (54 columns leaves 22 for the source, so `env · OPENROUTER_API_KEY` wraps to
 * two). It is a cap rather than a measurement because a row's height is part of
 * the box's height: without one, a forty-column terminal could make a single
 * source a dozen lines and no window could keep the header on screen.
 */
const MAX_SOURCE_LINES = 3

/** The words above the not-detected block, which the row window reserves lines for. */
const NOT_DETECTED_HEADING = 'Not detected — enter a credential to use these:'

/**
 * The line above the box that is not the box's.
 *
 * Ink draws this screen below whatever the app has already written — the boot
 * banner, on the run that shows this picker first — and a terminal keeps the
 * last `rows` lines of all of it. A box that fills the terminal exactly
 * therefore loses its own top border, and under that border is the notice the
 * screen exists to deliver.
 */
const TRANSCRIPT_LINE_ABOVE = 1

/** The mark a row carries when it is the provider in force. */
const CURRENT_MARK = '  ← current'

/**
 * Columns a row's source must keep before it shares its line with that mark.
 *
 * Twenty is the shortest this column can be and still be read: an environment
 * variable name (`DEEPSEEK_API_KEY` is sixteen, with the word `needs` before it
 * and the `←` mark is twelve columns of its own. Below twenty the mark moves
 * down a line rather than cutting the answer in half.
 */
const MIN_SOURCE_COLUMNS = 20

/** What `s` does, printed above the list on the screens that offer it. */
const SETUP_HINT = 's provider setup · check installations and access'

/**
 * What the screen that found nothing says, and the reason it says it.
 *
 * Here rather than inline because the row window counts these lines before it
 * draws a single row: they are the operator's only way off that screen, so they
 * are reserved first and a row is drawn with what is left over.
 */
const EMPTY_SCREEN_INTRO = 'namzu scans these sources, in order, for an LLM credential:'
const EMPTY_SCREEN_HINTS = {
	signIn: 'to sign in with a subscription — no API key, and namzu keeps it for next time.',
	paste: 'to paste a credential now and use it for this session.',
	durable: 'You can also set one of the env vars above (or start a local server) and restart.',
} as const

/** The sources the empty screen lists — the same set the summary line names. */
function emptyScreenSourceLines(): readonly string[] {
	return [
		` · existing ${subscriptionProviders()
			.map((entry) => entry.label)
			.join(' and ')} sessions on this device`,
		' · subscriptions signed in to from namzu (~/.namzu/credentials.json)',
		' · env vars / API keys (optional alternatives: ANTHROPIC_API_KEY, OPENAI_API_KEY, …)',
		' · local servers (Ollama localhost:11434, LM Studio localhost:1234)',
	]
}

function subscriptionProviders(): ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter(
		(entry) => entry.subscriptionLogin !== undefined,
	)
}

type SubscriptionChoice =
	| { readonly kind: 'existing'; readonly detected: DetectedProvider }
	| { readonly kind: 'sign-in'; readonly entry: ProviderRegistryEntry }

/**
 * The subscription screen offers two different operations and names both.
 *
 * A detected subscription session is already usable and must not be presented
 * as a new OAuth flow. Conversely, a provider with no usable device session is
 * still a valid new sign-in target. Keeping both rows means `/login` can switch
 * to an owner CLI session without overwriting it, while still allowing a fresh
 * Namzu-owned credential when the operator explicitly asks for one.
 */
function subscriptionChoices(detected: readonly DetectedProvider[]): readonly SubscriptionChoice[] {
	return [
		...signedInSubscriptionProviders(detected).map(
			(provider): SubscriptionChoice => ({
				kind: 'existing',
				detected: provider,
			}),
		),
		...subscriptionProviders().map((entry): SubscriptionChoice => ({ kind: 'sign-in', entry })),
	]
}

function signInChoiceIndex(choices: readonly SubscriptionChoice[], provider: ProviderId): number {
	return choices.findIndex((choice) => choice.kind === 'sign-in' && choice.entry.id === provider)
}

/**
 * The provider `k` opens entry for.
 *
 * The highlighted row's own provider whenever the vendor takes a typed
 * credential. This screen used to answer the question from the registry
 * instead: the saved provider if the picker was open because of one, and
 * otherwise the first key-capable entry, which is a provider the operator may
 * not have been looking at. A list you can move through is a list the key
 * beside it has to follow.
 *
 * A row whose vendor takes none — a local server — falls through to the saved
 * provider this picker was opened for: that route is why the notice above says
 * `k`, and it must keep working when the cursor happens to sit on a row that
 * cannot use it.
 *
 * Returns null when there is nothing here to enter a credential for, which the
 * caller says out loud rather than presenting a field that leads nowhere.
 */
function keyEntryTarget(
	row: VendorRow | undefined,
	keyEntryFor: ProviderId | null | undefined,
): ProviderRegistryEntry | null {
	const onThisRow = typedCredentialEntry(row)
	if (onThisRow) return onThisRow
	if (keyEntryFor) {
		const entry = PROVIDER_REGISTRY[keyEntryFor]
		if (entry?.acceptsTypedCredential) return entry
	}
	return null
}

export function Picker({
	detected,
	currentProvider,
	selectionKind = 'provider-and-model',
	currentModel,
	initialView = 'providers',
	onSubmit,
	onCancel,
	onSetup,
	describeModels = describeProviderModels,
	onCredential,
	onLogin,
	onLoginComplete,
	verify = verifyCredential,
	keyEntryFor,
	notice,
	cancelExits = false,
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
	const operationRef = useRef<{
		generation: number
		controller: AbortController
	} | null>(null)
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
	// The list this screen draws: what was detected, then every provider this
	// build could construct if the operator supplied a credential.
	//
	// `detected` is still the discovery result and is still what the header
	// counts, what the sign-in screen offers and what a submitted choice is
	// built from. This is the screen, not the machine.
	//
	// The signed-in-subscription screen takes the detected rows alone: it asks
	// which already-usable session to use, and a row that needs a key first
	// makes that sentence false.
	const rows = providerListRows(detected, selectionKind !== 'signed-in-subscription')
	// Whether `k` is offered at all, read once so the hint below and the key
	// handler cannot disagree about it. The handler adds the phase guards,
	// because it runs on every screen this picker draws and this expression is
	// computed only for the list.
	const keyEntryOffered = onCredential !== undefined && selectionKind !== 'signed-in-subscription'
	// The cursor is an index into whichever list the screen is drawing, and the
	// sign-in screen draws `subscriptionChoices` while the provider list draws
	// these rows, which is longer by however many providers can be set up from
	// here. An index resolved against one and read against the other selects
	// nothing at all, which is how `/login` came up with no row highlighted and
	// an Enter that did nothing on the machine below: a saved preference naming
	// a saved provider resolved to its row in the provider list, which is past the end
	// of a three-row sign-in list.
	const initialSelection =
		initialView === 'subscriptions' ? 0 : initialProviderRow(rows, currentProvider, keyEntryFor)
	const {
		selection: cursor,
		selectionRef: cursorRef,
		setSelection: setCursor,
	} = useSelectionIndex(initialSelection)
	// How wide this screen's text is, and how many lines its notice takes, both
	// of which the row window is sized against — see the list below.
	const terminal = useWindowSize()
	const contentWidth = pickerContentWidth(terminal.columns ?? 80)
	const noticeLines = notice ? wrapChoiceText(notice, contentWidth).length : 0
	const [errorHint, setErrorHint] = useState<string | null>(null)
	// The ref makes a pasted query followed immediately by Enter use the new
	// filtered list, even before React has drawn another frame. Null keeps the
	// existing provider and numeric shortcuts available outside search.
	const [modelQuery, setModelQuery] = useState<string | null>(null)
	const modelQueryRef = useRef<string | null>(null)
	// `null` while choosing a provider. Once a provider is accepted this holds
	// the model step, and `undefined` inside it means the listing is in flight.
	const [modelPhase, setModelPhase] = useState<{
		readonly provider: DetectedProvider
		readonly step: ModelStep | undefined
		readonly returnToProviders: boolean
	} | null>(null)
	const [loginPhase, setLoginPhase] = useState(initialView === 'subscriptions')
	useEffect(() => {
		setLoginPhase(initialView === 'subscriptions')
		if (initialView !== 'models') setModelPhase(null)
	}, [initialView])
	const [loginEntry, setLoginEntry] = useState<{
		readonly entry: ProviderRegistryEntry
		readonly value: string
		readonly status: 'starting' | 'typing' | 'checking'
		readonly problem?: string
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
	// The vendor whose ways in are being chosen, while that screen is up.
	//
	// Held as the vendor's id and resolved against `rows` on every render, not as
	// a row object: `rows` is derived from the props on each render, and a stored
	// row would be the list as it looked on the keystroke that opened this screen.
	// The screen is only ever reached from a row, so the lookup cannot come back
	// empty while it is up.
	const [pathVendor, setPathVendor] = useState<VendorId | null>(null)
	const pathRow =
		pathVendor === null ? null : (rows.find((row) => row.vendor === pathVendor) ?? null)
	const openModels = useCallback(
		(current: DetectedProvider, returnToProviders = true) => {
			const operation = beginOperation()
			modelQueryRef.current = null
			setModelQuery(null)
			setModelPhase({ provider: current, step: undefined, returnToProviders })
			setCursor(0)
			const activeModel =
				currentProvider == null || currentProvider === current.entry.id
					? (currentModel ?? undefined)
					: undefined
			const showListing = (listing: ModelListing) => {
				if (!ownsOperation(operation)) return
				finishOperation(operation)
				const step = modelStep(current.entry.defaultModel, listing, activeModel, {
					allowModel: (id) => canSelectModel(current.entry, current.apiKey, id),
				})
				setModelPhase({ provider: current, step, returnToProviders })
				setCursor(step.initialIndex)
			}
			void describeModels(current.entry.id, current, operation.controller.signal)
				.then(showListing)
				.catch((error: unknown) =>
					showListing({
						kind: 'failed',
						reason: error instanceof Error ? error.message : String(error),
					}),
				)
		},
		[
			beginOperation,
			currentModel,
			currentProvider,
			describeModels,
			finishOperation,
			ownsOperation,
			setCursor,
		],
	)
	const initialModelsOpened = useRef(false)
	useEffect(() => {
		if (initialView !== 'models' || initialModelsOpened.current) return
		initialModelsOpened.current = true
		const current = detected.find((provider) => provider.entry.id === currentProvider)
		if (current?.entry.constructible) openModels(current, false)
		else setErrorHint('The current provider is unavailable here. Choose another provider.')
	}, [currentProvider, detected, initialView, openModels])

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

	const acceptLogin = async (): Promise<void> => {
		const entry = loginEntry
		const operation = operationRef.current
		if (!entry || entry.status !== 'typing' || !operation || !onLoginComplete) return
		if (entry.value.trim().length === 0) {
			setLoginEntry({
				...entry,
				problem: 'Paste the authorization code or finished address first.',
			})
			return
		}
		setLoginEntry({ ...entry, status: 'checking', problem: undefined })
		try {
			const disposition = await onLoginComplete(entry.value, operation.controller.signal)
			if (!ownsOperation(operation)) return
			if (disposition === 'retry') {
				setLoginEntry({
					...entry,
					status: 'typing',
					problem:
						'That value could not finish this sign-in. Check the address or code and try again.',
				})
				return
			}
			finishOperation(operation)
			setLoginEntry(null)
		} catch (error) {
			if (!ownsOperation(operation)) return
			setLoginEntry({
				...entry,
				status: 'typing',
				problem: `Could not finish sign-in: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	/**
	 * Start a subscription sign-in for one provider.
	 *
	 * Written once and reached from two places — the sign-in screen's own Enter,
	 * and the sign-in path inside a vendor row — because two copies of this would
	 * be two places for the device-code wording, the operation's ownership and the
	 * failure sentence to drift apart. It is one operation either way, so an esc
	 * from either leaves nothing running behind the screen.
	 */
	const startSignIn = (entry: ProviderRegistryEntry): void => {
		if (!entry.subscriptionLogin) return
		if (!onLogin) {
			setErrorHint('Subscription sign-in is not available on this screen.')
			return
		}
		const operation = beginOperation()
		setPathVendor(null)
		setLoginEntry({ entry, value: '', status: 'starting' })
		void onLogin(entry.id as SubscriptionProviderId, operation.controller.signal)
			.then((disposition) => {
				if (!ownsOperation(operation)) return
				if (disposition === 'awaiting-input') {
					setLoginEntry({
						entry,
						value: '',
						status: 'typing',
					})
					return
				}
				finishOperation(operation)
				setLoginEntry(null)
			})
			.catch((error: unknown) => {
				if (!ownsOperation(operation)) return
				finishOperation(operation)
				setLoginEntry(null)
				setErrorHint(
					`Could not start sign-in: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
	}

	/**
	 * Follow one way in to the flow that already exists for it.
	 *
	 * The three arms are the three flows this screen already had; nothing here
	 * builds a credential. A detected path goes on to the model step exactly as
	 * Enter on a detected row always has. A credential path opens the paste field
	 * for its provider, so the value still travels `setKeyEntry` → `acceptKey` →
	 * the session credential. A sign-in path starts the operation `l` starts.
	 */
	const takePath = (path: VendorPath): void => {
		if (path.kind === 'detected') {
			const current = path.detected
			if (selectionKind === 'signed-in-subscription') {
				const operation = beginOperation()
				onSubmit({ provider: current.entry.id }, operation.controller.signal)
				return
			}
			setPathVendor(null)
			openModels(current)
			return
		}
		if (path.kind === 'credential') {
			if (!onCredential) {
				setErrorHint(`No credential can be entered for ${path.entry.label} on this screen.`)
				return
			}
			invalidateOperation()
			setPathVendor(null)
			setKeyEntry({ entry: path.entry, value: '', status: 'typing' })
			return
		}
		startSignIn(path.entry)
	}

	useInput((input, key) => {
		if (loginEntry) {
			if (key.escape) {
				invalidateOperation()
				setLoginEntry(null)
				return
			}
			if (loginEntry.status !== 'typing') return
			if (key.return) {
				void acceptLogin()
				return
			}
			if (key.backspace || key.delete) {
				setLoginEntry((current) =>
					current
						? {
								...current,
								value: current.value.slice(0, -1),
								problem: undefined,
							}
						: current,
				)
				return
			}
			if (input && !key.ctrl && !key.meta) {
				setLoginEntry((current) =>
					current ? { ...current, value: current.value + input, problem: undefined } : current,
				)
			}
			return
		}

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

		// One vendor's ways in. Modal like the two screens above: while it is up it
		// owns the keyboard, so `k`, `l` and `s` cannot act on a list that is not
		// the one on screen. Escape returns to the row that opened it rather than
		// to the top, because the cursor here is an index into this vendor's paths
		// and would otherwise be read as a position in the list.
		if (pathRow) {
			if (key.escape) {
				invalidateOperation()
				setPathVendor(null)
				setCursor(Math.max(0, rows.findIndex((row) => row.vendor === pathRow.vendor)))
				return
			}
			if (key.home || key.end || key.pageUp || key.pageDown) {
				setCursor((current) =>
					moveSelection(
						current,
						pathRow.paths.length,
						key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
					),
				)
				return
			}
			if (key.upArrow) {
				setCursor((current) => moveSelection(current, pathRow.paths.length, 'previous'))
				return
			}
			if (key.downArrow) {
				setCursor((current) => moveSelection(current, pathRow.paths.length, 'next'))
				return
			}
			if (key.return) {
				const chosen = pathRow.paths[cursorRef.current]
				if (!chosen) return
				takePath(chosen)
				return
			}
			const selected = Number.parseInt(input, 10)
			if (Number.isFinite(selected) && selected >= 1 && selected <= pathRow.paths.length) {
				setCursor(selected - 1)
			}
			return
		}

		// `k` opens credential entry for the highlighted row — see
		// `keyEntryTarget` for which provider that resolves to when the row takes
		// no typed credential. The empty screen has always offered it (there,
		// entering a credential is the only thing that can happen), and the
		// populated one used to offer it only when `keyEntryFor` was set: someone
		// with a working credential was not the person this was for. True then,
		// and false for the operator this screen was opened for, who has a saved
		// provider with no credential and a local server that happens to be
		// running — they arrived at a list that named every provider except a way
		// to fix the one they chose. The letter does not collide with anything:
		// navigation is arrows and digits, and the model step owns its own keys.
		//
		// Two phases are guarded out. The model step types into search, so `k`
		// there is a character and not a shortcut. The sign-in screen numbers its
		// own choices, so the cursor indexes those rather than these rows, and a
		// key read through it would name a provider nobody chose.
		// `l` starts a Namzu-owned subscription sign-in from the general provider
		// screen as well as the empty one. The already-signed-in choice deliberately
		// omits it: external auth exists there, and a newly stored credential would
		// lose to that external source on the required discovery re-read.
		const loginTarget = keyEntryFor ? PROVIDER_REGISTRY[keyEntryFor] : undefined
		// Sign-in is an alternative to every provider source, including an API key
		// or local server that discovery happened to find. Hiding `l` on a
		// populated first-run list made those optional sources act like a decision
		// the operator had already made. The model step remains model-only.
		const canLogin =
			onLogin !== undefined && modelPhase === null && selectionKind !== 'signed-in-subscription'
		if (canLogin && (input === 'l' || input === 'L')) {
			invalidateOperation()
			setLoginPhase(true)
			const choices = subscriptionChoices(detected)
			setCursor(
				loginTarget?.subscriptionLogin
					? Math.max(0, signInChoiceIndex(choices, loginTarget.id))
					: 0,
			)
			return
		}

		if (!modelPhase && !loginPhase && input === 's' && onSetup) { invalidateOperation(); onSetup(); return }

		const highlighted = rows[cursorRef.current]
		if (
			!loginPhase &&
			modelPhase === null &&
			keyEntryOffered &&
			(input === 'k' || input === 'K')
		) {
			const target = keyEntryTarget(highlighted, keyEntryFor)
			if (target) {
				invalidateOperation()
				setKeyEntry({ entry: target, value: '', status: 'typing' })
			} else {
				setErrorHint(
					highlighted
						? `${highlighted.label} does not take a typed credential — choose a provider that does.`
						: 'No provider here takes a typed credential.',
				)
			}
			return
		}

		if (
			modelPhase &&
			(key.leftArrow || (modelQueryRef.current === null && (input === 'p' || input === 'P')))
		) {
			invalidateOperation()
			setCursor(Math.max(0, rowIndexOfProvider(rows, modelPhase.provider.entry.id)))
			setModelPhase(null)
			return
		}

		if (key.escape) {
			if (loginPhase) {
				invalidateOperation()
				setLoginPhase(false)
				setCursor(0)
				return
			}
			// From the model step, back to the provider list rather than out of
			// the picker: escape should undo one decision, not two.
			if (modelPhase) {
				invalidateOperation()
				if (!modelPhase.returnToProviders) {
					onCancel()
					return
				}
				setCursor(Math.max(0, rowIndexOfProvider(rows, modelPhase.provider.entry.id)))
				setModelPhase(null)
				return
			}
			invalidateOperation()
			onCancel()
			return
		}

		if (loginPhase) {
			const choices = subscriptionChoices(detected)
			if (key.home || key.end || key.pageUp || key.pageDown) {
				setCursor((current) =>
					moveSelection(
						current,
						choices.length,
						key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
					),
				)
				return
			}
			if (key.upArrow) {
				setCursor((current) => moveSelection(current, choices.length, 'previous'))
				return
			}
			if (key.downArrow) {
				setCursor((current) => moveSelection(current, choices.length, 'next'))
				return
			}
			if (key.return) {
				const chosen = choices[cursorRef.current]
				if (!chosen) return
				if (chosen.kind === 'existing') {
					const operation = beginOperation()
					onSubmit({ provider: chosen.detected.entry.id }, operation.controller.signal)
					return
				}
				startSignIn(chosen.entry)
				return
			}
			const selected = Number.parseInt(input, 10)
			if (Number.isFinite(selected) && selected >= 1 && selected <= choices.length) {
				setCursor(selected - 1)
			}
			return
		}

		if (modelPhase) {
			const step = modelPhase.step
			if (!step) return // still listing; ignore input rather than act on a stale list
			const choices = filterModelChoices(step.choices, modelQueryRef.current ?? '')
			const updateQuery = (next: string | null) => {
				const selectedId = choices[cursorRef.current]?.id
				const filtered = filterModelChoices(step.choices, next ?? '')
				modelQueryRef.current = next
				setModelQuery(next)
				setCursor(
					Math.max(
						0,
						filtered.findIndex((choice) => choice.id === selectedId),
					),
				)
				setErrorHint(null)
			}
			if (key.home || key.end || key.pageUp || key.pageDown) {
				setCursor((current) =>
					moveSelection(
						current,
						choices.length,
						key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
					),
				)
				return
			}
			if (key.upArrow) {
				setCursor((current) => moveSelection(current, choices.length, 'previous'))
				return
			}
			if (key.downArrow) {
				setCursor((current) => moveSelection(current, choices.length, 'next'))
				return
			}
			if (key.return) {
				const chosen = choices[cursorRef.current]
				if (!chosen) {
					return
				}
				const operation = beginOperation()
				onSubmit(
					{ provider: modelPhase.provider.entry.id, model: chosen.id },
					operation.controller.signal,
				)
				return
			}
			if (key.ctrl && input === 'u') {
				updateQuery(null)
				return
			}
			if (key.ctrl || key.meta || key.rightArrow || key.tab) return
			if (key.backspace || key.delete) {
				const next = eraseLastChoiceGrapheme(modelQueryRef.current ?? '')
				updateQuery(next || null)
				return
			}
			if (modelQueryRef.current === null && /^\d+$/.test(input)) {
				const n = Number(input)
				if (n >= 1 && n <= choices.length) setCursor(n - 1)
				return
			}
			if (modelQueryRef.current === null && input === '/') {
				updateQuery('')
				return
			}
			const text = input.replace(/\p{Cc}/gu, '')
			if (text) updateQuery(((modelQueryRef.current ?? '') + text).slice(0, 512))
			return
		}

		if (key.home || key.end || key.pageUp || key.pageDown) {
			setCursor((current) =>
				moveSelection(
					current,
					rows.length,
					key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
				),
			)
			return
		}
		if (key.upArrow) {
			setCursor((current) => moveSelection(current, rows.length, 'previous'))
			return
		}
		if (key.downArrow) {
			setCursor((current) => moveSelection(current, rows.length, 'next'))
			return
		}
		if (key.return) {
			const row = rows[cursorRef.current]
			if (!row) {
				setErrorHint('No provider available.')
				return
			}
			// Nothing on this row can be constructed, so there is no session to open
			// and no catalogue to ask. The row stays visible on purpose — see the
			// list below — so this is the only place that can decline it, and
			// declining with the reason is the point: accepting would write the
			// choice to preferences and hand the operator a session that refuses to
			// start.
			if (!rowIsUsable(row)) {
				setErrorHint(unsupportedProviderMessage(row.detected[0]?.entry.id ?? row.vendor))
				return
			}
			// More than one provider behind this row: which of them the operator
			// means is theirs to say. Skipping the question was the defect this
			// screen was reported with — one row asked for a key while the session
			// it could have used sat above it — so the row asks instead of picking.
			if (rowNeedsChoice(row)) {
				invalidateOperation()
				setPathVendor(row.vendor)
				setCursor(0)
				return
			}
			// One provider, so Enter means exactly what it has always meant: the
			// detected session's models, or the field that takes the credential this
			// row is missing. `takePath` is the same call the choice screen makes.
			takePath(row.paths[0])
			return
		}
		// Numeric quick-select, one keystroke per row and therefore the first nine.
		// A tenth row would need two digits, and two digits cannot be told from
		// two presses without a timer between them — a wait the screen would have
		// to add to every `1` before it knew whether a `0` was coming. The list
		// says so when it grows past nine rather than leaving the rest looking
		// selectable and being unreachable.
		const n = Number.parseInt(input, 10)
		if (Number.isFinite(n) && n >= 1 && n <= Math.min(rows.length, 9)) {
			setCursor(n - 1)
		}
	})

	// Above every screen this picker draws, so the reason is on the same frame as
	// the choice it is asking for. Whether the setup hint fits beside it is
	// decided below, where the screen's line budget is; the screens that return
	// early cannot be showing it in any case, so they ask for it unconditionally.
	const buildNoticeBox = (withSetupHint: boolean) =>
		notice || onSetup ? (
			<Box paddingBottom={1}>
				<Box flexDirection="column">
					{notice ? (
						<WrappedLines text={notice} width={contentWidth} color={theme.status.warn} />
					) : null}
					{onSetup && withSetupHint && !modelPhase && !loginPhase && !loginEntry && !keyEntry ? (
						<Text dimColor>{SETUP_HINT}</Text>
					) : null}
				</Box>
			</Box>
		) : null

	if (loginEntry) {
		const waitsForDeviceApproval = loginEntry.entry.subscriptionLogin === 'device'
		const painted = loginEntry.value
			? `${'•'.repeat(Math.min(loginEntry.value.length, 32))}${loginEntry.value.length > 32 ? '…' : ''}`
			: '(nothing pasted yet)'
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				{buildNoticeBox(true)}
				<Text color={theme.accent.system} bold>
					Complete {loginEntry.entry.label} sign-in
				</Text>
				{waitsForDeviceApproval ? (
					<Text color={theme.text.muted}>
						Approve the device code shown above in your browser. esc cancels.
					</Text>
				) : (
					<>
						<Text color={theme.text.muted}>
							Paste the authorization code, or the finished browser address, then press enter. esc
							cancels.
						</Text>
						<Box paddingTop={1}>
							<Text color={loginEntry.value ? theme.text.primary : theme.text.muted}>
								{painted}
							</Text>
						</Box>
					</>
				)}
				<Box paddingTop={1} flexDirection="column">
					{loginEntry.status === 'starting' ? (
						<Text color={theme.text.muted}>
							{waitsForDeviceApproval
								? 'Waiting for browser approval…'
								: 'Starting browser sign-in…'}
						</Text>
					) : loginEntry.status === 'checking' ? (
						<Text color={theme.text.muted}>Finishing sign-in…</Text>
					) : null}
					{loginEntry.problem ? <Text color={theme.status.warn}>{loginEntry.problem}</Text> : null}
				</Box>
			</Box>
		)
	}

	if (keyEntry) {
		const { entry } = keyEntry
		// What the operator has typed SO FAR, classified live. It settles as they
		// finish pasting, and it is the same question `acceptKey` asks — so the
		// line below is a preview of the sentence they will get, not a second
		// opinion about it.
		const kind = classifyCredential(entry, keyEntry.value)
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				{buildNoticeBox(true)}
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
							Reads as a subscription token — it expires in a few hours and namzu has no refresh
							data for a pasted one.
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
				{buildNoticeBox(true)}
				<ModelStepView
					providerLabel={modelPhase.provider.entry.label}
					otherProviders={detected
						.filter(
							(provider) =>
								provider.entry.constructible && provider.entry.id !== modelPhase.provider.entry.id,
						)
						.map((provider) => provider.entry.label)}
					step={modelPhase.step}
					query={modelQuery}
					currentModel={
						currentProvider == null || currentProvider === modelPhase.provider.entry.id
							? currentModel
							: undefined
					}
					cursor={cursor}
					errorHint={errorHint}
					returnToProviders={modelPhase.returnToProviders}
					sessionOnly={modelPhase.provider.source.kind === 'session'}
				/>
			</Box>
		)
	}

	// One vendor's ways in. Drawn only where the row's paths name more than one
	// provider — every other row is answered by Enter as it always was — so this
	// is the one screen this change adds, and it is reached one way.
	if (pathRow) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				{buildNoticeBox(true)}
				<Text color={theme.accent.system} bold>
					Choose a way to use {pathRow.label}
				</Text>
				<Text color={theme.text.muted}>
					{pathRow.detected.length > 0
						? `Already usable here — ${rowSourceText(pathRow)}.`
						: 'Nothing on this device is set up for it yet.'}
				</Text>
				<Box flexDirection="column" paddingTop={1}>
					{pathRow.paths.map((path, index) => (
						<Text
							key={`${path.kind}-${pathProviderId(path)}`}
							color={index === cursor ? theme.text.primary : theme.text.muted}
						>
							{index === cursor ? '❯' : ' '} {index + 1}. {describePath(path)}
						</Text>
					))}
				</Box>
				<Box paddingTop={1} flexDirection="column">
					<Text color={theme.text.muted}>
						↑↓ or 1-{pathRow.paths.length} navigate · enter use · esc back
					</Text>
					{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
				</Box>
			</Box>
		)
	}

	if (loginPhase) {
		const choices = subscriptionChoices(detected)
		const existingCount = choices.filter((choice) => choice.kind === 'existing').length
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
				{buildNoticeBox(true)}
				<Text color={theme.accent.system} bold>
					Choose a subscription session
				</Text>
				<Text color={theme.text.muted}>
					{existingCount > 0
						? 'Reuse a signed-in device session, or start a separate Namzu-owned sign-in.'
						: 'No usable model session was found on this device. Start a new subscription sign-in.'}
				</Text>
				<Box flexDirection="column" paddingTop={1}>
					{choices.map((choice, index) => (
						<Text
							key={`${choice.kind}-${choice.kind === 'existing' ? choice.detected.entry.id : choice.entry.id}`}
							color={index === cursor ? theme.text.primary : theme.text.muted}
						>
							{index === cursor ? '❯' : ' '} {index + 1}.{' '}
							{choice.kind === 'existing'
								? `Use existing ${choice.detected.entry.label} · ${describeSource(choice.detected)}`
								: `Sign in to ${choice.entry.label} · ${
										choice.entry.subscriptionLogin === 'device' ? 'device code' : 'browser'
									}`}
						</Text>
					))}
				</Box>
				<Box paddingTop={1} flexDirection="column">
					<Text color={theme.text.muted}>
						↑↓ or 1-{choices.length} navigate · enter use · esc back
					</Text>
					{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
				</Box>
			</Box>
		)
	}

	// Non-null exactly when `k` is live on this list and has somewhere to go —
	// the same resolution the key handler performs, read from one place so the
	// hint and the keyboard cannot drift apart. It follows the highlighted row,
	// so the sentence changes as the cursor moves: a hint that kept naming the
	// saved provider while `k` acted on another row would be the defect this
	// screen's other messages are written to avoid.
	const highlightedRow = rows[cursor]
	const entryTarget = keyEntryOffered ? keyEntryTarget(highlightedRow, keyEntryFor) : null
	// The label is named only when `k` reaches past the highlighted row to the
	// provider this screen was opened for. On the ordinary path the row under
	// the cursor is the answer, and saying so again costs the line its tail: the
	// footer is one row, and the sentence with a label in it wraps.
	const namesAnotherRow =
		entryTarget !== null &&
		(highlightedRow === undefined || !rowHasProvider(highlightedRow, entryTarget.id))

	// The lines this screen spends on everything that is not a row, counted from
	// the very words it is about to draw rather than estimated, then the rows get
	// what is left.
	//
	// Two defects met here. The box used to be drawn at whatever height its rows
	// needed, and on a 60x20 terminal it was taller than the terminal: Ink
	// scrolled it, so the top border, the title, the count and the notice — the
	// sentence telling the operator what to do about a missing credential — were
	// above the top of the screen. And counting rows rather than lines was not
	// enough either, because a row whose source column wraps is two lines: the
	// count has to be the height the row actually draws, which is why the sources
	// are wrapped here rather than by the renderer.
	const oneLine = (text: string) => wrapChoiceText(text, contentWidth).length
	const emptyScreenFooter = `${onLogin ? 'l: sign in · ' : ''}↑↓ or 1-9 navigate · enter or k: enter a credential · ${
		cancelExits ? 'esc: exit namzu' : 'esc: exit picker'
	}`
	// Everything the screen draws that is not a row, in the order it is drawn:
	// the box's two borders, the notice and its blank, the title, the blank and
	// the intro, the sources, then the two or three ways off the screen with the
	// blank each one sits under, the footer with its blank, the app's status bar
	// underneath, and the line above the box that belongs to what the app has
	// already written — Ink draws this box below that, and a terminal shows the
	// last `rows` of it, so a box that fills the screen exactly loses its own top
	// border to the transcript above it. Measured at 60x20, where the boot banner
	// is two lines and the reserved line is what keeps the notice on screen.
	const emptyScreenChromeRows =
		2 +
		(notice ? noticeLines : 0) +
		(notice || onSetup ? 1 : 0) +
		(onSetup ? oneLine(SETUP_HINT) : 0) +
		1 +
		1 +
		oneLine(EMPTY_SCREEN_INTRO) +
		emptyScreenSourceLines().reduce((rows, line) => rows + oneLine(line), 0) +
		(onLogin ? 1 + oneLine(`Press l ${EMPTY_SCREEN_HINTS.signIn}`) : 0) +
		1 +
		oneLine(`Or press k ${EMPTY_SCREEN_HINTS.paste}`) +
		1 +
		oneLine(EMPTY_SCREEN_HINTS.durable) +
		1 +
		oneLine(emptyScreenFooter) +
		1 +
		TRANSCRIPT_LINE_ABOVE
	// The same, for the screen that found something: two borders, the notice and
	// its blank, the title, the subtitle and the blank under the header, the
	// heading above the not-detected block and the blank above that, the footer's
	// blank and its line, and the status bar. The heading is reserved whenever
	// the list has a not-detected block, even if the window does not reach it: a
	// row too few visible is a scroll the arrows fix, and a line too many is the
	// header scrolled away.
	const listSubtitle =
		selectionKind === 'signed-in-subscription'
			? `${detected.length} already usable · no API key required`
			: `${detected.length} detected · device sessions / Namzu sign-ins / optional keys / local probes`
	const listFooter = `↑↓ or 1-9 navigate · enter ${
		selectionKind === 'signed-in-subscription' ? 'use' : 'accept'
	}${
		entryTarget
			? ` · k enter a credential${namesAnotherRow ? ` for ${entryTarget.label}` : ''}`
			: ''
	}${
		onLogin && selectionKind !== 'signed-in-subscription' ? ' · l create a Namzu sign-in' : ''
	} · ${cancelExits ? 'esc exit namzu' : 'esc cancel'}`
	// What the screen keeps, in the order it gives things up.
	//
	// Overflow cuts the TOP of the box, and the top is where the notice sits —
	// the sentence that says why this screen is open and what to do about it.
	// Everything below is ranked against that: the title and the rows are the
	// screen, the footer is how it is left, and the two blocks that only describe
	// the screen are what go when the terminal is too short to hold them all.
	// `5 detected · device sessions / Namzu sign-ins / optional keys / local
	// probes` is a summary of what is already listed beneath it, and
	// `s provider setup` advertises a key that works from other screens too.
	const headingRows =
		rows.some((row) => row.detected.length === 0) ? 1 + oneLine(NOT_DETECTED_HEADING) : 0
	// Everything above and below the rows except those two blocks.
	const listCoreRows =
		2 +
		(notice ? noticeLines : 0) +
		(notice || onSetup ? 1 : 0) +
		1 +
		headingRows +
		1 +
		oneLine(listFooter) +
		1 +
		TRANSCRIPT_LINE_ABOVE
	const subtitleRows = 1 + oneLine(listSubtitle)
	const setupHintRows = onSetup ? oneLine(SETUP_HINT) : 0
	const screenRows = terminal.rows ?? 24
	// The row under the cursor is the one the window will not drop, so it is the
	// height the gives-way tests are measured against — a row is one line only
	// while its source column fits, and at 50 columns a variable name is three.
	const cursorRow = rows[Math.max(0, Math.min(cursor, rows.length - 1))]
	const mustKeep = cursorRow ? rowHeight(cursorRow, contentWidth, CURRENT_MARK) : 1
	const showSubtitle = screenRows - listCoreRows - setupHintRows - subtitleRows >= mustKeep
	const showSetupHint =
		screenRows - listCoreRows - (showSubtitle ? subtitleRows : 0) - setupHintRows >= mustKeep
	const listChromeRows =
		listCoreRows + (showSubtitle ? subtitleRows : 0) + (showSetupHint ? setupHintRows : 0)
	const rowBudget = Math.max(
		1,
		screenRows - (detected.length === 0 ? emptyScreenChromeRows : listChromeRows),
	)
	const listWindow = rowWindow(rows, cursor, rowBudget, contentWidth)

	if (detected.length === 0) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.status.warn} paddingX={1}>
				{buildNoticeBox(showSetupHint)}
				<Text color={theme.status.warn} bold>
					No providers detected
				</Text>
				<Box paddingTop={1} flexDirection="column">
					<WrappedLines text={EMPTY_SCREEN_INTRO} width={contentWidth} color={theme.text.primary} />
					{/* The summary line on the populated screen names the same sources;
					    this list is the same set and must not name fewer. It is the
					    screen shown to the person with no credential, so an omission
					    here is a source they are never told to try — which is exactly
					    what happened to the store below when the sign-in shipped. */}
					{emptyScreenSourceLines().map((line) => (
						<WrappedLines key={line} text={line} width={contentWidth} color={theme.text.muted} />
					))}
				</Box>
				{onLogin ? (
					<Box paddingTop={1} flexDirection="column">
						<HintLines
							text={`Press l ${EMPTY_SCREEN_HINTS.signIn}`}
							keyLetter="l"
							width={contentWidth}
							color={theme.text.primary}
						/>
					</Box>
				) : null}
				<Box paddingTop={1} flexDirection="column">
					<HintLines
						text={`Or press k ${EMPTY_SCREEN_HINTS.paste}`}
						keyLetter="k"
						width={contentWidth}
						color={theme.text.primary}
					/>
				</Box>
				<Box paddingTop={1}>
					<WrappedLines
						text={EMPTY_SCREEN_HINTS.durable}
						width={contentWidth}
						color={theme.text.secondary}
					/>
				</Box>
				{/* The same list the populated screen draws, and it is here for the
				    same reason: nothing was detected, so every row is one this
				    operator can still supply a credential for. */}
				<ProviderSetupRows
					rows={rows}
					cursor={cursor}
					currentProvider={currentProvider}
					visible={listWindow}
					contentWidth={contentWidth}
				/>
				<Box paddingTop={1}>
					<Text color={theme.text.muted}>{emptyScreenFooter}</Text>
				</Box>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			{buildNoticeBox(showSetupHint)}
			<Box flexDirection="column" paddingBottom={1}>
				<Text color={theme.accent.system} bold>
					{selectionKind === 'signed-in-subscription'
						? 'Choose a signed-in subscription'
						: 'Choose a provider'}
				</Text>
				{/* The same string the row window measured, so the line it reserves is
				    the line drawn — and the line it gave up when the terminal could
				    not hold both it and the notice above. */}
				{showSubtitle ? (
					<WrappedLines text={listSubtitle} width={contentWidth} color={theme.text.muted} />
				) : null}
			</Box>
			<ProviderSetupRows
				rows={rows}
				cursor={cursor}
				currentProvider={currentProvider}
				visible={listWindow}
				contentWidth={contentWidth}
			/>
			<Box flexDirection="column" paddingTop={1}>
				{/* Named only when the key actually does something. A hint that
				    advertises a key this screen ignores is the same defect as a
				    message whose advice cannot be followed, one size down. */}
				<WrappedLines text={listFooter} width={contentWidth} color={theme.text.muted} />
				{/* The digit shortcut is one keystroke per row, so it stops at nine
				    whatever the list does. Said out loud only once there is a row
				    behind the boundary and the sentence is worth a line. */}
				{rows.length > 9 ? (
					<Text color={theme.text.muted}>
						Rows past 9 are ↑↓ only: two digits cannot be told from two presses.
					</Text>
				) : null}
				{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
			</Box>
		</Box>
	)
}

function ModelStepView({
	providerLabel,
	otherProviders,
	step,
	query,
	currentModel,
	cursor,
	errorHint,
	returnToProviders,
	sessionOnly,
}: {
	readonly providerLabel: string
	readonly otherProviders: readonly string[]
	readonly step: ModelStep | undefined
	readonly query: string | null
	readonly currentModel?: string | null
	readonly cursor: number
	readonly errorHint: string | null
	readonly returnToProviders: boolean
	readonly sessionOnly: boolean
}) {
	const terminal = useWindowSize()
	const columns = terminal.columns ?? 80
	// The same area the provider list measures against — see `pickerContentWidth`
	// for the three deductions and what counting only two of them cost.
	const width = pickerContentWidth(columns)
	const choices = step ? filterModelChoices(step.choices, query ?? '') : []
	const noticeRows = step?.notice ? Math.ceil(choiceDisplayWidth(step.notice) / width) : 0
	const window = selectionWindow(
		choices,
		cursor,
		Math.max(1, Math.min(7, (terminal.rows ?? 24) - 7 - noticeRows)),
	)
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Box flexDirection="column" flexGrow={1} minWidth={0}>
					<Text color={theme.accent.system} bold wrap="truncate-end">
						Choose a model · {providerLabel}
					</Text>
					<Text color={theme.text.secondary} wrap="truncate-end">
						{columns < 70
							? sessionOnly
								? 'Applies to this session only.'
								: 'Session and future launches.'
							: sessionOnly
								? 'Applies to this session only (temporary credential).'
								: 'Applies to this session and future launches.'}
					</Text>
				</Box>
				{step ? (
					<Text color={theme.text.muted}>
						{choices.length > 0 ? cursor + 1 : 0}/{choices.length}
					</Text>
				) : null}
			</Box>
			{/* Use the former header spacer for a visible provider action. */}
			<Box>
				<Box flexShrink={0}>
					<Text color={theme.accent.system}>{query === null ? 'p' : '←'} change provider</Text>
				</Box>
				{otherProviders.length > 0 ? (
					<Box minWidth={0} flexShrink={1}>
						<Text color={theme.text.muted} wrap="truncate-end">
							{' · '}
							{otherProviders.slice(0, 2).map(terminalDisplayText).join(' / ')}
							{otherProviders.length > 2 ? ` / +${otherProviders.length - 2} more` : ''}
						</Text>
					</Box>
				) : null}
			</Box>
			{step === undefined ? (
				<Text color={theme.text.muted}>Asking {providerLabel} what it has…</Text>
			) : (
				<>
					<Text color={query === null ? theme.text.muted : theme.text.primary}>
						{truncateChoiceText(`Search: ${query ?? 'type or / to filter'}`, width)}
					</Text>
					{step.notice ? (
						<Text color={theme.status.warn}>{terminalDisplayText(step.notice)}</Text>
					) : null}
					<Box flexDirection="column">
						{choices.length === 0 ? (
							<Text color={theme.text.muted}>No matching models · Ctrl+U clears</Text>
						) : null}
						{window.items.map((c, visibleIndex) => {
							const index = window.start + visibleIndex
							const prefix = `${index === cursor ? '❯ ' : '  '}${index + 1}. `
							const notes =
								columns < 70
									? [
											c.id === currentModel ? '(current)' : '',
											c.note?.includes('namzu default') ? '(default)' : '',
											c.note?.includes('image input') ? '(image)' : '',
											// Rebuilt from a fixed vocabulary, so a word
											// missing from it is DROPPED rather than
											// shortened — and a `(free)` that vanishes on a
											// narrow terminal is a marker the operator
											// cannot rely on. Listed here for the same
											// reason the other two are: the note is prose
											// the model step built, and this branch has to
											// know which of it still fits. `free` is read
											// off `c.note` rather than off the prices,
											// which the choice does not carry.
											c.note?.includes('free') ? '(free)' : '',
										]
									: [
											c.note,
											c.id === currentModel && !c.note?.includes('current') ? '(current)' : '',
										]
							const note = notes.filter(Boolean).join(' ')
							const labelWidth = width - choiceDisplayWidth(prefix) - choiceDisplayWidth(note) - 1
							return (
								<Text
									key={c.id}
									color={index === cursor ? theme.accent.system : theme.text.primary}
								>
									{prefix}
									{truncateChoiceText(c.label, labelWidth)}
									{note ? ` ${note}` : ''}
								</Text>
							)
						})}
					</Box>
				</>
			)}
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					{columns < 70
						? `↑↓ · enter apply · esc ${returnToProviders ? 'back' : 'cancel'}`
						: `↑↓ · PgUp/PgDn · Home/End · enter apply · esc ${returnToProviders ? 'back' : 'cancel'}${query === null ? ' · digits select' : ' · Ctrl+U clears'}`}
				</Text>
				{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
			</Box>
		</Box>
	)
}

/**
 * The list, in the two blocks it is built as.
 *
 * Detected first and untouched: same rows, same order, same numbering, same
 * source column. The second block is appended below a heading rather than
 * merged into the first, because merging is the one thing that would move a row
 * the operator already knows the position of — and every row above this line is
 * one they may already be using.
 *
 * The appended rows carry no blank line between them. They are a work list
 * rather than a catalogue, and a machine with six of them would otherwise push
 * the box past a 24-row terminal and scroll the top of it — the detected rows —
 * out of sight. That argument is now the behaviour: `visible` is the slice that
 * fits, and when the whole list does not, the block boundary travels with the
 * window so the heading stays on screen wherever the operator has scrolled to.
 *
 * Grouping by vendor only shortened this list, and it shortened it by exactly
 * the duplicates: with one vendor drawn once instead of twice, nine
 * vendors is the most this screen can ever draw, and the digit shortcut's
 * nine-row limit is now a bound the list cannot pass rather than one it can
 * reach and overshoot. The sentence below still guards it, because a tenth
 * vendor in the registry would put the boundary back.
 */
function ProviderSetupRows({
	rows,
	cursor,
	currentProvider,
	visible,
	contentWidth,
}: {
	readonly rows: readonly VendorRow[]
	readonly cursor: number
	readonly currentProvider?: string | null
	/** The slice of `rows` that fits the screen, with the index it starts at. */
	readonly visible: SelectionWindow<VendorRow>
	readonly contentWidth: number
}) {
	// The two blocks are contiguous by construction (`providerListRows` appends),
	// so one boundary splits them and every row's number is its position in the
	// whole list, whichever block it is drawn in. The boundary is a row's own
	// state now — whether this machine has anything for it — rather than which
	// arm of a union it is in.
	const firstUndetected = rows.findIndex((row) => row.detected.length === 0)
	return (
		<Box flexDirection="column">
			{visible.items.map((row, offset) => {
				const index = visible.start + offset
				// The heading is drawn above the first not-detected row, or at the
				// top when the window has scrolled past that boundary — so the words
				// that explain the block below are never scrolled away from it.
				const heading =
					firstUndetected !== -1 &&
					(index === firstUndetected || (offset === 0 && index > firstUndetected)) ? (
						<Box key="heading" marginTop={offset === 0 ? 0 : 1}>
							<Text color={theme.text.muted}>{NOT_DETECTED_HEADING}</Text>
						</Box>
					) : null
				const detected = row.detected.length > 0
				return (
					<Fragment key={row.vendor}>
						{heading}
						{detected ? (
							<DetectedVendorRow
								row={row}
								index={index}
								selected={index === cursor}
								isCurrent={currentProvider != null && rowHasProvider(row, currentProvider)}
								contentWidth={contentWidth}
							/>
						) : (
							<UnconfiguredVendorRow
								row={row}
								index={index}
								selected={index === cursor}
								isCurrent={currentProvider != null && rowHasProvider(row, currentProvider)}
								contentWidth={contentWidth}
							/>
						)}
					</Fragment>
				)
			})}
		</Box>
	)
}

/**
 * A row for a vendor nothing on this machine can serve yet.
 *
 * Deliberately a separate component from `DetectedVendorRow` rather than one
 * component with two modes: the detected row's shape is what operators read
 * every day, and a shared body is a body where a change for the new rows moves
 * the old ones. The columns line up because both pad the label to the same
 * width; what differs is the third one, which says what is missing instead of
 * where the credential came from.
 */
function UnconfiguredVendorRow({
	row,
	index,
	selected,
	isCurrent,
	contentWidth,
}: {
	readonly row: VendorRow
	readonly index: number
	readonly selected: boolean
	readonly isCurrent: boolean
	readonly contentWidth: number
}) {
	// The variable, not "not configured": it is the one thing the operator has
	// to act on, and it is what makes the credential durable. The colour marks
	// the work still to do on a screen that is otherwise all done.
	const mark = isCurrent ? CURRENT_MARK : ''
	const source = rowSourceLines(row, contentWidth, mark)
	const markInline = rowMarkPlacement(contentWidth, mark).inline
	return (
		<Box flexDirection="column">
			<RowLine
				cursor={selected ? '›' : ' '}
				number={`${index + 1}.`}
				label={row.label}
				labelColor={selected ? theme.border.focus : theme.text.primary}
				labelBold={selected}
				numberColor={selected ? theme.border.focus : theme.text.muted}
				source={source[0] ?? ''}
				sourceColor={theme.status.warn}
				currentMark={mark}
				markInline={markInline}
			/>
			{source.slice(1).map((line, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
				<Text key={at} color={theme.status.warn}>
					{`${ROW_INDENT}${line}`}
				</Text>
			))}
			{mark !== '' && !markInline ? (
				<Text color={theme.accent.system}>{`${ROW_INDENT}${mark.trimStart()}`}</Text>
			) : null}
		</Box>
	)
}

/**
 * One row's first line: marker, number, name and source.
 *
 * The segments are children of ONE `<Text>` rather than siblings in a `<Box>`,
 * and that is load-bearing rather than stylistic. A row that reaches the edge of
 * the box is compressed, and a compressed row loses the trailing whitespace of
 * the nodes it is built from — so the cursor row, which is one column wider
 * than every other row because of its marker, came out as `› 6.DeepSeek` while
 * the rows below kept their `6. `. Children of a text node are squashed into
 * one string before anything measures or wraps them, so the space between the
 * marker and the number is not trailing anything, and neither is the gap the
 * padded name leaves before the source.
 */
function RowLine({
	cursor,
	number,
	label,
	labelColor,
	labelBold,
	numberColor,
	source,
	sourceColor,
	currentMark,
	markInline = true,
	dim = false,
}: {
	readonly cursor: string
	readonly number: string
	readonly label: string
	readonly labelColor: string
	readonly labelBold: boolean
	readonly numberColor: string
	readonly source: string
	readonly sourceColor: string
	readonly currentMark: string
	/** False when the mark is drawn on a line of its own, below the source. */
	readonly markInline?: boolean
	readonly dim?: boolean
}) {
	return (
		<Text>
			<Text color={numberColor}>{cursor}</Text> <Text color={numberColor}>{number}</Text>{' '}
			<Text color={labelColor} bold={labelBold} dimColor={dim}>
				{label.padEnd(ROW_LABEL_WIDTH)}
			</Text>
			<Text color={sourceColor} dimColor={dim}>
				{source}
			</Text>
			{currentMark && markInline ? (
				<Text color={theme.accent.system}>{currentMark}</Text>
			) : null}
		</Text>
	)
}

/**
 * A row for a vendor something on this machine can already serve.
 *
 * What was found stays what is shown. A provider this build cannot construct is
 * still genuinely on the machine, and replacing "local · localhost:1234" with
 * the refusal would hide the discovery that makes the refusal make sense. The
 * reason goes in the source column, where the row says what namzu knows about
 * it.
 *
 * The row's name is the vendor's, which is the same word the operator used to
 * reach it — and the only place the two could differ is where one vendor is two
 * registry ids, which is the case this screen was changed for.
 */
function DetectedVendorRow({
	row,
	index,
	selected,
	isCurrent,
	contentWidth,
}: {
	readonly row: VendorRow
	readonly index: number
	readonly selected: boolean
	readonly isCurrent: boolean
	readonly contentWidth: number
}) {
	const usable = rowIsUsable(row)
	const mark = isCurrent ? CURRENT_MARK : ''
	const source = rowSourceLines(row, contentWidth, mark)
	const markInline = rowMarkPlacement(contentWidth, mark).inline
	return (
		<Box flexDirection="column">
			<RowLine
				cursor={selected ? '›' : ' '}
				number={`${index + 1}.`}
				label={row.label}
				labelColor={usable ? (selected ? theme.border.focus : theme.text.primary) : theme.text.muted}
				labelBold={usable && selected}
				numberColor={selected ? theme.border.focus : theme.text.muted}
				source={source[0] ?? ''}
				sourceColor={usable ? theme.text.muted : theme.status.warn}
				currentMark={mark}
				markInline={markInline}
				dim={!usable}
			/>
			{source.slice(1).map((line, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
				<Text key={at} color={usable ? theme.text.muted : theme.status.warn} dimColor={!usable}>
					{`${ROW_INDENT}${line}`}
				</Text>
			))}
			{mark !== '' && !markInline ? (
				<Text color={theme.accent.system} dimColor={!usable}>
					{`${ROW_INDENT}${mark.trimStart()}`}
				</Text>
			) : null}
		</Box>
	)
}

/**
 * Text this screen wraps before the renderer sees it.
 *
 * Every sentence whose line count the box is sized against goes through here,
 * for two reasons that are the same reason. Ink's wrapping keeps the space it
 * broke at, so a sentence that ran onto a second line began it one column to
 * the right of the first — inside a box whose whole point is that its left edge
 * is straight. And a line count the screen reserved has to be the line count
 * the screen draws, which it is only if the screen is the one wrapping.
 */
function WrappedLines({
	text,
	width,
	color,
}: {
	readonly text: string
	readonly width: number
	readonly color: string
}) {
	return (
		<>
			{wrapChoiceText(text, width).map((line, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
				<Text key={at} color={color}>
					{line || ' '}
				</Text>
			))}
		</>
	)
}

/**
 * The same, for a sentence that names a key the operator presses.
 *
 * The key is picked out in the accent colour wherever the wrap puts it, which
 * is why this splits the line it wrapped rather than the text it was given: a
 * span placed before wrapping is a span the wrap can move.
 */
function HintLines({
	text,
	keyLetter,
	width,
	color,
}: {
	readonly text: string
	readonly keyLetter: string
	readonly width: number
	readonly color: string
}) {
	return (
		<>
			{wrapChoiceText(text, width).map((line, at) => {
				const words = line.split(' ')
				const key = words.indexOf(keyLetter)
				if (key < 0) {
					// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
					return (
						<Text key={at} color={color}>
							{line}
						</Text>
					)
				}
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity beyond their order.
				return (
					<Text key={at} color={color}>
						{`${words.slice(0, key).join(' ')}${key > 0 ? ' ' : ''}`}
						<Text color={theme.accent.system}>{keyLetter}</Text>
						{key < words.length - 1 ? ` ${words.slice(key + 1).join(' ')}` : ''}
					</Text>
				)
			})}
		</>
	)
}

/**
 * A row's third column, wrapped to the columns the row has left for it.
 *
 * Wrapped here rather than by the renderer because a row's height is part of
 * the box's height, and the row window budgets in lines: Ink wrapping a row the
 * screen had measured as one line tall is exactly how the box grew past the
 * terminal and pushed its own header off the top. The count below draws the
 * same lines it measures, so the two cannot disagree.
 */
function rowSourceLines(
	row: VendorRow,
	contentWidth: number,
	currentMark = '',
): readonly string[] {
	const text = row.detected.length > 0 ? rowSourceText(row) : (rowCredentialNeed(row) ?? '')
	const available = Math.max(1, rowMarkPlacement(contentWidth, currentMark).sourceColumns)
	return capChoiceLines(wrapChoiceText(text, available), MAX_SOURCE_LINES, available)
}

/**
 * Where a row's `← current` mark goes at this width, and what it leaves the
 * source.
 *
 * Inline while the source keeps enough columns to be readable, and on a line of
 * its own when it does not. The mark is twelve columns, and at 60 columns
 * sharing the line with it left the source nine — which broke
 * `DEEPSEEK_API_KEY` across three lines to say what the operator already knew
 * from choosing this row.
 */
function rowMarkPlacement(
	contentWidth: number,
	currentMark: string,
): { readonly inline: boolean; readonly sourceColumns: number } {
	const width = contentWidth - ROW_PREFIX_WIDTH
	if (currentMark === '') return { inline: false, sourceColumns: width }
	const shares = width - choiceDisplayWidth(currentMark) >= MIN_SOURCE_COLUMNS
	return {
		inline: shares,
		sourceColumns: Math.max(1, width - (shares ? choiceDisplayWidth(currentMark) : 0)),
	}
}

/**
 * The lines one row occupies at this width.
 *
 * A row that carries the mark on a line below its source is one line taller,
 * which is why the placement is decided by a function both the measurement and
 * the renderer call: a height the box did not reserve is the header scrolled off
 * the top of the terminal.
 */
function rowHeight(row: VendorRow, contentWidth: number, currentMark = ''): number {
	const lines = rowSourceLines(row, contentWidth, currentMark).length
	const below = currentMark !== '' && !rowMarkPlacement(contentWidth, currentMark).inline
	return below ? lines + 1 : lines
}

/**
 * The rows that fit a line budget, with the row under the cursor among them.
 *
 * A window over ROWS and a budget in LINES, because a row is one line only
 * while its source column fits beside the label. The cursor's row is always
 * drawn whole — a cursor scrolled out of its own window is a screen the arrows
 * cannot explain — and the rows around it fill what is left, half the budget
 * above it when there is that much to show.
 */
function rowWindow(
	rows: readonly VendorRow[],
	cursor: number,
	budget: number,
	contentWidth: number,
): SelectionWindow<VendorRow> {
	if (rows.length === 0) return { start: 0, items: [] }
	// The row under the cursor is the marked one when a provider is in force, and
	// a marked row may be a line taller: see `rowHeight`.
	const marked = rows[Math.max(0, Math.min(cursor, rows.length - 1))]
	const heights = rows.map((row) =>
		rowHeight(row, contentWidth, row === marked ? CURRENT_MARK : ''),
	)
	const at = Math.max(0, Math.min(cursor, rows.length - 1))
	let start = at
	let used = heights[at] ?? 1
	const half = Math.max(1, Math.floor(budget / 2))
	while (start > 0 && used < half && used + (heights[start - 1] ?? 1) <= budget) {
		start -= 1
		used += heights[start] ?? 1
	}
	let end = at + 1
	while (end < rows.length && used + (heights[end] ?? 1) <= budget) {
		used += heights[end] ?? 1
		end += 1
	}
	return { start, items: rows.slice(start, end) }
}

/**
 * What a detected row's third column says: where what it found came from.
 *
 * Every source is named, not the first one. A vendor reached two ways at once —
 * an exported key and a signed-in session — has two usable credentials, and
 * naming one of them would be the row choosing for an operator who has not
 * chosen anything yet. `+` joins them because the sources are joined by ` · `
 * internally, and a list of four items reads as four discoveries.
 */
function rowSourceText(row: VendorRow): string {
	const text = row.detected.map(describeSource).join(' + ')
	return rowIsUsable(row) ? text : `${text} · unavailable in this build`
}

/**
 * One way in, as the line that offers it.
 *
 * Each line borrows the wording of the screen it leads to — "Use existing …" is
 * the sign-in screen's phrase for a session already on the device, "Sign in to …
 * · device code" is its phrase for a new one, "a credential for …" is the paste
 * field's title — so the operator recognises where a line goes before pressing
 * enter on it.
 */
function describePath(path: VendorPath): string {
	switch (path.kind) {
		case 'detected':
			return `Use existing ${path.detected.entry.label} · ${describeSource(path.detected)}`
		case 'credential':
			return `Enter a credential for ${path.entry.label} · ${credentialNeed(path.entry)}`
		case 'sign-in':
			return `Sign in to ${path.entry.label} · ${
				path.entry.subscriptionLogin === 'device' ? 'device code' : 'browser'
			}`
	}
}

function describeSource(d: DetectedProvider): string {
	switch (d.source.kind) {
		case 'env':
			return `env · ${d.source.envName}`
		case 'public':
			return 'free models · no API key'
		case 'opencode-file':
			return 'OpenCode API key · this device'
		case 'probe':
			return `local · ${d.source.url.replace(/^https?:\/\//, '')}`
		case 'keychain':
			return `keychain · ${d.source.service}`
		case 'claude-file':
			return 'Claude session · this device'
		case 'gemini-file':
			return 'Gemini session · this device'
		case 'codex-file':
			return 'Codex session · this device'
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
