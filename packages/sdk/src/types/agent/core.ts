import type { RunEventListener } from '../run/index.js'
import type {
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	AgentType,
	BaseAgentConfig,
	BaseAgentResult,
} from './base.js'

export interface Agent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> {
	readonly type: AgentType
	readonly metadata: AgentMetadata

	run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>

	/**
	 * A shell of this agent that one run may have to itself.
	 *
	 * An agent instance holds per-run state — an abort controller, the id of
	 * the run in flight — and refuses a second concurrent `run` because of it.
	 * That refusal is correct for a host calling `run` twice on purpose: two
	 * overlapping runs would share one abort controller, so cancelling either
	 * kills both.
	 *
	 * It is wrong for delegation, which is why this exists. `AgentRegistry`
	 * hands out ONE instance per registered id, so a fan-out naming the same
	 * `agent_id` four times drove four runs at one shell: one worked and three
	 * died with `ConcurrentInvocationError`. The prescribed remedy — "construct
	 * a second instance" — was unreachable from there, because the definition
	 * owns the instance and the caller only has an id.
	 *
	 * OPTIONAL, and absence is safe: a manager that cannot get a fresh shell
	 * falls back to the shared one and the refusal stands, which is loud rather
	 * than wrong. `AbstractAgent` implements it for every agent built on it.
	 */
	forRun?(): Agent<TConfig, TResult>

	cancel(): Promise<void>
	getCapabilities(): AgentCapabilities
}
