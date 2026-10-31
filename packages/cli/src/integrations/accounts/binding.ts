/**
 * Binding a session to an account without touching the saved preferences.
 *
 * The account a session runs under is its own: `/auth` and `--account` shape
 * the chain this session starts from and nothing else. Preferences on disk are
 * what a plain `namzu` starts from, and they change only when a person pins an
 * account there.
 */

import {
	type Account,
	type AccountRegistry,
	DEFAULT_ACCOUNT_LABEL,
	parseAccountId,
} from '@namzu/sdk'

import type { Preferences, ProviderChoice } from '../providers/preferences.js'
import type { ProviderId } from '../providers/registry.js'

export function isDefaultAccountId(id: string | undefined): boolean {
	return id === undefined || parseAccountId(id)?.label === DEFAULT_ACCOUNT_LABEL
}

/**
 * The chain a session on `account` starts from. The account's provider
 * becomes the head; its saved model is kept only when the head already was that
 * provider, or else the account's own default model is used. Members after the
 * head that name the same provider are dropped: a fallback would read that
 * provider's usual sign-in and quietly leave the account the person chose.
 */
export function bindAccount(
	prefs: Preferences,
	account: Pick<Account, 'id' | 'provider' | 'defaultModel'>,
	options: { readonly model?: string } = {},
): Preferences {
	const head = prefs.providers[0]
	const provider = account.provider as ProviderId
	const keptModel = head?.id === provider ? head.model : undefined
	const model = options.model ?? account.defaultModel ?? keptModel
	const choice: ProviderChoice = {
		id: provider,
		...(model !== undefined ? { model } : {}),
		...(isDefaultAccountId(account.id) ? {} : { account: account.id }),
	}
	return {
		...prefs,
		providers: [choice, ...prefs.providers.slice(1).filter((member) => member.id !== provider)],
	}
}

/** The account id the head of this chain names, if it is not the usual sign-in. */
export function accountOfPreferences(prefs: Preferences): string | undefined {
	const id = prefs.providers[0]?.account
	return id === undefined || isDefaultAccountId(id) ? undefined : id
}

/** Look up the account a `--account` value names: `<label>` or `<provider>:<label>`. */
export function findAccountByName(
	registry: Pick<AccountRegistry, 'list' | 'get'>,
	name: string,
): { readonly account: Account } | { readonly error: string } {
	const text = name.trim()
	if (text.length === 0) return { error: 'Name an account: --account <label>.' }
	if (parseAccountId(text)) {
		const exact = registry.get(text)
		if (exact) return { account: exact }
	}
	const matches = registry.list().filter((account) => account.label === text)
	if (matches.length === 1 && matches[0]) return { account: matches[0] }
	if (matches.length > 1) {
		return {
			error: `More than one account is called "${text}": ${matches.map((a) => a.id).join(', ')}. Use provider:label.`,
		}
	}
	return {
		error: `There is no account called "${text}". Run namzu, then /auth to add or pick one.`,
	}
}
