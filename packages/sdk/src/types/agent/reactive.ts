import type { CompactionConfig } from '../../config/runtime.js'
import type { QueryParams } from '../../runtime/query/index.js'
import type { AdvisoryConfig } from '../advisory/index.js'
import type { AuthorizationGateConfig } from '../authorization/index.js'
import type { InputGuardrailSpec, OutputGuardrailSpec } from '../guardrail/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { CheckpointStore } from '../run/checkpoint-store.js'
import type { BeforeStep, PrepareStepChain, StepResult, StopCondition } from '../run/index.js'
import type { SandboxProvider } from '../sandbox/index.js'
import type { Skill } from '../skills/index.js'
import type { StructuredOutputConfig } from '../structured-output/index.js'
import type { ToolRegistryContract } from '../tool/index.js'
import type { RepairToolCall } from '../tool/repair.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { WorkingMemoryProvider } from './working-memory.js'

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
	/**
	 * @deprecated Renamed to `authorizationGate`. Removed in the next major.
	 * Setting both to different configs throws.
	 */
	verificationGate?: AuthorizationGateConfig

	authorizationGate?: AuthorizationGateConfig

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

	/**
	 * Optional structured-compaction config. Omitted ⇒ byte-identical run path
	 * (no `WorkingStateManager`, compaction early-returns). Mirrors the field
	 * on `SupervisorAgentConfig` so a child specialist can share the
	 * supervisor's compaction settings.
	 */
	compactionConfig?: CompactionConfig

	/**
	 * Optional neutral working-memory seam — same contract as the field on
	 * `SupervisorAgentConfig`. Absent ⇒ no block injected. A child specialist
	 * sharing the supervisor's output dir passes the same provider.
	 */
	workingMemoryProvider?: WorkingMemoryProvider

	/**
	 * Loop-control and resilience seams, forwarded verbatim to `query()`.
	 *
	 * These existed on `QueryParams` and stopped there. `ReactiveAgent` is
	 * the entry point most consumers actually use — it is what
	 * `AgentManager` spawns and what the estate's own applications call —
	 * and it forwarded none of them. So a per-tool deadline, a provider
	 * retry policy, a guardrail, a stop condition: all of it was reachable
	 * only by dropping down to `query()` and rebuilding the run wiring by
	 * hand. Features that a consumer cannot reach are features that do not
	 * exist for them.
	 *
	 * Every field is optional and absent means exactly what it meant
	 * before, so no existing agent changes behavior.
	 */
	resumeHandler?: ResumeHandler
	retry?: QueryParams['retry']
	emergencySave?: boolean
	toolTimeoutMs?: number
	toolRetryBackoff?: QueryParams['toolRetryBackoff']
	maxToolConcurrency?: number
	maxToolOutputChars?: number
	/**
	 * Cap on the RICH channel of a single tool result, in base64 characters.
	 * `0` or absent disables it. Separate from {@link maxToolOutputChars}:
	 * that one bounds characters the model reads, this one bounds the image
	 * payload beside them, which no text budget ever touched.
	 */
	maxToolContentBytes?: number
	repairToolCall?: RepairToolCall
	stopWhen?: StopCondition
	onStepFinish?: (step: StepResult) => void
	prepareStep?: PrepareStepChain
	/**
	 * Refuse the next model call before it is made. See {@link BeforeStep}.
	 * A throw fails CLOSED, opposite to `prepareStep` beside it.
	 */
	beforeStep?: BeforeStep

	structuredOutput?: StructuredOutputConfig
	inputGuardrails?: readonly InputGuardrailSpec[]
	outputGuardrails?: readonly OutputGuardrailSpec[]
	checkpointStore?: CheckpointStore

	/**
	 * Span this run should hang off, when it is a delegated one. Absent for
	 * a top-level run, which correctly starts its own root trace.
	 */
	parentSpan?: import('@opentelemetry/api').Span
}

export interface ReactiveAgentResult extends BaseAgentResult {
	toolCallCount: number
}
