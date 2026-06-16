/**
 * Shared Ring-0 mTLS test PKI + a loopback relay stand-in.
 *
 * A throwaway P-256 test PKI (CA + server leaf + client leaf + an unrelated
 * rogue client) baked in as PEM constants — no openssl/forge at test time, so
 * the package stays dependency-light. Minted offline:
 *   openssl ec/x509 self-signed CA + leaves
 *   (server SAN = DNS:sandbox.fc.internal, IP:127.0.0.1), far-future expiry.
 * `ROGUE_*` chains to a DIFFERENT CA to prove `rejectUnauthorized` blocks it.
 *
 * Used by both transport.test.ts (the raw `kind:'mtls'` dialer arm) and
 * backend.test.ts (the cert-INJECTION seam through `buildFirecrackerBackend`),
 * so the PKI + relay harness lives in one place instead of per-test copies.
 */

import { connect as netConnect } from 'node:net'
import { type TLSSocket, type Server as TlsServer, createServer as createTlsServer } from 'node:tls'

export const CA_CRT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUGXUtG14KQr4spNGW7rpfjZGoBIIwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBwxGjAYBgNVBAMMEXZhbmRhbC1mYy10ZXN0LWNhMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5l+vjhjm/PX02D55n56EwelgvM1jrqQM
Z+ezzvMmrZEBGWInvBND3z3kc6nv7snu6fHT2HHOyhwUNoLqmrIg/qNTMFEwHQYD
VR0OBBYEFP0M8/KZY1ovxyGDci5iuoYXcmZgMB8GA1UdIwQYMBaAFP0M8/KZY1ov
xyGDci5iuoYXcmZgMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg
C0xtFDASnwsOYT0GiZwzYWTOBfgmjDWK7ANXQQFNTh4CICVLQwq5eLy3424drEHk
5Ol/FNKVZcGRjE96rB0mRUOp
-----END CERTIFICATE-----
`

export const SERVER_CRT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVWgAwIBAgIUYkXroqlz9blXW8llis6e2OxOc1MwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBIxEDAOBgNVBAMMB2ZjLWhvc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQodCSHY8Sz5Lh/4K6+SzekkrRCeKMBfmonVb7dUhM0ZWpo
ePCcRrMcJp5aNxLxEgkl2EMMMMwE3LlLSOX5LZz6o30wezAkBgNVHREEHTAbghNz
YW5kYm94LmZjLmludGVybmFshwR/AAABMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0G
A1UdDgQWBBRXHU1vlX7WvqzcbaNxRxV4f3gfDDAfBgNVHSMEGDAWgBT9DPPymWNa
L8chg3IuYrqGF3JmYDAKBggqhkjOPQQDAgNJADBGAiEAlqzKqgBf5hxJqd26QwcY
n3cvEKi4f2BSLe1Rfzr5oSoCIQD0izUOJXLNvmac9cMgV0HvkftBerDKFOcGeGTN
g3Eunw==
-----END CERTIFICATE-----
`

export const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/ROnYXIkMKnipbLt
JnFEwXAifgeOv9TGLcK2RojE7jmhRANCAAQodCSHY8Sz5Lh/4K6+SzekkrRCeKMB
fmonVb7dUhM0ZWpoePCcRrMcJp5aNxLxEgkl2EMMMMwE3LlLSOX5LZz6
-----END PRIVATE KEY-----
`

export const CLIENT_CRT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUYkXroqlz9blXW8llis6e2OxOc1QwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBgxFjAUBgNVBAMMDWNhLXZhbmRhbC1hcHAwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAASlCMCwjtrQUicWcWsO29R5S7fzjMbbxXvDh8/K
w57x/PN/uQwLHWCz1Tsyk0FnbrwGP+nPtwrUPIxrLN//euXko1cwVTATBgNVHSUE
DDAKBggrBgEFBQcDAjAdBgNVHQ4EFgQU2cxDCNrlVkk4ODs6ZPrkC6GzHjkwHwYD
VR0jBBgwFoAU/Qzz8pljWi/HIYNyLmK6hhdyZmAwCgYIKoZIzj0EAwIDRwAwRAIg
RghqArNm3bXnWnRi+jkEEJa8mRb2z0Wj4G7SIhtMurUCIBQSllVtICgZB9hvcM0D
d24fcW4nlfvaZJMJ6dRC1Wle
-----END CERTIFICATE-----
`

