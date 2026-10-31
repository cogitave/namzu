/**
 * What the account picker remembers between sessions: when each account last
 * served a turn, and until when each one is known to be out of allowance.
 *
 * One small file beside `accounts.json`, shared by every Namzu process, so a
 * limit one session hit is seen by the picker of another. Nothing in it is a
 * credential. A missing or unreadable file is an empty history, never an
 * error: this is a convenience for ordering and labelling, not authority over
 * what an account may do.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withAccountLockSync } from '@namzu/sdk'

import { namzuHomePath } from '../state/home.js'

export const ACCOUNT_ACTIVITY_FILE = 'account-activity.json'

export interface AccountActivity {
	/** Epoch milliseconds, by account id. */
	readonly lastUsed: Readonly<Record<string, number>>
	/** Epoch milliseconds a spent allowance is expected back, by account id. */
	readonly limitedUntil: Readonly<Record<string, number>>
	/** Epoch milliseconds an account hit its allowance with no return time given, by account id. */
	readonly mayBeLimited: Readonly<Record<string, number>>
	/** API-key accounts the person let Namzu switch away from when their allowance runs out. */
	readonly autoSwitch: Readonly<Record<string, true>>
}

export interface AccountActivityStore {
	read(): AccountActivity
	markUsed(id: string, at: number): void
	markLimited(id: string, until: number): void
	/** The allowance ran out and the provider did not say when it returns. */
	markMayBeLimited(id: string, at: number): void
	clearLimited(id: string): void
	setAutoSwitch(id: string, on: boolean): void
	/** Forget an account that was removed or renamed. */
	forget(id: string): void
}

export interface AccountActivityOptions {
	readonly home?: string
	readonly wait?: (attempt: number) => void
}

function flags(value: unknown): Record<string, true> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
	const out: Record<string, true> = {}
	for (const [key, entry] of Object.entries(value)) if (entry === true) out[key] = true
	return out
}

function numbers(value: unknown): Record<string, number> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
	const out: Record<string, number> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
	}
	return out
}

export function accountActivityPath(home?: string): string {
	return join(namzuHomePath(home), ACCOUNT_ACTIVITY_FILE)
}

function spin(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}

export function createAccountActivityStore(
	options: AccountActivityOptions = {},
): AccountActivityStore {
	const path =
		options.home === undefined ? accountActivityPath() : join(options.home, ACCOUNT_ACTIVITY_FILE)
	const read = (): AccountActivity => {
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
			return {
				lastUsed: numbers(parsed.lastUsed),
				limitedUntil: numbers(parsed.limitedUntil),
				mayBeLimited: numbers(parsed.mayBeLimited),
				autoSwitch: flags(parsed.autoSwitch),
			}
		} catch {
			return { lastUsed: {}, limitedUntil: {}, mayBeLimited: {}, autoSwitch: {} }
		}
	}
	type Draft = {
		lastUsed: Record<string, number>
		limitedUntil: Record<string, number>
		mayBeLimited: Record<string, number>
		autoSwitch: Record<string, true>
	}
	const change = (edit: (draft: Draft) => void): void => {
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			withAccountLockSync(
				`${path}.lock`,
				() => {
					const current = read()
					const draft: Draft = {
						lastUsed: { ...current.lastUsed },
						limitedUntil: { ...current.limitedUntil },
						mayBeLimited: { ...current.mayBeLimited },
						autoSwitch: { ...current.autoSwitch },
					}
					edit(draft)
					const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
					writeFileSync(temporary, `${JSON.stringify(draft)}\n`, {
						mode: 0o600,
					})
					renameSync(temporary, path)
					try {
						chmodSync(path, 0o600)
					} catch {
						// No POSIX mode on this filesystem.
					}
				},
				{ attempts: 40, wait: options.wait ?? spin },
			)
		} catch {
			// A history that could not be written costs ordering, not a session.
		}
	}
	return {
		read,
		markUsed: (id, at) =>
			change((draft) => {
				draft.lastUsed[id] = at
				delete draft.mayBeLimited[id]
			}),
		markLimited: (id, until) =>
			change((draft) => {
				draft.limitedUntil[id] = until
				delete draft.mayBeLimited[id]
			}),
		markMayBeLimited: (id, at) =>
			change((draft) => {
				draft.mayBeLimited[id] = at
			}),
		clearLimited: (id) =>
			change((draft) => {
				delete draft.limitedUntil[id]
				delete draft.mayBeLimited[id]
			}),
		setAutoSwitch: (id, on) =>
			change((draft) => {
				if (on) draft.autoSwitch[id] = true
				else delete draft.autoSwitch[id]
			}),
		forget: (id) =>
			change((draft) => {
				delete draft.lastUsed[id]
				delete draft.limitedUntil[id]
				delete draft.mayBeLimited[id]
				delete draft.autoSwitch[id]
			}),
	}
}
