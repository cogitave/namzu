import type { CompactionConfig } from '../../config/runtime.js'
import type { AdvisoryConfig } from '../advisory/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { TaskRouterConfig } from '../router/index.js'
import type { SandboxProvider } from '../sandbox/index.js'
import type { Skill } from '../skills/index.js'
import type { ToolRegistryContract } from '../tool/index.js'
import type { VerificationGateConfig } from '../verification/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { AgentFactoryOptions } from './factory.js'
import type { TaskGateway } from './gateway.js'
import type { AgentManagerContract } from './manager.js'
import type { WorkingMemoryProvider } from './working-memory.js'

export interface SupervisorAgentConfig extends BaseAgentConfig {
	provider: LLMProvider

	agentIds: string[]

	gateway?: TaskGateway
	agentManager?: AgentManagerContract
	tools?: ToolRegistryContract

	systemPrompt: string

	skills?: Skill[]

	maxDepth?: number

	taskRouter?: TaskRouterConfig

	factoryOptions?: AgentFactoryOptions

	advisory?: AdvisoryConfig

	/**
	 * Optional human-in-the-loop hook for tool review and run-pause
	 * decisions. When omitted, the supervisor delegates to drainQuery's
	 * built-in `autoApproveHandler`, which approves every tool call
	 * without prompting — matching Anthropic's "Act without asking"
	 * cowork mode.
	 *
	 * Hosts that want "Ask before acting" behaviour pass a custom
	 * handler that surfaces the `tool_review_requested` RunEvent to
	 * the user and resolves the returned promise once the user
	 * approves, rejects, or modifies the call.
	 */
	resumeHandler?: ResumeHandler

	/**
	 * Optional declarative gate evaluated before tool execution. When
	 * the gate marks all calls in a batch as `allow`, they execute
	 * without round-tripping through the resumeHandler. Mixed or all-
	 * deny outcomes fall through to review (and the resumeHandler).
	 *
	 * Use it to express deterministic policy (e.g. "internal
	 * read-only tools always allow; destructive shell calls always
	 * review") so the resumeHandler only fires for the truly
	 * non-deterministic cases.
	 */
	verificationGate?: VerificationGateConfig

	/**
	 * Optional ephemeral sandbox provider. When set, drainQuery creates
	 * a sandbox via `provider.create()` before the supervisor's own
	 * iteration loop and routes filesystem / shell tool calls through
	 * it. Multi-agent hosts thread the SAME provider instance into
	 * every child `ReactiveAgentConfig.sandboxProvider` so supervisor
	 * + children share one ephemeral container per task.
	 */
	sandboxProvider?: SandboxProvider

	/**
	 * Optional structured-compaction config. When omitted, `query()` never
	 * builds a `WorkingStateManager` and compaction early-returns — the run
	 * path is byte-identical to a non-compacting run. Hosts opt in (e.g. with
	 * a `contextWindowTokens`) to keep a long single run alive instead of
	 * silently truncating.
	 */
	compactionConfig?: CompactionConfig

	/**
	 * Optional neutral working-memory seam. When set, the SDK re-renders the
	 * provider's string into a single pinned leading system message every
	 * iteration (the primacy-edge, compaction-preserved slot). Absent ⇒ no
	 * block is ever injected. The SDK only positions the string; the host owns
	 * its content and trust framing.
	 */
	workingMemoryProvider?: WorkingMemoryProvider
}

export interface AgentTaskResult {
	agentId: string
	result: BaseAgentResult
	taskIndex: number
}

export interface SupervisorAgentResult extends BaseAgentResult {
	taskResults: AgentTaskResult[]
	completedTasks: number
	totalTasks: number
}
