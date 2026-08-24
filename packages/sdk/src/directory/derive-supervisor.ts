import { DEFAULT_TIMEOUT_MS, DEFAULT_TOKEN_BUDGET } from '../agents/runAgent.js'
import type { AgentIdentity } from '../agents/runAgent.js'
import { ToolRegistry } from '../registry/tool/execute.js'
import type { SupervisorAgentConfig } from '../types/agent/supervisor.js'
import type { LLMProvider } from '../types/provider/index.js'

import type { DirectoryManifest, SubAgentEntry } from './types.js'

export interface DeriveSupervisorInput {
	readonly provider: LLMProvider
	/** Wins over `agent.ts`. Required when `agent.ts` names no model. */
	readonly model?: string
	readonly identity?: Required<AgentIdentity>
	/**
	 * The lifecycle object that actually spawns delegates.
	 *
	 * Supplied by the host and never built here. An `AgentManager` owns
	 * running processes, budgets and cancellation — it is a thing with a
	 * lifetime, not a description of one, and this package's whole boundary is
	 * that it describes and does not run. Handing back options that carry a
	 * manager we constructed would make it a runner wearing a loader's name.
	 */
	readonly agentManager: SupervisorAgentConfig['agentManager']
	readonly overrides?: Partial<SupervisorAgentConfig>
}

export interface SupervisorPlan {
	/** Ready for `new SupervisorAgent(...).run(input, config)`. */
	readonly config: SupervisorAgentConfig
	/**
	 * What the host must register with its `AgentManager` before running,
	 * one per delegate, keyed by the id the supervisor will name.
	 *
	 * Returned rather than registered: registration is a mutation of the
	 * host's manager, and a function that quietly mutates an object it was
	 * handed for reference is the kind of surprise this package exists to
	 * avoid. The host does it, in one loop it can see.
	 */
	readonly delegates: readonly DelegatePlan[]
}

export interface DelegatePlan {
	readonly id: string
	readonly manifest: DirectoryManifest
	/** The delegate's own instructions, tools and model, already assembled. */
	readonly systemPrompt: string
	readonly tools: ToolRegistry
	readonly model: string
}

function toolsOf(manifest: DirectoryManifest): ToolRegistry {
	const tools = new ToolRegistry()
	for (const entry of manifest.tools) tools.register(entry.definition)
	return tools
}

function delegatePlan(entry: SubAgentEntry, fallbackModel: string): DelegatePlan {
	return {
		id: entry.id,
		manifest: entry.manifest,
		systemPrompt: entry.manifest.instructions,
		tools: toolsOf(entry.manifest),
		// A delegate may name its own model — a cheap one for a narrow job is
		// the common case — and inherits the supervisor's only when it does
		// not. Inheriting unconditionally would silently bill every specialist
		// at the coordinator's rate.
		model: entry.manifest.config.model ?? fallbackModel,
	}
}

/**
 * Turn a project that declares delegates into a supervisor configuration.
 *
 * The counterpart to `deriveRunOptions` for the multi-agent shape, and the
 * same contract: it converts, it does not run. `SupervisorAgent` needs an
 * `agentIds` roster and a manager that can spawn them; this supplies the
 * roster from the directory and leaves the manager to the host.
 *
 * The delegates come back as plans rather than registered agents because
 * registration mutates the host's manager. Two lines in the host, and the host
 * can see exactly what it just gained.
 */
export function deriveSupervisorOptions(
	manifest: DirectoryManifest,
	input: DeriveSupervisorInput,
): SupervisorPlan {
	if (manifest.modules === 'skip') {
		throw new Error(
			'This manifest was loaded with modules: "skip", so no tool was imported and no delegate was evaluated. Load with modules: "evaluate" before deriving supervisor options.',
		)
	}
	if (manifest.agents.length === 0) {
		// Not a warning that degrades into a supervisor with nobody to call.
		// An empty roster makes `create_task` unmountable by design, so the
		// result would be a coordinator that cannot coordinate — and the
		// caller asked for a supervisor, which means they expected delegates.
		throw new Error(
			`${manifest.root} declares no delegates, so there is nothing for a supervisor to coordinate. Add directories under agents/, or use deriveRunOptions for a single agent.`,
		)
	}

	const model = input.model ?? manifest.config.model
	if (!model) {
		throw new Error(
			`No model. Declare one in ${manifest.root}/agent.ts as \`export default { model: "…" }\`, or pass \`model\` here.`,
		)
	}

	const delegates = manifest.agents.map((entry) => delegatePlan(entry, model))

	const config = {
		provider: input.provider,
		model,
		agentManager: input.agentManager,
		agentIds: delegates.map((d) => d.id),
		systemPrompt: manifest.instructions,
		tools: toolsOf(manifest),
		// Skills were loaded and then dropped. The manifest reads a whole
		// `skills/` directory and `SupervisorAgentConfig` takes them, and the
		// cast that used to close this object meant nobody was told the field
		// had never been supplied.
		...(manifest.skills.length > 0 ? { skills: manifest.skills.map((s) => s.skill) } : {}),
		// `tokenBudget` and `timeoutMs` are REQUIRED by `BaseAgentConfig`, and
		// this object supplied them only when `agent.ts` happened to declare
		// them — which is the uncommon case. The `as SupervisorAgentConfig`
		// below made that compile, so a directory that named no budget produced
		// a config typed `tokenBudget: number` holding `undefined`, and
		// `buildLimitConfig` then disabled BOTH hard stops: no token cap, no
		// wall clock. Worse, the child-spawn refusal computes its allocation
		// from the parent budget, so `undefined` became `NaN`, and `NaN <= 0`
		// is false — the guard that exists to refuse an unfunded child let it
		// through with a NaN budget.
		//
		// Defaulted to the same numbers `runAgent` uses rather than to a local
		// guess, so the two front doors cannot drift.
		tokenBudget: manifest.config.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
		timeoutMs: manifest.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		...(manifest.config.streamIdleTimeoutMs !== undefined
			? { streamIdleTimeoutMs: manifest.config.streamIdleTimeoutMs }
			: {}),
		...(manifest.config.maxRequestRichContentBytes !== undefined
			? {
					maxRequestRichContentBytes: manifest.config.maxRequestRichContentBytes,
				}
			: {}),
		...(manifest.config.attachmentResolveTimeoutMs !== undefined
			? {
					attachmentResolveTimeoutMs: manifest.config.attachmentResolveTimeoutMs,
				}
			: {}),
		...(manifest.config.temperature !== undefined
			? { temperature: manifest.config.temperature }
			: {}),
		...(manifest.config.maxIterations !== undefined
			? { maxIterations: manifest.config.maxIterations }
			: {}),
		...(input.identity ?? {}),
		...(input.overrides ?? {}),
	} satisfies SupervisorAgentConfig

	return { config, delegates }
}
