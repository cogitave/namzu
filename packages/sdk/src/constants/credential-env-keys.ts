/**
 * Credential-bearing environment variable KEY NAMES, in one place.
 *
 * A leaf with no imports, beside `secret-patterns.ts` and holding the
 * complement of it: that file matches credential VALUES, this one matches
 * the names variables carry them under. Neither re-declares the other's,
 * because a value pattern and a key name answer different questions and a
 * table that tried to do both would be wrong at whichever end it was not
 * written for.
 *
 * Two readers, and that is the point of moving it here. The host-bash
 * environment scrub uses it to decide what a shell command must not
 * inherit, and `EnvCredentialProvider` uses it to decide what counts as a
 * credential it can resolve. Those were about to become two tables — the
 * CLI's provider registry already keeps a third, of `envVars` per provider
 * — and a name in one and not another means a variable the CLI reads a
 * credential from and the scrub happily hands to a shell.
 */

/**
 * Key-name patterns that mark an inherited variable as credential-shaped.
 *
 * Matched case-insensitively against the whole key. Deliberately broad: a
 * false positive costs a command one variable it can be handed back
 * explicitly, while a false negative costs a leaked secret that cannot be
 * recalled from a transcript.
 */
export const CREDENTIAL_KEY_PATTERNS: readonly RegExp[] = [
	/KEY/i,
	/SECRET/i,
	/TOKEN/i,
	/PASSWORD/i,
	/PASSWD/i,
	/CREDENTIAL/i,
	/(^|_)AUTH(_|$)/i,
	/PRIVATE/i,
	/SESSION_ID/i,
	/COOKIE/i,
	/SIGNATURE/i,
	/(^|_)PAT(_|$)/i,
]

/**
 * Keys that are credential-bearing but whose names match none of the patterns
 * above. Kept as an explicit list so each entry is a decision somebody can
 * read, rather than a pattern nobody can evaluate.
 */
export const CREDENTIAL_KEY_EXACT: ReadonlySet<string> = new Set([
	'AWS_SESSION_TOKEN',
	'AWS_SECURITY_TOKEN',
	'GOOGLE_APPLICATION_CREDENTIALS',
	'NPM_CONFIG__AUTH',
	'GH_ENTERPRISE_TOKEN',
	'DOCKER_AUTH_CONFIG',
	'KUBECONFIG',
	'NETRC',
])

/** True when an inherited variable's name marks it as credential-shaped. */
export function isCredentialEnvKey(key: string): boolean {
	if (CREDENTIAL_KEY_EXACT.has(key.toUpperCase())) return true
	return CREDENTIAL_KEY_PATTERNS.some((pattern) => pattern.test(key))
}
