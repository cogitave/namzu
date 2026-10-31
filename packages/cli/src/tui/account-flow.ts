/**
 * The `/auth` screens as plain data: the account picker's rows, the steps of
 * adding an account, and the words for a spent allowance. App owns the keys
 * and the side effects; everything that decides what a screen says lives here
 * so it can be tested without a terminal.
 */

import { type Account, AccountRegistryError, parseAccountId } from '@namzu/sdk'

import type { AccountActivity } from '../integrations/accounts/activity.js'
import { API_KEY_ACCOUNT_PROVIDERS } from '../integrations/accounts/open.js'
import {
	accountProductName,
	accountRows,
	describeState,
	endpointHost,
} from '../integrations/accounts/rows.js'
import type { ChoicePickerOption } from './ChoicePicker.js'

/** The picker value of the row that starts adding an account. */
export const ADD_ACCOUNT_VALUE = '__add_account__'

export interface AccountPickerModel {
	readonly title: string
	readonly notice?: string
	readonly values: readonly string[]
	readonly options: readonly ChoicePickerOption[]
}

export interface AccountPickerInput {
	readonly accounts: readonly Account[]
	readonly activity: AccountActivity
	readonly currentId: string | undefined
	readonly now: number
	readonly signedIn: (account: Account) => boolean
	/** The usual sign-in of a provider that has none here is not offered. */
	readonly hasUsualSignIn: (provider: string) => boolean
	readonly locale?: string
	/** Set when the picker was opened by a spent allowance. */
	readonly limitedLabel?: string
}

export function buildAccountPicker(input: AccountPickerInput): AccountPickerModel {
	const rows = accountRows({
		accounts: input.accounts,
		activity: input.activity,
		currentId: input.currentId,
		now: input.now,
		signedIn: input.signedIn,
		hidden: (account) => account.label === 'default' && !input.hasUsualSignIn(account.provider),
	})
	const options: ChoicePickerOption[] = rows.map((row) => {
		const { account } = row
		const host = endpointHost(account)
		const detail = [describeState(row.state, input.now, input.locale), host]
			.filter((part): part is string => part !== undefined)
			.join(' · ')
		return {
			label: `${accountProductName(account.provider)} · ${account.label}`,
			description: input.activity.autoSwitch[account.id]
				? `${detail} · switches automatically`
				: detail,
			current: row.current,
			searchText: `${account.provider} ${account.label} ${host ?? ''}`,
			...(row.state.kind === 'needs-sign-in'
				? { selectedDescription: 'Needs to be signed in again. Pick Add an account to do that.' }
				: {}),
		}
	})
	const values: string[] = rows.map((row) => row.account.id)
	options.push({
		label: 'Add an account…',
		description: 'A Codex sign-in or an API key',
		ruleBefore: rows.length > 0,
		searchText: 'add new account',
	})
	values.push(ADD_ACCOUNT_VALUE)
	return {
		title: input.limitedLabel ? `${input.limitedLabel} has used up its allowance` : 'Accounts',
		notice: input.limitedLabel
			? 'Choose another account to continue this reply.'
			: 'Applies to this conversation from its next reply · other conversations are unaffected',
		values,
		options,
	}
}

/** Picker hints for the account list. */
export const ACCOUNT_PICKER_HINTS = [
	{ text: 'type to filter', rank: 3 },
	{ text: '↑↓ select', rank: 5 },
	{ text: 'enter use', rank: 5 },
	{ text: 'ctrl+r rename', rank: 2 },
	{ text: 'ctrl+x remove', rank: 2 },
	{ text: 'ctrl+a switch automatically', rank: 1 },
	{ text: 'esc back', rank: 4 },
] as const

export const ADD_KIND_VALUES = ['codex', 'api-key'] as const
export type AddKind = (typeof ADD_KIND_VALUES)[number]

