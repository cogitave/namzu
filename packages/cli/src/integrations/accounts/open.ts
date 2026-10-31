/**
 * The CLI's handle on the account registry: the SDK registry with the Codex
 * reader wired in, plus the small history file the picker orders by.
 */

import { join } from 'node:path'
import { type Account, type AccountRegistry, createAccountRegistry } from '@namzu/sdk'

import { createCodexHomeReader } from '../providers/codex-account.js'
import { readCodexCredentialFile } from '../providers/harness-credentials.js'
import { namzuHomePath } from '../state/home.js'
import { type AccountActivityStore, createAccountActivityStore } from './activity.js'

/** Providers a labelled API key can be added for. Codex accounts come only from the official sign-in. */
export const API_KEY_ACCOUNT_PROVIDERS = [
	'anthropic',
	'openai',
	'google',
	'deepseek',
	'openrouter',
	'zen',
	'zen-go',
] as const

export interface CliAccounts {
	readonly registry: AccountRegistry
	readonly activity: AccountActivityStore
	/** Where a new Codex account's private home lives. */
	readonly codexHomeFor: (label: string) => string
}

export interface OpenCliAccountsOptions {
	readonly home?: string
	/** Providers whose usual sign-in is listed as the `default` account. */
	readonly defaultProviders?: readonly string[]
}

export function openCliAccounts(options: OpenCliAccountsOptions = {}): CliAccounts {
	const home = options.home ?? namzuHomePath()
	const registry = createAccountRegistry({
		home,
		...(options.defaultProviders ? { defaultProviders: options.defaultProviders } : {}),
		readers: { codexHome: createCodexHomeReader() },
	})
	return {
		registry,
		activity: createAccountActivityStore({ home }),
		codexHomeFor: (label) => join(home, 'accounts', 'codex', label),
	}
}

/** Whether a stored account's credential is there to be read. The usual sign-in is judged by discovery, not here. */
export function storedAccountSignedIn(account: Account): boolean {
	if (account.source.kind === 'codex-home') {
		return readCodexCredentialFile(join(account.source.dir, 'auth.json')) !== null
	}
	return true
}
