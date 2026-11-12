/**
 * What the app trusts to sign an engine, and where it looks.
 *
 * `KERNEL_PUBLIC_KEYS` is the only place a compiled key lives, and it is generated from
 * `packages/desktop/kernel-keys.json` (specification 7.8) by `scripts/kernel/write-keys.mjs`, so the
 * app, the publisher's verify step and the release workflow read one file. The first public key is
 * listed. The private half lives only in the secret of the `kernel-release` environment. With an
 * empty list (an injected one in a test) the whole feature is off: no request is made and nothing on
 * screen changes. Whether an unpackaged run may use the list at all is decided in engine-delivery.ts.
 */
import { COMPILED_KERNEL_KEYS } from './keys-compiled.js'

export interface KernelPublicKey {
	id: string
	/** Base64 of the 32 raw bytes of an Ed25519 public key. */
	publicKey: string
}

export const KERNEL_PUBLIC_KEYS: readonly KernelPublicKey[] = COMPILED_KERNEL_KEYS

/** The range of `desktopContract` this app accepts, both ends included. */
export const KERNEL_CONTRACT_RANGE: readonly [number, number] = [1, 1]

export const KERNEL_FEED_URL = 'https://github.com/cogitave/namzu/releases/download/kernel-latest/'

export const KERNEL_CHANNEL = 'latest'

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u

export function isKeyId(value: unknown): value is string {
	return typeof value === 'string' && KEY_ID.test(value)
}

/** `<id>:<base64>`, the form of `NAMZU_KERNEL_TEST_PUBLIC_KEY`. Anything else is undefined. */
export function parseTestKey(text: string | undefined): KernelPublicKey | undefined {
	if (!text) return undefined
	const colon = text.indexOf(':')
	if (colon <= 0) return undefined
	const id = text.slice(0, colon)
	const publicKey = text.slice(colon + 1)
	if (!isKeyId(id)) return undefined
	const raw = Buffer.from(publicKey, 'base64')
	if (raw.length !== 32 || raw.toString('base64') !== publicKey) return undefined
	return { id, publicKey }
}

/**
 * The keys this run trusts. A packaged app never takes a key from the environment; an
 * unpackaged one (development, end-to-end) may take one test key.
 */
export function trustedKeys(options: {
	isPackaged: boolean
	env?: Record<string, string | undefined>
	compiled?: readonly KernelPublicKey[]
}): KernelPublicKey[] {
	const keys = [...(options.compiled ?? KERNEL_PUBLIC_KEYS)]
	if (!options.isPackaged) {
		const test = parseTestKey(options.env?.NAMZU_KERNEL_TEST_PUBLIC_KEY)
		if (test && !keys.some((key) => key.id === test.id)) keys.push(test)
	}
	return keys
}

function isLoopbackHost(host: string): boolean {
	const bare = host.startsWith('[') ? host.slice(1, -1) : host
	return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(bare)
}

/** HTTPS anywhere, plain HTTP only to this machine. */
export function isAllowedFeedUrl(text: string): boolean {
	let url: URL
	try {
		url = new URL(text)
	} catch {
		return false
	}
	if (url.username || url.password) return false
	if (url.protocol === 'https:') return true
	return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/**
 * The folder the manifest is read from. `override` is `NAMZU_KERNEL_FEED_URL`: any allowed URL
 * when unpackaged, loopback only when packaged. An override that is refused falls back to the
 * compiled address, never to nothing.
 */
export function feedBase(options: {
	isPackaged: boolean
	override?: string | undefined
	compiled?: string
}): string {
	const compiled = options.compiled ?? KERNEL_FEED_URL
	let base = compiled
	const override = options.override
	if (override && isAllowedFeedUrl(override)) {
		const loopback = isLoopbackHost(new URL(override).hostname)
		if (!options.isPackaged || loopback) base = override
	}
	return base.endsWith('/') ? base : `${base}/`
}
