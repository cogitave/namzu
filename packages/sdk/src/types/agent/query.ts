import type { CompactionConfig } from '../../config/runtime.js'
import type { QueryParams } from '../../runtime/query/index.js'
import type { SteeringChannel } from '../../runtime/query/steering.js'
import type { Toolset } from '../../toolsets/types.js'
import type { AdvisoryConfig } from '../advisory/index.js'
import type { AuthorizationGateConfig } from '../authorization/index.js'
import type { InputGuardrailSpec, OutputGuardrailSpec } from '../guardrail/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { SandboxProvider } from '../sandbox/index.js'
import type { BeforeStep, PrepareStepChain, StepResult, StopCondition } from '../session/index.js'
import type { Skill } from '../skills/index.js'
import type { StructuredOutputConfig } from '../structured-output/index.js'
import type { RepairToolCall } from '../tool/repair.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { WorkingMemoryProvider } from './working-memory.js'

export interface QueryAgentConfig extends BaseAgentConfig {
	systemPrompt?: string
	/** Provider-hosted search for this turn; the selected driver must support it. */
	webSearch?: { mode: 'live' | 'cached' }

	persona?: AgentPersona

	/**
	 * Channel a host uses to hand guidance to this turn's current turn.
	 *
	 * Forwarded into `drainQuery` so a host using this adapter can steer the
	 * same turn it could steer through a direct `query()` call.
	 */
	steering?: SteeringChannel

	skills?: Skill[]

	basePrompt?: string
	provider: LLMProvider
	/** Every tool this turn may see comes from one of these — see `toolsets/types.ts`. */
	toolsets: readonly Toolset[]

	advisory?: AdvisoryConfig

	/**
	 * Optional capability-aware deny/allow gate for tool calls.
	 * When omitted,
	 * `drainQuery` falls back to its `autoApproveHandler` default
	 * (every tool call auto-approves, no policy applied). Hosts that
	 * trust their sandbox should still pass at least
	 * `{ enabled: true, denyDangerousPatterns: true, ... }` so the
	 * canonical brick patterns hard-deny instead of executing
	 * silently.
	 */

	authorizationGate?: AuthorizationGateConfig

	/**
	 * Optional ephemeral sandbox provider. When set, drainQuery creates
	 * a sandbox via `provider.create()` before the iteration loop and
	 * routes filesystem / shell tool calls through it; on turn end the
	 * SDK calls `sandbox.destroy()`. Hosts that want related turns to share
	 * one container pass the same caching provider instance to those turns.
	 */
	sandboxProvider?: SandboxProvider
	/** See {@link QueryParams.sandboxTeardownTimeoutMs}. */
	sandboxTeardownTimeoutMs?: number
	/** See {@link QueryParams.outsideRootAccess}. Default `'refuse'`. */
	outsideRootAccess?: 'refuse' | 'review'
	/** See {@link QueryParams.sandboxEscape}. Default `'refuse'`. */
	sandboxEscape?: 'refuse' | 'review'

	/**
	 * Optional structured-compaction config. Omitted ⇒ byte-identical run path
	 * (no `WorkingStateManager`, compaction early-returns).
	 */
	compactionConfig?: CompactionConfig

	/**
	 * Optional neutral working-memory seam. Absent ⇒ no block injected.
	 * Related turns can share one provider when the host wants shared memory.
	 */
	workingMemoryProvider?: WorkingMemoryProvider

	/**
	 * Loop-control and resilience seams, forwarded verbatim to `query()`.
	 *
	 * The optional `QueryAgent` adapter forwards these settings for hosts that
	 * need an `AgentManager` shell. Hosts using `query()` configure them there.
	 *
	 * Every field is optional and absent means exactly what it meant
	 * before, so no existing agent changes behavior.
	 */
	resumeHandler?: ResumeHandler
	retry?: QueryParams['retry']
	toolTimeoutMs?: number
	toolRetryBackoff?: QueryParams['toolRetryBackoff']
	maxToolConcurrency?: number
	maxToolOutputChars?: number
	retainedToolPreviewChars?: QueryParams['retainedToolPreviewChars']
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

	/**
	 * Span this turn should hang off, when it is a delegated one. Absent for
	 * a top-level turn, which correctly starts its own root trace.
	 */
	parentSpan?: import('@opentelemetry/api').Span
}

export interface QueryAgentResult extends BaseAgentResult {
	toolCallCount: number
}
