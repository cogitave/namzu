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
 * Bounds on what a run may spend on advice.
 *
 * Every cap here is enforced. Per-SESSION caps used to be declared beside
 * these and were not: the advisory stack is built once per run, so there was
 * no accumulator that outlived one, and the field could only ever read as a
 * promise. A host that wants a session bound holds it where sessions live.
 */
export interface AdvisoryBudget {
	/** Advisory calls allowed in one run. Checked before each call. */
	readonly maxCallsPerRun?: number
	/**
	 * Total advisory spend allowed in one run, in the same units as
	 * {@link ModelPricing}. Requires every advisor to carry `pricing`;
	 * a run configured otherwise is refused rather than left uncapped.
	 */
	readonly maxCostPerRun?: number
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
