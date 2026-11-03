/**
 * What a terminal running inside a workspaces host tells it about its account: the
 * label of a non-usual account the conversation is on, and whether that
 * account is out of allowance. Pure, so the same answer is checked without a
 * terminal.
 */

import { parseAccountId } from '@namzu/sdk'

import type { AccountActivity } from './activity.js'
import { isDefaultAccountId } from './binding.js'
import { MAY_BE_LIMITED_WINDOW_MS } from './rows.js'

export interface HostAccountFacts {
	/** The account's label; absent on the provider's usual sign-in. */
	readonly account?: string
	readonly limited: boolean
	/** When the allowance is expected back (epoch ms); absent when not known. */
	readonly limitedUntil?: number
}

export function hostAccountFacts(input: {
	readonly accountId: string | undefined
	/** The terminal is stopped on a spent allowance, waiting for a choice. */
	readonly stopped: boolean
	readonly activity: AccountActivity | undefined
	readonly now: number
}): HostAccountFacts {
	const { accountId, activity, now } = input
	const label = isDefaultAccountId(accountId)
		? undefined
		: accountId === undefined
			? undefined
			: parseAccountId(accountId)?.label
	const until = accountId === undefined ? undefined : activity?.limitedUntil[accountId]
	const noted = accountId === undefined ? undefined : activity?.mayBeLimited[accountId]
	const liveUntil = until !== undefined && until > now ? until : undefined
	const maybe = noted !== undefined && now - noted < MAY_BE_LIMITED_WINDOW_MS
	const limited = input.stopped || liveUntil !== undefined || maybe
	return {
		...(label ? { account: label } : {}),
		limited,
		...(limited && liveUntil !== undefined ? { limitedUntil: liveUntil } : {}),
	}
}
