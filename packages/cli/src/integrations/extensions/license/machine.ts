import { createHmac } from 'node:crypto'

/**
 * The machine code a licence service sees: an HMAC per extension, never a hardware id, a host name or
 * a user name. It counts seats; it is not an anti-copy boundary (a copied Namzu home copies the secret).
 */
export function machineHash(installSecret: string, extensionId: string, osUserId: string): string {
	return createHmac('sha256', installSecret)
		.update(`namzu-machine/1\0${extensionId}\0${osUserId}`)
		.digest('base64url')
}
