/**
 * Accounts: more than one credential for one provider, chosen per session.
 *
 * An account is a provider plus a label. Today's single sign-in for each
 * provider is the account labelled `default`; it is read exactly as before and
 * is never stored here. Further accounts are one of two kinds: a private
 * Codex home directory that holds its own `auth.json`, or a labelled API key.
 *
 * @experimental
 */

/** `<provider>:<label>`. The label is `[a-z0-9-]{1,32}`; `default` is reserved for today's sign-in. */
export type AccountId = string

/** The label of the account that wraps a provider's existing sign-in. */
export const DEFAULT_ACCOUNT_LABEL = 'default'

/** Where an account's credential comes from. */
export type AccountSource =
	/** The provider's existing sign-in, read the way it was before accounts existed. Synthesised, never stored. */
	| { readonly kind: 'existing-default' }
	/** A private Codex home: `dir/auth.json` was written by `codex login` run with `CODEX_HOME=dir`. */
	| { readonly kind: 'codex-home'; readonly dir: string }
	/** A labelled API key. `keyRef` names a slot in the registry's secret map; the key itself is never in a log. */
	| { readonly kind: 'api-key'; readonly keyRef: string }

export interface Account {
	readonly id: AccountId
	readonly provider: string
	readonly label: string
	readonly source: AccountSource
	readonly createdAt: string
	/** A short human tag such as the tail of the provider's account id. Never a token. */
	readonly display?: string
	/** API-key accounts only: the endpoint this key belongs to. A different endpoint is a different account. */
	readonly baseUrl?: string
	/** API-key accounts only: the model a session on this account starts with. */
	readonly defaultModel?: string
}

/** What `add` accepts. The id, the creation time and the key slot are assigned by the registry. */
export type NewAccount =
	| {
			readonly provider: string
			readonly label: string
			readonly kind: 'api-key'
			readonly apiKey: string
			readonly display?: string
			/** An http(s) endpoint without embedded credentials. */
			readonly baseUrl?: string
			readonly defaultModel?: string
	  }
	| {
			readonly provider: 'codex'
			readonly label: string
			readonly kind: 'codex-home'
			/** Defaults to `<home>/accounts/codex/<label>`; must stay inside `<home>/accounts`. */
			readonly dir?: string
			readonly display?: string
	  }

/** A credential ready to put on a request. Never logged. */
export interface ResolvedAccountCredential {
	readonly kind: 'api-key' | 'oauth'
	readonly accessToken: string
	/** Set for an API-key account that names its own endpoint. */
	readonly baseUrl?: string
	/** Set for an API-key account that names a starting model. */
	readonly defaultModel?: string
	/** The provider-side account identity some drivers send as a header. */
	readonly accountId?: string
	/** Epoch milliseconds, when the credential expires. */
	readonly expiresAt?: number
}

/** The credential behind an account is gone or unusable; the caller should offer another account. */
export class CredentialWithdrawnError extends Error {
	override readonly name = 'CredentialWithdrawnError'
	constructor(
		readonly accountId: AccountId,
		message: string,
	) {
		super(message)
	}
}

/** A registry mutation was refused: bad label, duplicate, unknown account, unreadable store. */
export class AccountRegistryError extends Error {
	override readonly name = 'AccountRegistryError'
}

/** Another owner holds the lock for a store or an account's credential file. */
export class AccountLockError extends Error {
	override readonly name = 'AccountLockError'
	constructor(
		readonly lockPath: string,
		message: string,
	) {
		super(message)
	}
}

/**
 * Source-specific readers. The registry owns the bookkeeping; the code that
 * knows how a provider's sign-in is discovered or refreshed lives with the
 * provider and is handed in here.
 */
export interface AccountCredentialReaders {
	/** Read the provider's existing sign-in. Throws {@link CredentialWithdrawnError} when there is none. */
	readonly existingDefault?: (
		provider: string,
		signal: AbortSignal,
	) => Promise<ResolvedAccountCredential>
	/**
	 * Read, and refresh when due, the credential in a private Codex home. An
	 * implementation holds `withAccountRefreshLock` across the read-refresh-write
	 * so two processes never spend one refresh token twice.
	 */
	readonly codexHome?: (
		account: Account & { readonly source: { readonly kind: 'codex-home'; readonly dir: string } },
		signal: AbortSignal,
	) => Promise<ResolvedAccountCredential>
}

export interface AccountRegistry {
	/** Stored accounts plus the synthesised `default` of each known provider. Defaults first, then creation order. */
	list(provider?: string): Account[]
	get(id: AccountId): Account | undefined
	add(account: NewAccount): Account
	/** Change an account's label; its id changes with it. Sessions bound to the old id fall back to `default`. */
	rename(id: AccountId, label: string): Account
	/** Remove a stored account and its secret or private Codex directory. The `default` account cannot be removed. */
	remove(id: AccountId): void
	resolve(id: AccountId, signal: AbortSignal): Promise<ResolvedAccountCredential>
	/** The next account of `provider` not in `excluding`, for the "continue with another account" picker. */
	next(provider: string, excluding: readonly AccountId[]): Account | undefined
}
