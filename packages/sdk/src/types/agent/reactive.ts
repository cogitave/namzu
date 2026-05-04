import type { AdvisoryConfig } from '../advisory/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { SandboxProvider } from '../sandbox/index.js'
import type { Skill } from '../skills/index.js'
import type { ToolRegistryContract } from '../tool/index.js'
import type { VerificationGateConfig } from '../verification/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'

export interface ReactiveAgentConfig extends BaseAgentConfig {
	systemPrompt?: string

	persona?: AgentPersona

	skills?: Skill[]

	basePrompt?: string
	provider: LLMProvider
	tools: ToolRegistryContract

	advisory?: AdvisoryConfig

	/**
	 * Optional capability-aware deny/allow gate for child tool calls.
	 * Mirrors the same field on `SupervisorAgentConfig`; when omitted,
	 * `drainQuery` falls back to its `autoApproveHandler` default
	 * (every tool call auto-approves, no policy applied). Hosts that
	 * trust their sandbox should still pass at least
	 * `{ enabled: true, denyDangerousPatterns: true, ... }` so the
	 * canonical brick patterns hard-deny instead of executing
	 * silently.
	 */
	verificationGate?: VerificationGateConfig

	/**
	 * Optional ephemeral sandbox provider. When set, drainQuery creates
	 * a sandbox via `provider.create()` before the iteration loop and
	 * routes filesystem / shell tool calls through it; on run end the
	 * SDK calls `sandbox.destroy()`. Hosts that want a per-task
	 * container shared across supervisor + every child specialist run
	 * pass the SAME provider instance to all of them — caching layered
	 * on top of the provider keeps the underlying container alive.
	 */
	sandboxProvider?: SandboxProvider
}

export interface ReactiveAgentResult extends BaseAgentResult {
	toolCallCount: number
}
