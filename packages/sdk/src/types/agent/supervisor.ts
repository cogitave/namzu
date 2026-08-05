import type { CompactionConfig } from '../../config/runtime.js'
import type { SteeringChannel } from '../../runtime/query/steering.js'
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

	/**
	 * May this run invoke subagents at all? Defaults to `true`.
	 *
	 * `agentIds` answers WHO may be called; this answers WHETHER, and they are
	 * different questions. A run whose own persona is the single agent on the
	 * list has a non-empty list and still must not call anyone.
	 *
	 * It cannot be derived. Comparing the list against the executing agent
	 * fails where a host substitutes a specialist's persona into the
	 * supervisor shell — the two ids differ, so the predicate says "can
	 * delegate" about a run that cannot. And no predicate over `agentIds`
	 * could work, because a supervisor whose list holds one specialist and a
	 * run that IS that specialist are indistinguishable in it. The fact lives
	 * with the caller, so the caller states it.
	 *
	 * Positive polarity on purpose: `allowDelegation: false` reads correctly
	 * the first time, where a `delegationDisabled` spelling inverts twice at
	 * every site that consults it.
	 *
	 * **Absolute.** `runtimeToolOverrides` cannot put the delegation tools
	 * back — the override pass runs over the tools this flag already declined
	 * to build, and both values come from the same caller in the same call, so
	 * "must not delegate" plus "give it `create_task`" is a contradiction
	 * rather than extra knowledge. This matches `agentIds: []`, which is
	 * absolute today for the same reason.
	 */
	allowDelegation?: boolean

	gateway?: TaskGateway
	agentManager?: AgentManagerContract
	tools?: ToolRegistryContract

	systemPrompt: string

	skills?: Skill[]

	/**
	 * **Not consulted. The limit lives on `AgentManagerConfig.maxDepth`.**
	 *
	 * A supervisor does not own the recursion bound: it is enforced in
	 * `AgentManager.sendMessage`, against the manager's own config, and a
	 * supervisor receives a manager rather than building one. So a host that
	 * set this got the manager's value regardless — which for a safety limit
	 * is the worst way to be wrong, because the number in front of the
	 * reviewer is not the number in force.
	 *
	 * Stated rather than removed: it is reachable from the published
	 * typings, so it goes in the next major. Set the bound where it is read.
	 *
	 * @deprecated Set `maxDepth` on the `AgentManagerConfig` instead.
	 */
	maxDepth?: number

	taskRouter?: TaskRouterConfig

	factoryOptions?: AgentFactoryOptions

	advisory?: AdvisoryConfig

	/**
	 * Optional human-in-the-loop hook for tool review and run-pause
	 * decisions. When omitted, the supervisor delegates to drainQuery's
	 * built-in `autoApproveHandler`, which approves every tool call
	 * without prompting — the unattended mode, where the run is expected
	 * to finish without a human at the keyboard.
	 *
	 * Hosts that want "Ask before acting" behaviour pass a custom
	 * handler that surfaces the `tool_review_requested` RunEvent to
	 * the user and resolves the returned promise once the user
	 * approves, rejects, or modifies the call.
	 */
	resumeHandler?: ResumeHandler

	/**
	 * Channel a host uses to hand guidance to the supervisor's running turn.
	 *
	 * Present here for the same reason `resumeHandler` is: a capability the
	 * kernel honours in `drainQuery` and not on the surface hosts actually
	 * construct is a capability nobody can reach.
	 */
	steering?: SteeringChannel

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
