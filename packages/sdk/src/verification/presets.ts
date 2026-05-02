import type { VerificationGateConfig } from '../types/verification/index.js'

/**
 * Sensible defaults for an agent that runs inside a host-provided
 * sandbox (isolated working directory, isolated container, or both).
 *
 * The model: the sandbox is the safety boundary. Anything that
 * stays inside the sandbox auto-approves. Things that try to escape
 * (network reach, shell tricks the dangerous-pattern list catches)
 * fall through to a human review prompt. This mirrors Codex CLI's
 * `workspace-write` + `on-request` default and Claude Code's
 * sandboxed permission mode.
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
export function defaultSandboxedGateConfig(): VerificationGateConfig {
	return {
		enabled: true,
		allowReadOnlyTools: true,
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
export function defaultSandboxedShellGateConfig(): VerificationGateConfig {
	return {
		enabled: true,
		allowReadOnlyTools: true,
		denyDangerousPatterns: true,
		logDecisions: false,
		rules: [
			{ type: 'allow_by_category', categories: ['filesystem', 'shell', 'analysis', 'custom'] },
		],
	}
}
