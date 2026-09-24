/**
 * Peer addresses are URIs so a later cross-machine transport can be added
 * without redesigning the registry or the protocol: `uds:<path>` and
 * `pipe:<name>` today, `a2a:https://…` later (design §1.1). Only the two
 * local schemes are ever SERVED or DIALED by this package; `a2a:` addresses
 * are recognised so a reader can tell them apart, not connected to.
 *
 * @experimental
 */

import { join } from 'node:path'
import { peerSocketFileName } from './dir.js'

export type PeerAddress =
	| { readonly scheme: 'uds'; readonly path: string }
	| { readonly scheme: 'pipe'; readonly path: string }
	| { readonly scheme: 'a2a'; readonly url: string }

export class PeerAddressError extends Error {
	override readonly name = 'PeerAddressError'
}

/** The `uds:<path>` address for a session's socket inside a hardened runtime directory. */
export function udsPeerAddress(runtimeDir: string, sessionId: string): string {
	return `uds:${join(runtimeDir, peerSocketFileName(sessionId))}`
}

/**
 * The `pipe:<name>` address for a session's Windows named pipe.
 *
 * `<name>` is the full pipe path Node's `net` module dials directly
 * (`\\.\pipe\namzu-<uid-hash>-<session-short>`, design §1.1) — coded here for
 * completeness; this package does not run its tests on win32, so the shape
 * is reviewed rather than exercised.
 */
export function pipePeerAddress(uidHash: string, sessionShort: string): string {
	return `pipe:\\\\.\\pipe\\namzu-${uidHash}-${sessionShort}`
}

/** Parse a peer address URI. Throws {@link PeerAddressError} on an unrecognised or empty scheme. */
export function parsePeerAddress(address: string): PeerAddress {
	if (address.startsWith('uds:')) {
		const path = address.slice('uds:'.length)
		if (path.length === 0) throw new PeerAddressError(`Empty uds: address: ${address}`)
		return { scheme: 'uds', path }
	}
	if (address.startsWith('pipe:')) {
		const path = address.slice('pipe:'.length)
		if (path.length === 0) throw new PeerAddressError(`Empty pipe: address: ${address}`)
		return { scheme: 'pipe', path }
	}
	if (address.startsWith('a2a:')) {
		const url = address.slice('a2a:'.length)
		if (url.length === 0) throw new PeerAddressError(`Empty a2a: address: ${address}`)
		return { scheme: 'a2a', url }
	}
	throw new PeerAddressError(`Unrecognised peer address scheme: ${address}`)
}
