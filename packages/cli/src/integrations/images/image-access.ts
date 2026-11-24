import { ensureFreshStoredCodexCredential } from '../providers/codex-oauth.js'
import type { DetectedProvider } from '../providers/discover.js'
import { findDetected } from '../providers/discover.js'
import { codexPlanType, readCodexCredentialFile } from '../providers/harness-credentials.js'
import type { ImageGenerationAccess } from './generate-image.js'

export interface ImageAccessDeps {
	/** The providers found on this machine, read live. */
	readonly detected: () => readonly DetectedProvider[]
	/** The provider leading the session. */
	readonly primaryId: string
	/** Renews and reads the leading provider's own sign-in; used when it is the subscription one. */
	readonly prepare: (signal: AbortSignal) => Promise<ImageGenerationAccess | undefined>
}

/**
 * Where `generate_image` gets its subscription plan sign-in, whatever model leads.
 * `available` is the cheap synchronous check the tool's offer reads for every
 * request; `read` returns a sign-in that is current at call time.
 */
export function createImageAccess(deps: ImageAccessDeps): {
	readonly available: () => boolean
	readonly read: (signal: AbortSignal) => Promise<ImageGenerationAccess | undefined>
} {
	const subscription = (): DetectedProvider | undefined => {
		const found = findDetected(deps.detected(), 'codex')
		return found?.codex ? found : undefined
	}
	return {
		available() {
			const found = subscription()
			if (!found) return false
			// A plan the token names as Free does not get the tool; an unreadable plan is allowed
			// and the service answers for it.
			return found.apiKey === undefined || codexPlanType(found.apiKey) !== 'free'
		},
		async read(signal) {
			signal.throwIfAborted()
			const found = subscription()
			if (!found?.codex) return undefined
			const base = found.baseUrl ? { baseURL: found.baseUrl } : {}
			if (deps.primaryId === 'codex') {
				const own = await deps.prepare(signal)
				return own ? { ...own, ...base } : undefined
			}
			if (found.codex.origin === 'stored') {
				const credential = await ensureFreshStoredCodexCredential(signal)
				return { accessToken: credential.accessToken, accountId: credential.accountId, ...base }
			}
			if (found.source.kind === 'codex-file') {
				const credential = readCodexCredentialFile(found.source.path)
				if (!credential) return undefined
				if (credential.expiresAt !== undefined && credential.expiresAt - Date.now() <= 60_000)
					throw new Error(
						'The Codex sign-in on this computer has expired. Run `codex login` to refresh it.',
					)
				return { accessToken: credential.accessToken, accountId: credential.accountId, ...base }
			}
			return undefined
		},
	}
}