export const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaamj/ycrEuPqpiC2
IhAYx/M5iN4t4P+B17V4GO54Nb2hRANCAASlCMCwjtrQUicWcWsO29R5S7fzjMbb
xXvDh8/Kw57x/PN/uQwLHWCz1Tsyk0FnbrwGP+nPtwrUPIxrLN//euXk
-----END PRIVATE KEY-----
`

export const ROGUE_CLIENT_CRT = `-----BEGIN CERTIFICATE-----
MIIBhjCCASugAwIBAgIUbAYOlW4PQGyXjjRsjCPy62EHUmIwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcm9ndWUtY2EwIBcNMjYwNjE2MDgzMjUyWhgPMjEyNjA1MjMw
ODMyNTJaMBcxFTATBgNVBAMMDHJvZ3VlLWNsaWVudDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABOPSzdzQTQz3M5CDHLVPguvHd10ncaDV9t4zKUy/PCE+U7GTJwN2
TtypGnmYEahbcl45j94hwu495P5VbR5ohb6jVzBVMBMGA1UdJQQMMAoGCCsGAQUF
BwMCMB0GA1UdDgQWBBTf0woauniche3/ps77+Kd0dsbbSDAfBgNVHSMEGDAWgBSX
Yu0IJlPxi79Gyi5hR1IfS/sqyzAKBggqhkjOPQQDAgNJADBGAiEAxD4N4XWtaHPJ
yaCOzQP0e5RRyNst3QrhH0NSMyPw89wCIQC+bezLX97TuV1sId53Bo1l9j1TSOMa
EZotN/Wsq6L+qw==
-----END CERTIFICATE-----
`

export const ROGUE_CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgR6fGq27O9eT/hi0Q
c+L5+lSm5fbDEghVJCo6k7HrG62hRANCAATj0s3c0E0M9zOQgxy1T4Lrx3ddJ3Gg
1fbeMylMvzwhPlOxkycDdk7cqRp5mBGoW3JeOY/eIcLuPeT+VW0eaIW+
-----END PRIVATE KEY-----
`

export interface RelayHandle {
	readonly server: TlsServer
	readonly port: number
	/** sandboxId from the first connection's `SANDBOX <id>` preamble. */
	preamble(): Promise<string>
}

/**
 * A loopback stand-in for the per-FC-host mTLS relay.
 *
 * Terminates mTLS (requestCert + rejectUnauthorized + CA pin), reads the
 * `SANDBOX <id>\n` routing preamble line, then bridges the rest of the TLS
 * stream verbatim to a FRESH `net.connect` to `agentSockPath` (the
 * unix-socket-backed real agent) — exactly the dumb byte-pump the production
 * relay is. It does NOT speak framing itself and does NOT send an ack line.
 */
export function startMtlsRelay(agentSockPath: string, listenPort = 0): Promise<RelayHandle> {
	let resolvePreamble: (id: string) => void
	const preamble = new Promise<string>((r) => {
		resolvePreamble = r
	})

	return new Promise<RelayHandle>((resolve, reject) => {
		const server = createTlsServer(
			{
				requestCert: true,
				rejectUnauthorized: true,
				ca: CA_CRT,
				cert: SERVER_CRT,
				key: SERVER_KEY,
				minVersion: 'TLSv1.3',
			},
			(tlsSock: TLSSocket) => {
				let pre = Buffer.alloc(0)
				const onPreambleData = (chunk: Buffer) => {
					pre = Buffer.concat([pre, chunk])
					const nl = pre.indexOf(0x0a)
					if (nl < 0) return
					tlsSock.removeListener('data', onPreambleData)
					tlsSock.pause()
					const line = pre.subarray(0, nl).toString('utf8')
					const rest = pre.subarray(nl + 1)
					if (rest.length > 0) tlsSock.unshift(rest)
					const m = /^SANDBOX (.+)$/.exec(line)
					const id = m?.[1]
					if (id === undefined) {
						tlsSock.destroy()
						return
					}
					resolvePreamble(id)
					// 1 inbound mTLS conn -> 1 FRESH local agent connect (the
					// resume-survival invariant the relay must preserve).
					const upstream = netConnect({ path: agentSockPath })
					upstream.on('error', () => tlsSock.destroy())
					tlsSock.on('error', () => upstream.destroy())
					upstream.once('connect', () => {
						tlsSock.pipe(upstream)
						upstream.pipe(tlsSock)
					})
				}
				tlsSock.on('data', onPreambleData)
			},
		)
		server.on('error', reject)
		server.listen(listenPort, '127.0.0.1', () => {
			const addr = server.address()
			if (addr === null || typeof addr === 'string') {
				reject(new Error('relay: no TCP port'))
				return
			}
			resolve({ server, port: addr.port, preamble: () => preamble })
		})
	})
}
