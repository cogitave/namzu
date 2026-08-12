import type { ToolDefinition } from '../types/tool/index.js'

/**
 * May this tool's read-only claim settle a gate on its own?
 *
 * A connected server declares whether its own tools are read-only, and
 * that declaration decided whether a call was approved without asking. The
 * thing being gated supplied the input to the gate.
 *
 * The wire itself calls these fields HINTS. Three separate consumers read
 * them as facts, so a server setting `readOnlyHint: true` and
 * `destructiveHint: false` controlled the whole predicate for its own
 * tools — the kernel's `allow_read_only` rule, the operator prompt
 * exemption, and the plan-mode pass.
 *
 * The estate floor this repository inherits already decided this: least
 * privilege, default deny, and — on tool results and fetched content —
 * data is not instructions, and untrusted content cannot escalate
 * capabilities. A server's declaration about its own tools is untrusted
 * content by that definition. This is that rule applied, not a new policy.
 *
 * **The asymmetry is the design.** A self-declaration may RAISE the
 * requirement and never LOWER it:
 *
 *  - `destructiveHint: true` from a server is believed. A server
 *    volunteering that its tool is dangerous moves toward caution, and
 *    disbelieving it buys nothing.
 *  - `readOnlyHint: true` from a server does not, on its own, settle a
 *    call as allowed or skip a prompt. That is the untrusted party
 *    opening its own gate.
 *
 * Trust for the second case comes from the operator, per server, and is
 * recorded on the tool as `provenance.readOnlyHintTrusted`. Never a global
 * switch: one flag meaning "trust annotations" hands every connected
 * server the same reach, which is the hole restated.
 *
 * `isReadOnly` itself is left reporting faithfully what the server said.
 * Provenance and policy are different questions, and collapsing them would
 * corrupt the outbound re-export and the prompt's own destructive label in
 * order to fix a gate.
 */
export function isTrustedReadOnly(tool: ToolDefinition | undefined, input: unknown): boolean {
	if (!tool?.isReadOnly) return false

	// No provenance means the tool is host-defined: it came from this
	// process, from code the operator installed, and there is no untrusted
	// party in the chain. Requiring an opt-in for a builtin would break
	// every read-only exemption for no gain in trust.
	if (tool.provenance && !tool.provenance.readOnlyHintTrusted) return false

	return tool.isReadOnly(input)
}
