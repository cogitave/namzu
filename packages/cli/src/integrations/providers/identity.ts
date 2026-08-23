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
 * Re-verified by capturing the exact URL emitted by the installed owner client
 * (`claude auth login --claudeai`, 2.1.241) on 2026-08-23. Its live production
 * contract uses the CAI authorize endpoint, the platform token endpoint and
 * the platform callback below. That client does not offer a loopback redirect
 * on this flow. A localhost callback may be valid OAuth in general, but it is
 * not registered for this client identity; sending one makes the consent page
 * refuse the request before sign-in.
 */

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'

/** Registered browser-to-terminal callback; not ours to replace with localhost. */
export const MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'

/**
 * The direct Claude Pro/Max scope set used by the current Claude harness.
 *
 * This looks broader than the inference capability Namzu consumes, but it is
 * the exact set the current owner client sends for `--claudeai`, not its
 * separately selected `--console` flow. The CAI endpoint validates the whole
 * registered request shape; deleting `org:create_api_key` because its name
 * sounds unrelated produces "Invalid request format" before the account can
 * authorize anything. Keep this as one captured protocol value rather than a
 * hand-curated list of what Namzu later uses.
 */
export const OAUTH_SCOPES =
	'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
