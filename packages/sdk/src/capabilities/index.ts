import { PromptContributionRegistry } from '../prompt/contributions.js'
import type { PromptContribution } from '../prompt/contributions.js'
import type { Toolset } from '../toolsets/types.js'
import type { InputGuardrailSpec, OutputGuardrailSpec } from '../types/guardrail/index.js'
import type { ProjectId, SessionId, TenantId, TopicId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { ReasoningEffort, ThinkingConfig } from '../types/provider/index.js'

export interface CapabilityModelSettings {
	readonly temperature?: number
	readonly thinking?: ThinkingConfig
	readonly effort?: ReasoningEffort
}

/** Host-authored behavior assembled for one agent invocation. */
export interface Capability {
	/** Stable across invocations; duplicate ids are refused. */
	readonly id: string
	readonly instructions?: string
	readonly toolsets?: readonly Toolset[]
	readonly promptContributions?: readonly PromptContribution[]
	readonly inputGuardrails?: readonly InputGuardrailSpec[]
	readonly outputGuardrails?: readonly OutputGuardrailSpec[]
	/** Later capabilities override earlier ones; explicit run options win. */
	readonly modelSettings?: CapabilityModelSettings
}

export interface CapabilityRunContext {
	readonly workingDirectory: string
	readonly model: string
	readonly prompt: string | readonly Message[]
	readonly sessionId: SessionId
	readonly topicId: TopicId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	readonly signal?: AbortSignal
}

/** A factory receives a fresh context on every invocation, including repeated session turns. */
export interface DynamicCapability {
	readonly id: string
	readonly forRun: (context: CapabilityRunContext) => Capability | null | Promise<Capability | null>
}

export type AgentCapability = Capability | DynamicCapability

function assertCapabilityId(id: string): void {
	if (typeof id !== 'string' || id.trim() !== id || id.length === 0) {
		throw new Error('Capability id must be a nonempty, trimmed string.')
	}
}

/** Snapshot a reusable host declaration. Toolsets retain their own source ownership. */
export function defineCapability(value: Capability): Capability {
	assertCapabilityId(value.id)
	return Object.freeze({
		...value,
		...(value.toolsets ? { toolsets: Object.freeze([...value.toolsets]) } : {}),
		...(value.promptContributions
			? { promptContributions: Object.freeze([...value.promptContributions]) }
			: {}),
		...(value.inputGuardrails
			? { inputGuardrails: Object.freeze([...value.inputGuardrails]) }
			: {}),
		...(value.outputGuardrails
			? { outputGuardrails: Object.freeze([...value.outputGuardrails]) }
			: {}),
		...(value.modelSettings ? { modelSettings: Object.freeze({ ...value.modelSettings }) } : {}),
	})
}

/** Make the factory's stable identity explicit before it sees a run. */
export function dynamicCapability(
	id: string,
	forRun: DynamicCapability['forRun'],
): DynamicCapability {
	assertCapabilityId(id)
	return Object.freeze({ id, forRun })
}

export interface ResolvedCapabilities {
	readonly toolsets: readonly Toolset[]
	readonly promptContributions: PromptContributionRegistry
	readonly modelSettings: CapabilityModelSettings
	readonly inputGuardrails: readonly InputGuardrailSpec[]
	readonly outputGuardrails: readonly OutputGuardrailSpec[]
}

async function resolveForRun(
	entry: DynamicCapability,
	context: CapabilityRunContext,
): Promise<Capability | null> {
	if (!context.signal) return await entry.forRun(context)
	const signal = context.signal
	return await new Promise<Capability | null>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort)
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
			return
		}
		Promise.resolve()
			.then(() => entry.forRun(context))
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', onAbort))
	})
}

/** Resolve each factory exactly once, in declaration order, before the first model call. */
export async function resolveCapabilities(
	capabilities: readonly AgentCapability[],
	context: CapabilityRunContext,
): Promise<ResolvedCapabilities> {
	const seen = new Set<string>()
	const toolsets: Toolset[] = []
	const promptContributions = new PromptContributionRegistry()
	const inputGuardrails: InputGuardrailSpec[] = []
	const outputGuardrails: OutputGuardrailSpec[] = []
	let modelSettings: CapabilityModelSettings = {}

	for (const entry of capabilities) {
		context.signal?.throwIfAborted()
		assertCapabilityId(entry.id)
		if (seen.has(entry.id)) throw new Error(`Capability "${entry.id}" is declared twice.`)
		seen.add(entry.id)

		const resolved = 'forRun' in entry ? await resolveForRun(entry, context) : entry
		context.signal?.throwIfAborted()
		if (resolved === null) continue
		if (!resolved) throw new Error(`Capability "${entry.id}" returned no declaration.`)
		if (resolved.id !== entry.id) {
			throw new Error(
				`Capability "${entry.id}" returned id "${resolved.id}"; a run factory must keep its declared id.`,
			)
		}
		const capability = defineCapability(resolved)
		toolsets.push(...(capability.toolsets ?? []))
		if (capability.instructions?.trim()) {
			const instructions = capability.instructions
			promptContributions.register({
				id: `capability:${capability.id}:instructions`,
				placement: 'dynamic',
				render: () => instructions,
			})
		}
		for (const contribution of capability.promptContributions ?? []) {
			promptContributions.register(contribution)
		}
		inputGuardrails.push(...(capability.inputGuardrails ?? []))
		outputGuardrails.push(...(capability.outputGuardrails ?? []))
		modelSettings = { ...modelSettings, ...capability.modelSettings }
	}
	return { toolsets, promptContributions, modelSettings, inputGuardrails, outputGuardrails }
}
