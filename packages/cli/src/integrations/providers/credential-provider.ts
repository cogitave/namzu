import type { CredentialDescription, CredentialProvider, ResolvedCredential } from '@namzu/sdk'
import { NamzuError } from '@namzu/sdk'

import {
	clearStoredSubscriptionCredential,
	credentialsPath,
	readStoredSubscriptionCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'

/**
 * The CLI's hardened credential file, as a writable `CredentialProvider`.
 *
 * The seam had no writable implementation, so `describe()` reported
 * `writable: false` everywhere and nothing could rotate a credential
 * through it — the OAuth refresh wrote straight into this store, invisibly
 * to the kernel.
 *
 * **This adapter adds no file logic of its own.** The store already owns
 * the `wx` open, the `0600`, the read-back that proves the mode landed and
 * the refusal that leaves no file when it did not. Reimplementing any of
 * that here would be a second, weaker copy of a guarantee this repo has a
 * ratified rule about, and the copy is the one that would drift.
 */

/**
 * The one credential this store holds.
 *
 * A single ref rather than a namespace, because the file has exactly one
 * subscription credential in it. A provider that accepted any name would
 * report `configured: false` for every other one — indistinguishable from
 * "this name is not set here" — while quietly answering only for this one.
 */
export const SUBSCRIPTION_CREDENTIAL_REF = 'namzu.subscription.accessToken'

export interface FileCredentialProviderOptions {
	/** Home directory the store resolves its path under. Injectable for tests. */
	readonly home?: string
}

export class FileCredentialProvider implements CredentialProvider {
	constructor(private readonly options: FileCredentialProviderOptions = {}) {}

	private get source(): string {
		return credentialsPath(...(this.options.home === undefined ? [] : [this.options.home]))
	}

	private refused(ref: string): NamzuError {
		return new NamzuError({
			code: 'invalid_config',
			message: `This store holds only "${SUBSCRIPTION_CREDENTIAL_REF}"; it has no place for "${ref}".`,
			details: { ref },
			retryable: false,
		})
	}

	async resolve(ref: string): Promise<ResolvedCredential | undefined> {
		if (ref !== SUBSCRIPTION_CREDENTIAL_REF) return undefined
		const stored = readStoredSubscriptionCredential(
			...(this.options.home === undefined ? [] : [this.options.home]),
		)
		return stored?.accessToken ? { value: stored.accessToken, source: this.source } : undefined
	}

	async describe(ref: string): Promise<CredentialDescription> {
		const found = await this.resolve(ref)
		return {
			configured: found !== undefined,
			...(found ? { source: found.source } : {}),
			// True for this ref and only this ref. Reporting writable for a
			// name `set` would refuse is a description that disagrees with the
			// thing it describes.
			writable: ref === SUBSCRIPTION_CREDENTIAL_REF,
		}
	}

	async set(ref: string, value: string): Promise<void> {
		if (ref !== SUBSCRIPTION_CREDENTIAL_REF) throw this.refused(ref)
		// Refresh metadata is preserved: a rotation replaces the access token
		// and must not silently discard the refresh token that will rotate it
		// again, or the next rotation has nothing to work from.
		const existing = readStoredSubscriptionCredential(
			...(this.options.home === undefined ? [] : [this.options.home]),
		)
		writeStoredSubscriptionCredential(
			{ ...(existing ?? {}), accessToken: value },
			...(this.options.home === undefined ? [] : [this.options.home]),
		)
	}

	async unset(ref: string): Promise<void> {
		if (ref !== SUBSCRIPTION_CREDENTIAL_REF) throw this.refused(ref)
		clearStoredSubscriptionCredential(
			...(this.options.home === undefined ? [] : [this.options.home]),
		)
	}
}