export function addKindPicker(): {
	title: string
	values: readonly AddKind[]
	options: readonly ChoicePickerOption[]
} {
	return {
		title: 'Add an account',
		values: ADD_KIND_VALUES,
		options: [
			{
				label: 'Codex',
				description: 'Sign in with ChatGPT in your browser, using the official Codex sign-in.',
			},
			{
				label: 'API key',
				description: 'A labelled key for a provider, with an optional address and starting model.',
			},
		],
	}
}

export function apiKeyProviderPicker(): {
	title: string
	values: readonly string[]
	options: readonly ChoicePickerOption[]
} {
	return {
		title: 'Which provider is the key for?',
		values: API_KEY_ACCOUNT_PROVIDERS,
		options: API_KEY_ACCOUNT_PROVIDERS.map((provider) => ({
			label: accountProductName(provider),
			description:
				provider === 'openai'
					? 'OpenAI, or any service that speaks its API (give its address next)'
					: '',
		})),
	}
}

export type AccountWizard =
	| { readonly kind: 'codex' }
	| {
			readonly kind: 'api-key'
			readonly provider: string
			readonly step: 'baseUrl' | 'key' | 'label' | 'model'
			readonly baseUrl?: string
			readonly key?: string
			readonly label?: string
	  }
	| { readonly kind: 'rename'; readonly id: string }

export interface WizardPrompt {
	readonly title: string
	readonly placeholder: string
	readonly initialValue: string
	readonly emptyNotice: string
	readonly mask?: boolean
	readonly allowEmpty?: boolean
}

const LABEL = /^[a-z0-9-]{1,32}$/

/** A label nobody has used yet, such as `work-2`. */
export function suggestLabel(base: string, taken: readonly string[]): string {
	const root =
		base
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.slice(0, 28) || 'account'
	if (!taken.includes(root) && root !== 'default') return root
	for (let n = 2; n < 1000; n++) {
		const candidate = `${root}-${n}`
		if (!taken.includes(candidate)) return candidate
	}
	return `${root}-x`
}

export function promptFor(wizard: AccountWizard, taken: readonly string[]): WizardPrompt {
	if (wizard.kind === 'codex') {
		return {
			title: 'Name this Codex account',
			placeholder: 'work',
			initialValue: suggestLabel('codex', taken),
			emptyNotice: 'A name is required. Press Esc to cancel.',
		}
	}
	if (wizard.kind === 'rename') {
		return {
			title: 'New name for this account',
			placeholder: 'work',
			initialValue: '',
			emptyNotice: 'A name is required. Press Esc to cancel.',
		}
	}
	const product = accountProductName(wizard.provider)
	switch (wizard.step) {
		case 'baseUrl':
			return {
				title: `${product} address (optional)`,
				placeholder: 'Press Enter to use the usual address',
				initialValue: '',
				emptyNotice: '',
				allowEmpty: true,
			}
		case 'key':
			return {
				title: `${product} API key`,
				placeholder: 'Paste the key · it is saved privately and never shown',
				initialValue: '',
				emptyNotice: 'A key is required. Press Esc to cancel.',
				mask: true,
			}
		case 'label':
			return {
				title: 'Name this account',
				placeholder: 'work',
				initialValue: suggestLabel(wizard.provider, taken),
				emptyNotice: 'A name is required. Press Esc to cancel.',
			}
		case 'model':
			return {
				title: 'Starting model (optional)',
				placeholder: 'Press Enter to use the usual model',
				initialValue: '',
				emptyNotice: '',
				allowEmpty: true,
			}
	}
}

export function validateLabel(value: string, taken: readonly string[]): string | undefined {
	if (value === 'default') return 'The name "default" belongs to your usual sign-in.'
	if (!LABEL.test(value)) {
		return 'A name is 1 to 32 characters: lowercase letters, digits and hyphens.'
	}
	if (taken.includes(value)) return `There is already an account called "${value}".`
	return undefined
}

