import type { ModelPricing } from '../../utils/cost.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { AdvisoryTrigger } from './trigger.js'

export interface AdvisorDefinition {
	readonly id: string
	readonly name: string
	readonly provider: LLMProvider
	readonly model: string
	readonly domains?: string[]
	readonly persona?: AgentPersona
	readonly systemPrompt?: string
	/**
	 * Conversation-record window, estimated at four serialized characters per
	 * token. Keeps a contiguous suffix of whole public records; roles, tool
	 * calls/results, escaping and separators count toward this window.
	 * Fixed framing, working state, tool catalogue, system prompt and question
	 * are separate. Omitted or zero leaves the record window unbounded.
	 */
	readonly maxContextTokens?: number
	readonly useCompactedContext?: boolean
	readonly maxResponseTokens?: number
	readonly temperature?: number
	/**
	 * What this advisor's model costs. Absent means cost is not measured,
	 * which is fine until a cost cap is set — see {@link AdvisoryBudget}.
	 */
	readonly pricing?: ModelPricing
}

/**
 * Bounds on what a turn may spend on advice.
 *
 * Every cap here is enforced. Per-SESSION caps used to be declared beside
 * these and were not: the advisory stack is built once per turn, so there was
 * no accumulator that outlived one, and the field could only ever read as a
 * promise. A host that wants a session bound holds it where sessions live.
 */
export interface AdvisoryBudget {
	/** Advisory calls allowed in one turn. Checked before each call. */
	readonly maxCallsPerTurn?: number
	/**
	 * Total advisory spend allowed in one turn, in the same units as
	 * {@link ModelPricing}. Requires every advisor to carry `pricing`;
	 * a turn configured otherwise is refused rather than left uncapped.
	 */
	readonly maxCostPerTurn?: number
	/** Response-token ceiling applied to each call, clamping the advisor's own. */
	readonly maxTokensPerCall?: number
}

export interface AdvisoryConfig {
	readonly advisors: AdvisorDefinition[]
	readonly defaultAdvisorId?: string
	readonly budget?: AdvisoryBudget
	readonly triggers?: AdvisoryTrigger[]
	readonly enableAgentTool?: boolean
	readonly includeToolCatalog?: boolean
}
