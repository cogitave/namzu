/**
 * Throwaway P-256 test PKI (self-signed CA + one server leaf), baked in as
 * PEM constants so the loopback-`https` tests in this directory never touch
 * `openssl`/`forge` at test time — the same reason
 * `../../firecracker/__tests__/fixtures/mtls-pki.ts` bakes its own PKI in.
 * This one is deliberately simpler: the Kubernetes client never presents a
 * client certificate (only `ca`, never `cert`/`key` — see `k8s-client.ts`),
 * so there is no client leaf here, only a CA and a server leaf whose SAN
 * covers the loopback address the tests dial.
 *
 * Minted offline:
 *   openssl ecparam -genkey + openssl req -x509 (self-signed CA)
 *   openssl req -new + openssl x509 -req -CA ... (server leaf,
 *     SAN = DNS:kubernetes.default.svc, IP:127.0.0.1), far-future expiry.
 */

export const CA_CRT = `-----BEGIN CERTIFICATE-----
MIIBjzCCATWgAwIBAgIUAZq7FwUODNHuClYIvt6d2oNbEOQwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRbmFtenUtazhzLXRlc3QtY2EwIBcNMjYwOTE1MjA0MjQyWhgP
MjEyNjA4MjIyMDQyNDJaMBwxGjAYBgNVBAMMEW5hbXp1LWs4cy10ZXN0LWNhMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEv+CzL4+jCsCm4xaxFkyxP3aXkfu00S83
Av/0xZettke4xMzvBTrrFRHxOiP/6fQbUrYxaxNsqubTibo0Lbu4O6NTMFEwHQYD
VR0OBBYEFF6gLpMm++6XRcAI3BzYi5YEKQtSMB8GA1UdIwQYMBaAFF6gLpMm++6X
RcAI3BzYi5YEKQtSMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIg
QW7NHq/ZZbny9JElYRni+i8xLrQHeLkbihEM44poZWYCIQCTTXBsy8c6M/IEvFYI
JL0vDeGemQ5EN7cMGqecK/Pyfw==
-----END CERTIFICATE-----
`

export const SERVER_CRT = `-----BEGIN CERTIFICATE-----
MIIBwjCCAWigAwIBAgIUSbN3vo5c+kwHN7PmITJewBK31ogwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRbmFtenUtazhzLXRlc3QtY2EwIBcNMjYwOTE1MjA0MjQyWhgP
MjEyNjA4MjIyMDQyNDJaMCExHzAdBgNVBAMMFmt1YmVybmV0ZXMuZGVmYXVsdC5z
dmMwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASG5bF3VCIjD0hCJwrmaZOD1n6r
2X6Ae5np8G9pOHqWYH4zHHRn3rMzhJbb7D8fO1KUi1HnK3cbUQEGE/y5ju/Ko4GA
MH4wJwYDVR0RBCAwHoIWa3ViZXJuZXRlcy5kZWZhdWx0LnN2Y4cEfwAAATATBgNV
HSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUJCvKI3iQ0LThK4x/4K1PcA1hDLAw
HwYDVR0jBBgwFoAUXqAukyb77pdFwAjcHNiLlgQpC1IwCgYIKoZIzj0EAwIDSAAw
RQIgJKiarkI5NJoRLaPMq3SZtz5YujlHxW3B6aon3d+qxFUCIQDLTFZUq4oeqjip
Ke7+hqpAi39D3bnVI/cHYmAttkDSqQ==
-----END CERTIFICATE-----
`

export const SERVER_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIOOZaU7E4elkDiTusY7Ak/2no4Ld7K9IJCcyv9B7ogxwoAoGCCqGSM49
AwEHoUQDQgAEhuWxd1QiIw9IQicK5mmTg9Z+q9l+gHuZ6fBvaTh6lmB+Mxx0Z96z
M4SW2+w/HztSlItR5yt3G1EBBhP8uY7vyg==
-----END EC PRIVATE KEY-----
`
