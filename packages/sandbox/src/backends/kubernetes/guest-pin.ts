import type { KubernetesWorkspaceIdentity } from './identity.js'
import type { KubernetesWorkspace } from './workspace.js'

/** A non-owning view: pod lifecycle transitions remain on the workspace owner. */
export type KubernetesPinnedGuest = Pick<
	KubernetesWorkspace,
	'exec' | 'readFile' | 'writeFile' | 'listFiles' | 'openTerminal' | 'openTcpConnection' | 'quiesce'
>

export class KubernetesGuestPinError extends Error {
	override readonly name = 'KubernetesGuestPinError'
	constructor() {
		super('The workspace no longer names the complete guest identity being admitted')
	}
}

function identityKey(identity: KubernetesWorkspaceIdentity): string {
	const nonemptyString = (value: unknown): value is string =>
		typeof value === 'string' && value.length > 0
	if (
		!nonemptyString(identity.sandboxUid) ||
		!nonemptyString(identity.podUid) ||
		!nonemptyString(identity.guestBootId) ||
		Object.keys(identity.volumeClaimUids).length === 0 ||
		Object.entries(identity.volumeClaimUids).some(
			([name, uid]) => !nonemptyString(name) || !nonemptyString(uid),
		)
	)
		throw new KubernetesGuestPinError()
	return JSON.stringify([
		identity.sandboxUid,
		identity.podUid,
		identity.guestBootId,
		Object.entries(identity.volumeClaimUids).sort(([a], [b]) => a.localeCompare(b)),
	])
}

/** Read caller-owned identity once; validation and wire use this same snapshot. */
export function captureGuestPin(expected: KubernetesWorkspaceIdentity) {
	const captured = {
		sandboxUid: expected.sandboxUid,
		podUid: expected.podUid,
		guestBootId: expected.guestBootId,
		volumeClaimUids: { ...expected.volumeClaimUids },
	}
	const key = identityKey(captured)
	if (!captured.guestBootId) throw new KubernetesGuestPinError()
	return { key, guestBootId: captured.guestBootId }
}

export function assertGuestPin(key: string, current: KubernetesWorkspaceIdentity): void {
	if (key !== identityKey(current)) throw new KubernetesGuestPinError()
}
