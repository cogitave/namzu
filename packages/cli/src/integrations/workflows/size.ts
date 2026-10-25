/**
 * Workflow size: the advisory guideline the model reads, the "+500k" token
 * target the person can type, and the large-run warning on the rail. Pure.
 *
 * The guideline is advice, never a limit; the target is a ceiling that
 * `budget.total` carries into the script; the warning fires above 25 agents
 * or 1.5M tokens unless the standing hypermode is on.
 */

export const WORKFLOW_SIZE_GUIDELINES = ['unrestricted', 'small', 'medium', 'large'] as const
export type WorkflowSizeGuideline = (typeof WORKFLOW_SIZE_GUIDELINES)[number]

/** The guideline when none is configured. */
export const DEFAULT_WORKFLOW_SIZE_GUIDELINE: WorkflowSizeGuideline = 'medium'

const GUIDELINE_AGENTS = { small: 5, medium: 10, large: 50 } as const

export function isWorkflowSizeGuideline(value: unknown): value is WorkflowSizeGuideline {
	return WORKFLOW_SIZE_GUIDELINES.includes(value as WorkflowSizeGuideline)
}

/** The agent count a guideline stays under, or undefined for `unrestricted`. */
export function guidelineAgents(guideline: WorkflowSizeGuideline): number | undefined {
	return guideline === 'unrestricted' ? undefined : GUIDELINE_AGENTS[guideline]
}

/**
 * The advisory paragraph appended to the tool description, or '' for
 * `unrestricted`. `configured` is false when the guideline is the default.
 */
export function workflowSizeAdvice(guideline: WorkflowSizeGuideline, configured: boolean): string {
	const agents = guidelineAgents(guideline)
	if (agents === undefined) return ''
	const head = configured
		? 'A workflow size guideline is configured for this session:'
		: 'This session has the default workflow size guideline:'
	const tail = configured
		? ''
		: ' The person can raise or remove it with workflow.sizeGuideline in the configuration.'
	return `${head} ${guideline}, so keep workflows under ${agents} agents. This is a guideline, not a hard limit: follow it unless the person's prompt calls for a different scale.${tail}`
}

const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 } as const

/**
 * The token target in a message the person typed: a standalone `+500k`,
 * `+1.5m` or `+2b` (case-insensitive; the k, m or b suffix is required, so a
 * bare number such as `+5000` in prose or a diff is never a target). The last
 * one wins. Returns undefined when there is none. Call it only with the
 * person's own text, never with model output or tool results.
 */
export function parseTokenTarget(text: string): number | undefined {
	let found: number | undefined
	for (const match of text.matchAll(/(?<![\w+.])\+(\d+(?:\.\d+)?)([kmb])(?![\w])/gi)) {
		const unit = match[2]?.toLowerCase() as keyof typeof SUFFIX
		const value = Math.round(Number(match[1]) * SUFFIX[unit])
		if (Number.isSafeInteger(value) && value > 0) found = value
	}
	return found
}

/**
 * The token ceiling a workflow runs under: the smaller of the turn's own
 * budget (when positive) and the typed target, or undefined for neither.
 */
export function workflowTokenCeiling(
	turnBudget: number | undefined,
	typedTarget: number | undefined,
): number | undefined {
	const ceilings = [
		turnBudget !== undefined && turnBudget > 0 ? turnBudget : undefined,
		typedTarget,
	].filter((value): value is number => value !== undefined)
	return ceilings.length > 0 ? Math.min(...ceilings) : undefined
}

const WARNING_AGENTS = 25
const WARNING_TOKENS = 1_500_000
const AVERAGE_AGENT_TOKENS = 70_000

export interface LargeRunInput {
	/** Agents the script asked for so far, queued ones included. */
	readonly scheduledAgents: number
	/** Agents that started. */
	readonly startedAgents: number
	readonly totalTokens: number
	/** The standing hypermode is on: the person already asked for scale. */
	readonly hypermode: boolean
	/** The guideline only when the person configured one. */
	readonly configuredGuideline?: WorkflowSizeGuideline
	readonly env?: Readonly<Record<string, string | undefined>>
}

function positive(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const value = Number(raw)
	return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Whether a running workflow is big enough to warn about. */
export function isLargeRun(input: LargeRunInput): boolean {
	if (input.hypermode) return false
	const env = input.env ?? {}
	const guided =
		input.configuredGuideline === undefined ? undefined : guidelineAgents(input.configuredGuideline)
	const agentCap = positive(env.NAMZU_WORKFLOW_SIZE_WARNING_AGENTS) ?? guided ?? WARNING_AGENTS
	const tokenCap = positive(env.NAMZU_WORKFLOW_SIZE_WARNING_TOKENS) ?? WARNING_TOKENS
	const average =
		input.startedAgents > 0 ? input.totalTokens / input.startedAgents : AVERAGE_AGENT_TOKENS
	const projected = Math.max(input.totalTokens, Math.round(average * input.scheduledAgents))
	return input.scheduledAgents > agentCap || input.totalTokens > tokenCap || projected > tokenCap
}

/** The rail row's warning, long form and short form. */
export const LARGE_WORKFLOW_WARNING = 'Large workflow · /workflows to stop'
export const LARGE_WORKFLOW_WARNING_SHORT = 'Large workflow'
