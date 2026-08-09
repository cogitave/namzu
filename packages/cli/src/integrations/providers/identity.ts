/**
 * The OAuth client namzu presents when it signs an operator in, and the
 * addresses that identity is valid against.
 *
 * ## Whose identity this is — the decision, written where the value is
 *
 * `OAUTH_CLIENT_ID` was **not registered by namzu**. It is the public client
 * identifier that the vendor's own command-line tool is registered under, and
 * it is the only one the subscription authorization server will issue
 * plan-scoped inference tokens to. This project has no client of its own
 * there because that vendor operates no open client registration for this
 * grant: there is no form to fill in, no application to make. The choice was
 * therefore between presenting this identity, and not offering the capability
 * at all.
 *
 * The owner decided the capability should exist, so this is the identity used,
 * and the consequences are stated rather than discovered later:
 *
 *  - **The authorization server cannot tell namzu apart from that tool.** A
 *    credential obtained here is, at the server, a credential obtained there.
 *  - **The operator's own plan governs it.** namzu mediates a sign-in the
 *    person completes themselves, on the vendor's own page, against the
 *    vendor's own account. No namzu service sees the credential, and nothing
 *    is proxied — the token goes from the vendor to this machine.
 *  - **This identity can be revoked by its owner at any time,** and if it is,
 *    every sign-in below stops working at once. That is a dependency namzu
 *    accepted knowingly; it is not a bug to be worked around when it happens.
 *  - **It is not a secret and is not treated as one.** A public OAuth client
 *    identifier is public by definition — that is why PKCE exists. Nearby
 *    implementations obscure this value behind a base64 decode at runtime,
 *    which hides nothing from anyone reading the request and hides the one
 *    fact a reviewer of THIS file most needs. It stays legible.
 *
 * Anyone uncomfortable with the above has the other door: set the credential
 * in the environment and namzu never runs this flow at all.
 *
 * ## The addresses
 *
 * Verified 2026-08-09 rather than assumed. Two hosts serve this token
 * endpoint — the one below and `platform.claude.com` on the same path — and
 * both answer an `authorization_code` grant identically (`400 invalid_grant`
 * for a bogus code, from the same handler). namzu keeps the address its
 * existing refresh path has always used, because there was no behaviour to
 * gain by moving and a live refresh to lose by guessing.
 *
 * The redirect port is fixed and NOT free to change: it is part of what the
 * client identity above is registered with, so a different port is simply not
 * an accepted redirect. That is why a busy port degrades to the paste flow
 * rather than picking another one.
 */

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'

/** Registered with the client identity above; not ours to choose. */
export const SUBSCRIPTION_REDIRECT_PORT = 53692
export const REDIRECT_URI = `http://localhost:${SUBSCRIPTION_REDIRECT_PORT}/callback`

/**
 * Asked for at sign-in.
 *
 * This is WIDER than namzu needs, and that is a knowing compromise rather
 * than an oversight. Least privilege would ask for an identity and the right
 * to run inference, and stop; this set also admits key creation and file
 * upload. It is the set the client identity above is exercised with by the
 * implementations that are known to work, and a narrower request cannot be
 * tested from here — nobody on this side of the flow holds a plan-backed
 * account to try it against. Guessing narrow fails in the worst place: the
 * sign-in succeeds, and inference is refused afterwards with an error about
 * scope that the operator cannot act on.
 *
 * So it is recorded as debt with the measurement that would settle it: sign
 * in with `user:profile user:inference` alone and send one message. If that
 * works, this shrinks to those two.
 */
export const OAUTH_SCOPES =
	'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
