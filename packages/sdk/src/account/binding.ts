import type { AccountBoundRecord } from '../types/session/records.js'
import { accountId } from './registry.js'
import { type AccountId, type AccountRegistry, DEFAULT_ACCOUNT_LABEL } from './types.js'

export type AccountBoundReason = AccountBoundRecord['reason']

/** The fields of an `account_bound` record that a writer supplies; the log adds the envelope. */
export function accountBoundPayload(
	id: AccountId,
	provider: string,
	reason: AccountBoundReason,
): Pick<AccountBoundRecord, 'type' | 'accountId' | 'provider' | 'reason'> {
	return { type: 'account_bound', accountId: id, provider, reason }
}

export interface BoundAccount {
	readonly accountId: AccountId
	/** The recorded account was removed; the session continues on `<provider>:default`. */
	readonly fellBack: boolean
}

/**
 * The account a session continues under, from its replayed records: the last
 * `account_bound` for `provider`, else that provider's `default`. When the
 * recorded account has since been removed the result is the default with
 * `fellBack` set, so the caller can say so and append a `user_switch` record.
 */
export function resolveBoundAccount(
	records: readonly { readonly type: string }[],
	provider: string,
	registry: Pick<AccountRegistry, 'get'>,
): BoundAccount {
	const fallback = accountId(provider, DEFAULT_ACCOUNT_LABEL)
	let last: AccountBoundRecord | undefined
	for (const record of records) {
		if (record.type === 'account_bound' && (record as AccountBoundRecord).provider === provider) {
			last = record as AccountBoundRecord
		}
	}
	if (!last) return { accountId: fallback, fellBack: false }
	if (registry.get(last.accountId)) return { accountId: last.accountId, fellBack: false }
	return { accountId: fallback, fellBack: last.accountId !== fallback }
}
