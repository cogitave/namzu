import type { AuthorizationGateConfig } from '../types/authorization/index.js'

/**
 * Sensible defaults for an agent that runs inside a host-provided
 * sandbox (isolated working directory, isolated container, or both).
 *
 * The model: the sandbox is the safety boundary. Anything that
 * stays inside the sandbox auto-approves. Things that try to escape
 * (network reach, shell tricks the dangerous-pattern list catches)
 * fall through to a human review prompt.
 *
 * The boundary is chosen deliberately: it is the one line a tool cannot
 * blur. "Is this edit risky?" has no stable answer, but "does this leave
 * the sandbox?" does — so the gate asks the question it can answer, and
 * asks a human about the rest.
 *
 * What this enables:
 * - `allowReadOnlyTools` — anything `tool.isReadOnly(input)` reports
 *   as read-only auto-approves (file reads, lookups, web search).
 * - `denyDangerousPatterns` — the canonical brick-the-host shell
 *   tricks (`rm -rf /`, sudo, `curl … | sh`, etc.) hard-deny.
 * - `allow_by_category: ['filesystem', 'analysis', 'custom']` —
 *   in-sandbox file mutation (write_file / edit) auto-approves
 *   because the FS boundary is enforced by the sandbox layer, not
 *   by per-call review.
 *
 * What still prompts for review:
 * - `category: 'shell'` and `category: 'network'` tools — bash and
 *   network calls do NOT auto-approve. The host is expected to
 *   either layer additional rules for its own threat model or rely
 *   on the review prompt. This is the conservative choice; hosts
 *   that trust their sandbox enough to auto-approve shell can opt
 *   in via {@link defaultSandboxedShellGateConfig}.
 *
 * Hosts override individual fields by spreading: `{ ...defaultSandboxedGateConfig(), logDecisions: false }`.
 */
export function defaultSandboxedGateConfig(): AuthorizationGateConfig {
	return {
		enabled: true,
		allowReadOnlyTools: true,
		// See the shell preset below for what this closes: the read-only
		// allowance asks whether a claim is trustworthy, never what channel
		// the call travels over.
		allowReadOnlyExcludeCategories: ['network'],
		denyDangerousPatterns: true,
		logDecisions: false,
		rules: [{ type: 'allow_by_category', categories: ['filesystem', 'analysis', 'custom'] }],
	}
}

/**
 * Like {@link defaultSandboxedGateConfig} but additionally trusts
 * `category: 'shell'` tools (bash, etc.) to auto-approve inside the
 * sandbox, on the assumption that the host has real OS-level
 * isolation around the agent's working directory and outbound
 * network. The dangerous-patterns deny rule still hard-denies the
 * canonical brick patterns.
 *
 * Use this when:
 * - The agent runs inside a per-task container or VM.
 * - Outbound network is gated by an egress allowlist proxy.
 * - The cost of a per-call review prompt outweighs the cost of an
 *   in-sandbox shell mistake.
 *
 * Don't use this when the agent runs in a shared process with
 * other tenants, or when the working directory is the user's
 * actual home/repo without an extra isolation layer.
 */
export function defaultSandboxedShellGateConfig(): AuthorizationGateConfig {
	return {
		enabled: true,
		allowReadOnlyTools: true,
		// The docblock above says a `network` tool goes to review, and without
		// this it did not: `allow_read_only` is appended last as a default for
		// tools nobody wrote a rule about, and it resolved purely through
		// `isTrustedReadOnly` — which asks whether the read-only CLAIM is
		// trustworthy and never what the tool reaches. A read-only network
		// call matched the default and was approved without review, in the
		// preset whose own documentation said it would not be.
		allowReadOnlyExcludeCategories: ['network'],
		denyDangerousPatterns: true,
		logDecisions: false,
		rules: [
			{ type: 'allow_by_category', categories: ['filesystem', 'shell', 'analysis', 'custom'] },
		],
	}
}
