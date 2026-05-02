import type { AdvisoryConfig } from '../advisory/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
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
}

export interface ReactiveAgentResult extends BaseAgentResult {
	toolCallCount: number
}
