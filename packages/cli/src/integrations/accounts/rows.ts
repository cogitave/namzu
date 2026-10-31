/**
 * The account picker's rows: provider, label, state, and which one this
 * session is on. Pure, so the same rows can be tested without a terminal.
 */

import type { Account } from '@namzu/sdk'

import type { AccountActivity } from './activity.js'

export type AccountState =
	| { readonly kind: 'ready' }
	| { readonly kind: 'limited'; readonly until: number }
	| { readonly kind: 'needs-sign-in' }

export interface AccountRow {
	readonly account: Account
	readonly state: AccountState
	readonly current: boolean
	readonly lastUsed?: number
}

export interface AccountRowsInput {
	readonly accounts: readonly Account[]
	readonly activity: AccountActivity
	readonly currentId: string | undefined
	readonly now: number
	/** Whether the account's credential can be read now. Defaults to yes. */
	readonly signedIn?: (account: Account) => boolean
	/** Providers that cannot be used at all here (a default with no sign-in), so their default is hidden. */
	readonly hidden?: (account: Account) => boolean
}

const PRODUCT: Readonly<Record<string, string>> = {
	anthropic: 'Claude',
	codex: 'Codex',
	openai: 'OpenAI',
	google: 'Gemini',
	deepseek: 'DeepSeek',
	openrouter: 'OpenRouter',
	zen: 'Zen',
	'zen-go': 'Zen Go',
}

/** What a person calls the product behind a provider id. */
export function accountProductName(provider: string): string {
	return PRODUCT[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function accountState(
	account: Account,
	activity: AccountActivity,
	now: number,
	signedIn: (account: Account) => boolean = () => true,
): AccountState {
	if (!signedIn(account)) return { kind: 'needs-sign-in' }
	const until = activity.limitedUntil[account.id]
	if (until !== undefined && until > now) return { kind: 'limited', until }
	return { kind: 'ready' }
}

/** Last-used first; accounts never used keep the registry's order (defaults, then creation). */
export function accountRows(input: AccountRowsInput): AccountRow[] {
	const rows = input.accounts
		.filter((account) => !input.hidden?.(account))
		.map((account, index) => ({
			index,
			row: {
				account,
				state: accountState(account, input.activity, input.now, input.signedIn),
				current: account.id === input.currentId,
				...(input.activity.lastUsed[account.id] !== undefined
					? { lastUsed: input.activity.lastUsed[account.id] }
					: {}),
			} as AccountRow,
		}))
	rows.sort((a, b) => {
		const left = a.row.lastUsed ?? Number.NEGATIVE_INFINITY
		const right = b.row.lastUsed ?? Number.NEGATIVE_INFINITY
		if (left !== right) return right - left
		return a.index - b.index
	})
	return rows.map((entry) => entry.row)
}

/** `3:40 pm` today, `Tue 3:40 pm` on another day. */
export function formatResetTime(until: number, now: number, locale?: string): string {
	const at = new Date(until)
	const today = new Date(now)
	const sameDay =
		at.getFullYear() === today.getFullYear() &&
		at.getMonth() === today.getMonth() &&
		at.getDate() === today.getDate()
	const time = at.toLocaleTimeString(locale, {
		hour: 'numeric',
		minute: '2-digit',
	})
	return sameDay ? time : `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
}

export function describeState(state: AccountState, now: number, locale?: string): string {
	switch (state.kind) {
		case 'ready':
			return 'ready'
		case 'limited':
			return `limited until ${formatResetTime(state.until, now, locale)}`
		case 'needs-sign-in':
			return 'needs sign-in'
	}
}

/** The endpoint's host, for an API-key account that names its own. */
export function endpointHost(account: Account): string | undefined {
	if (account.baseUrl === undefined) return undefined
	try {
		return new URL(account.baseUrl).host
	} catch {
		return undefined
	}
}