export type WizardStep =
	| { readonly kind: 'next'; readonly wizard: AccountWizard }
	| {
			readonly kind: 'add-key'
			readonly provider: string
			readonly key: string
			readonly label: string
			readonly baseUrl?: string
			readonly defaultModel?: string
	  }
	| { readonly kind: 'sign-in-codex'; readonly label: string }
	| { readonly kind: 'rename'; readonly id: string; readonly label: string }
	| { readonly kind: 'retry'; readonly notice: string }

/** What a typed answer does to the wizard. `taken` is the labels already used for the provider. */
export function advanceWizard(
	wizard: AccountWizard,
	value: string,
	taken: readonly string[],
): WizardStep {
	const text = value.trim()
	if (wizard.kind === 'codex') {
		const problem = validateLabel(text, taken)
		return problem ? { kind: 'retry', notice: problem } : { kind: 'sign-in-codex', label: text }
	}
	if (wizard.kind === 'rename') {
		const problem = validateLabel(text, taken)
		return problem
			? { kind: 'retry', notice: problem }
			: { kind: 'rename', id: wizard.id, label: text }
	}
	switch (wizard.step) {
		case 'baseUrl': {
			if (text.length === 0) return { kind: 'next', wizard: { ...wizard, step: 'key' } }
			let url: URL
			try {
				url = new URL(text)
			} catch {
				return { kind: 'retry', notice: 'That is not a web address. Start it with https://.' }
			}
			if (url.protocol !== 'https:' && url.protocol !== 'http:') {
				return { kind: 'retry', notice: 'The address must start with https:// or http://.' }
			}
			if (url.username !== '' || url.password !== '') {
				return { kind: 'retry', notice: 'Leave the user name and password out of the address.' }
			}
			return { kind: 'next', wizard: { ...wizard, step: 'key', baseUrl: text } }
		}
		case 'key':
			return text.length === 0
				? { kind: 'retry', notice: 'A key is required.' }
				: { kind: 'next', wizard: { ...wizard, step: 'label', key: text } }
		case 'label': {
			const problem = validateLabel(text, taken)
			return problem
				? { kind: 'retry', notice: problem }
				: { kind: 'next', wizard: { ...wizard, step: 'model', label: text } }
		}
		case 'model': {
			if (/\s/.test(text)) return { kind: 'retry', notice: 'A model is one name, without spaces.' }
			return {
				kind: 'add-key',
				provider: wizard.provider,
				key: wizard.key ?? '',
				label: wizard.label ?? '',
				...(wizard.baseUrl !== undefined ? { baseUrl: wizard.baseUrl } : {}),
				...(text.length > 0 ? { defaultModel: text } : {}),
			}
		}
	}
}

/** The first step after the provider is chosen. */
export function startApiKeyWizard(provider: string): AccountWizard {
	return {
		kind: 'api-key',
		provider,
		step: 'baseUrl',
	}
}

/**
 * The plain words for a spent allowance. `until` is when it is expected back,
 * if the provider said; the next step is the one quiet action under it.
 */
export function describeSpentAllowance(
	label: string,
	until: number | undefined,
	now: number,
	formatTime: (until: number, now: number) => string,
): string {
	return until === undefined
		? `${label} has used up its allowance.`
		: `${label} has used up its allowance until about ${formatTime(until, now)}.`
}

export const CONTINUE_WITH_ANOTHER_ACCOUNT = 'enter continue with another account · esc dismiss'

/** A plain sentence for something that went wrong while managing accounts. */
export function accountProblem(error: unknown, fallback: string): string {
	return error instanceof AccountRegistryError ? error.message : fallback
}

/** The provider whose accounts a wizard is adding to or renaming within. */
export function wizardProvider(wizard: AccountWizard): string {
	if (wizard.kind === 'codex') return 'codex'
	if (wizard.kind === 'api-key') return wizard.provider
	return parseAccountId(wizard.id)?.provider ?? ''
}
