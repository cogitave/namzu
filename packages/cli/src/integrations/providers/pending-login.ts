/**
 * A Claude sign-in that is waiting for its code.
 *
 * When the run that printed the address cannot read a paste (a shell whose
 * standard input closes at once), the verifier would die with the process and
 * the code the browser then shows could never be used. This keeps the values
 * the exchange needs in one owner-only file for ten minutes so a second
 * invocation (`namzu auth login claude --code <code>`) can finish the exchange.
 *
 * The file holds the PKCE verifier, so it is never printed, logged or put in
 * an error, and it is deleted as soon as an exchange has been attempted.
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { atomicWrite } from '../extensions/store.js'
import { namzuHomePath } from '../state/home.js'

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1_000

export interface PendingLogin {
	readonly verifier: string
	readonly state: string
	readonly redirectUri: string
	readonly createdAt: number
}

export function pendingLoginPath(home?: string): string {
	return join(namzuHomePath(home), 'login-pending', 'anthropic.json')
}

export function writePendingLogin(pending: PendingLogin, home?: string): string {
	const path = pendingLoginPath(home)
	const dir = dirname(path)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	if (process.platform !== 'win32') chmodSync(dir, 0o700)
	atomicWrite(path, JSON.stringify({ version: 1, ...pending }), 0o600)
	return path
}

export type PendingLoginRead =
	| { readonly kind: 'ok'; readonly pending: PendingLogin }
	| { readonly kind: 'missing' }
	| { readonly kind: 'expired' }

export function readPendingLogin(home?: string, now: number = Date.now()): PendingLoginRead {
	const path = pendingLoginPath(home)
	try {
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) return { kind: 'missing' }
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
		if (
			parsed.version !== 1 ||
			typeof parsed.verifier !== 'string' ||
			typeof parsed.state !== 'string' ||
			typeof parsed.redirectUri !== 'string' ||
			typeof parsed.createdAt !== 'number'
		) {
			return { kind: 'missing' }
		}
		if (now - parsed.createdAt > PENDING_LOGIN_TTL_MS || parsed.createdAt > now + 60_000) {
			return { kind: 'expired' }
		}
		return {
			kind: 'ok',
			pending: {
				verifier: parsed.verifier,
				state: parsed.state,
				redirectUri: parsed.redirectUri,
				createdAt: parsed.createdAt,
			},
		}
	} catch {
		return { kind: 'missing' }
	}
}

export function clearPendingLogin(home?: string): void {
	try {
		rmSync(pendingLoginPath(home), { force: true })
	} catch {
		// Nothing useful to do; the file expires on its own.
	}
}
