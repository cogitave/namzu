/**
 * Credential scrubbing for an environment a tool *inherits* rather than one a
 * host *hands* it.
 *
 * The distinction is the whole design. `process.env` arrives by inheritance —
 * nobody decided the model's command should see it, it is simply what a child
 * process gets by default. A `ToolContext.env` entry is the opposite: a host
 * wrote that key deliberately. So the inherited half is scrubbed and the
 * explicit half is not, and a host that means to hand a command a credential
 * can still do it by naming it.
 *
 * ## This is a denylist, and a denylist is not a boundary
 *
 * Stated plainly because the sandbox tiers state their limits the same way
 * (`sandbox/isolation.ts`): a control that is believed to be enforcing more
 * than it does is worse than one nobody trusted. This function catches keys
 * whose *name* looks like a credential. It cannot catch a secret whose name
 * does not — `DATABASE_URL` with a password in the userinfo, an S3 pre-signed
 * URL in `ARTIFACT_URL`, a bearer token someone parked in `MY_VAR`. Those
 * still reach the command.
 *
 * The actual boundary is the sandbox, where the inherited set is an allowlist
 * (the local sandbox's bounded core-process keys) rather than a denylist. Its
 * Windows branch includes the system-root, command-interpreter and profile
 * plumbing a working Windows child needs; it still carries no ambient
 * credential keys. An allowlist is correct there because a sandbox is a fresh
 * environment; it is wrong on the host path, where the same agent is expected
 * to run `pnpm test`, `make` and `docker build`, all of which need far more
 * variables. So the host path gets the weaker control on purpose, and says so.
 *
 * ## Why this exists at all
 *
 * Namzu reads its own provider credentials out of the environment. A command
 * that prints its environment — `env`, `printenv`, a Makefile echoing `$(ENV)`,
 * a build script dumping config on failure — therefore returned the operator's
 * API keys as tool output. That output is not ephemeral: it is appended to the
 * durable transcript, persisted by the session store, and re-sent to the model
 * provider as history on every later turn of the run. One incidental `env` in
 * a build script converted a local secret into a permanently recorded one that
 * had also been transmitted to a third party.
 *
 * The model does not have to be adversarial for this to fire, which is why it
 * is scrubbed rather than merely policed.
 */

import { isCredentialEnvKey } from '../constants/credential-env-keys.js'

// Re-exported from its historical home: this module's importers already
// name it here, and the predicate did not change — only where it lives.
export { isCredentialEnvKey }

// The key-name vocabulary moved to `constants/credential-env-keys.ts`, a
// leaf with no imports, so `EnvCredentialProvider` can read the SAME table.
// Two copies would mean a name in one and not the other — a variable the
// credential seam reads a secret from and this scrub hands to a shell.

/** Outcome of a scrub — the surviving environment and what was withheld. */
export interface ScrubbedEnv {
	readonly env: Record<string, string>
	/**
	 * Names of the dropped variables, sorted. Names only — never values.
	 *
	 * Returned rather than swallowed because a command that genuinely needed
	 * `FOO_TOKEN` otherwise fails with an authentication error that points
	 * nowhere. Naming the withheld key turns that into a readable failure the
	 * model can act on, which is the same reason a denied tool call here
	 * carries the rule that denied it.
	 */
	readonly dropped: readonly string[]
}

/**
 * Drop credential-shaped keys from an inherited environment.
 *
 * Values are never inspected — only key names — so this cannot itself become
 * a place a secret is read, logged or compared.
 */
export function scrubInheritedEnv(source: NodeJS.ProcessEnv = process.env): ScrubbedEnv {
	const env: Record<string, string> = {}
	const dropped: string[] = []

	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue
		if (isCredentialEnvKey(key)) {
			dropped.push(key)
			continue
		}
		env[key] = value
	}

	dropped.sort()
	return { env, dropped }
}
