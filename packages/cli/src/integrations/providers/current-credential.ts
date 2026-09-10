import type { DetectedProvider } from './discover.js'
import {
	CredentialWithdrawnError,
	ensureFreshAnthropicToken,
	readSubscriptionCredential,
} from './oauth.js'

/** Serialize rotations and reread the admitted owner when an auxiliary client is built. */
export function createCurrentCredentialReader() {
	let tail: Promise<void> = Promise.resolve()
	return (
		detected: DetectedProvider | null,
		signal?: AbortSignal,
	): Promise<DetectedProvider | null> => {
		if (detected?.entry.id !== 'anthropic' || !detected.oauth) {
			signal?.throwIfAborted()
			return Promise.resolve(detected)
		}
		const oauth = detected.oauth
		const work = tail.then(async () => {
			signal?.throwIfAborted()
			const origin = oauth.origin ?? 'keychain'
			const credential = readSubscriptionCredential(origin, oauth.sourcePath)
			if (!credential) throw new CredentialWithdrawnError()
			const metadata = { ...oauth, ...credential, origin }
			// Keychain credentials remain owner-refreshed; only reread that source.
			const token =
				origin === 'keychain'
					? credential.accessToken
					: await ensureFreshAnthropicToken(credential.accessToken, metadata, signal)
			signal?.throwIfAborted()
			if (
				token === credential.accessToken &&
				credential.expiresAt !== undefined &&
				credential.expiresAt <= Date.now()
			) {
				throw new CredentialWithdrawnError(
					'The Claude credential is still expired after renewal. Retry when its owner has refreshed it, or sign in with /login.',
				)
			}
			const published = readSubscriptionCredential(origin, oauth.sourcePath)
			const current = published?.accessToken === token ? published : credential
			return {
				...detected,
				apiKey: token,
				oauth: {
					origin,
					sourcePath: oauth.sourcePath,
					refreshToken: current.refreshToken,
					expiresAt: current.accessToken === token ? current.expiresAt : undefined,
				},
			}
		})
		tail = work.then(
			() => {},
			() => {},
		)
		return work
	}
}
