/**
 * A minimal self-signed X.509 v3 certificate over a machine's Ed25519 key.
 *
 * `node:tls` needs a certificate and `node:crypto` has no builder, so this
 * file only ENCODES the ASN.1 structure; the signature is made by
 * `crypto.sign`. Trust is never taken from this certificate's chain: peers pin
 * the machine key it carries (see `transport.ts`). The tests parse the output
 * with Node's own `X509Certificate` and run a real handshake with it.
 *
 * @experimental
 */

import { X509Certificate, randomBytes, sign } from 'node:crypto'
import type { MachineKey } from './identity.js'

const DAY_MS = 86_400_000

function length(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n])
	const bytes: number[] = []
	for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
	return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, body: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts))

function oid(dotted: string): Buffer {
	const arcs = dotted.split('.').map(Number)
	const first = arcs[0] as number
	const second = arcs[1] as number
	const out: number[] = [first * 40 + second]
	for (const arc of arcs.slice(2)) {
		const groups: number[] = [arc & 0x7f]
		for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
			groups.unshift((rest & 0x7f) | 0x80)
		}
		out.push(...groups)
	}
	return tlv(0x06, Buffer.from(out))
}

function integer(bytes: Buffer): Buffer {
	let body = bytes
	while (body.length > 1 && body[0] === 0) body = body.subarray(1)
	if (((body[0] as number) & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body])
	return tlv(0x02, body)
}

function utcTime(ms: number): Buffer {
	const d = new Date(ms)
	const p = (n: number) => String(n).padStart(2, '0')
	const text = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
	return tlv(0x17, Buffer.from(text, 'ascii'))
}

const ED25519_ALGORITHM = seq(oid('1.3.101.112'))

function name(commonName: string): Buffer {
	return seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))))
}

export interface MachineCertificate {
	readonly pem: string
	readonly der: Buffer
}

export interface BuildCertificateOptions {
	readonly now?: number
}

/** `CN=namzu-<first 16 hex of the machine id>`, issuer and subject alike. */
export function certificateSubject(machineId: string): string {
	return `namzu-${machineId.slice(0, 16)}`
}

export function buildMachineCertificate(
	key: MachineKey,
	options: BuildCertificateOptions = {},
): MachineCertificate {
	const now = options.now ?? Date.now()
	const subject = name(certificateSubject(key.machineId))
	const basicConstraints = seq(oid('2.5.29.19'), tlv(0x04, seq()))
	const tbs = seq(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(randomBytes(16)),
		ED25519_ALGORITHM,
		subject,
		seq(utcTime(now - DAY_MS), utcTime(now + 3650 * DAY_MS)),
		subject,
		key.publicKeyDer,
		tlv(0xa3, seq(basicConstraints)),
	)
	const signature = sign(null, tbs, key.privateKey)
	const der = seq(tbs, ED25519_ALGORITHM, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
	const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n')
	return {
		der,
		pem: `-----BEGIN CERTIFICATE-----\n${b64.trimEnd()}\n-----END CERTIFICATE-----\n`,
	}
}

/** The SPKI DER of the key a certificate carries. Never throws for a good certificate. */
export function certificatePublicKeyDer(certDer: Buffer): Buffer {
	const cert = new X509Certificate(certDer)
	return cert.publicKey.export({ type: 'spki', format: 'der' })
}
