import { ToolRegistry } from '../registry/tool/execute.js'
import { drainQuery } from '../runtime/query/index.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider, ReasoningEffort, ThinkingConfig } from '../types/provider/index.js'
import type { Run, RunEventListener } from '../types/run/index.js'
import type { Skill } from '../types/skills/index.js'
import type { StructuredOutputConfig } from '../types/structured-output/index.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import type { VerificationGateConfig } from '../types/verification/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../utils/id.js'

/**
 * The session a run belongs to.
 *
 * Every field is generated when absent, and the generated values come back on
 * the result so a second turn can be handed the same ones. That pairing is the
 * point: auto-generating alone would make each call its own session, which is
 * right for a one-shot and silently wrong for a conversation — the second turn
 * would start with no history and no shared budget, and nothing would say so.
 *
 * **A generated id is a correlation label, not a store handle.** `runAgent`
 * takes no `SessionStore` and creates no records, so a `projectId` it mints
 * names no `Project`. Carrying one into a store-backed `AgentManager` is
 * refused at the first delegation with `Project <id> not found for tenant
 * <id> — spawn rejected`, which is the enforcement site behaving correctly:
 * delegation limits live on the project, and a missing project has no limits
 * to read. A run that has to delegate should be given the id returned by
 * `store.createProject()`.
 */
export interface AgentIdentity {
	sessionId?: SessionId
	topicId?: ThreadId
	projectId?: ProjectId
	tenantId?: TenantId
}

export interface RunAgentOptions extends AgentIdentity {
	/** The model driver. The one thing with no sensible default. */
	provider: LLMProvider

	/** What to ask. A string is turned into a single user message. */
	prompt: string | Message[]

	/** The system prompt. */
	instructions?: string

	/**
	 * Model id.
	 *
	 * Required, and not defaulted from the provider, because `LLMProvider`
	 * carries no model — a driver may have been constructed with one, but the
	 * interface does not expose it, so anything this function picked would be
	 * a guess billed to the caller. Two required options is a shape someone
	 * can hold in their head; a wrong model quietly used is not.
	 */
	model: string

	tools?: ToolRegistryContract

	/**
	 * Skills to put in front of the model.
	 *
	 * The kernel has taken these since it had a prompt builder; this door did
	 * not forward them, so a caller who assembled skills — `@namzu/project`
	 * reads a whole `skills/` directory — handed them over and got a run that
	 * had never heard of them. Silent, because the `drainQuery` call below was
	 * cast, and a cast seam reports nothing when a field goes missing.
	 */
	skills?: Skill[]

	/**
	 * Operator policy for tool calls: which ones need review before they run.
	 *
	 * Absent means every tool runs unreviewed, which is the right default for a
	 * library front door and the wrong one for a host that hands this an agent
	 * directory it did not write. The kernel builds a `VerificationGate` from
	 * this and consults it on every call; without it there is nothing to
	 * consult, so a front-door run is strictly less mediated than a kernel one.
	 */
	verificationGate?: VerificationGateConfig

	/** Defaults to the current working directory. */
	workingDirectory?: string

	maxIterations?: number
	tokenBudget?: number
	timeoutMs?: number
	temperature?: number

	/**
	 * Demand a schema-validated answer instead of prose.
	 *
	 * The front door could not ask for one at all: the runtime has supported
	 * structured output throughout and this function never forwarded the
	 * config, so the single most convenient way into the kernel was the one way
	 * that could not produce a typed answer. Present, the validated value comes
	 * back on {@link RunAgentResult.structuredOutput} and on `run`.
	 */
	structuredOutput?: StructuredOutputConfig

	/**
	 * Extended-thinking request and response-effort level, forwarded on every
	 * model call.
	 *
	 * These are here because the run config below is assembled by HAND, and a
	 * hand-listed literal silently drops whatever nobody remembered to add —
	 * which is precisely what happened. `thinking` shipped on `AgentRunConfig`
	 * and was reachable only from the raw kernel entry point, because this
	 * function, `ReactiveAgent` and `SupervisorAgent` each rebuilt the object
	 * from a fixed list. So the capability existed and the front door could not
	 * open it.
	 *
	 * A live run is what found it: the unit tests passed because they drove the
	 * kernel directly, and a real agent run through this function put no effort
	 * on the wire at all.
	 */
	thinking?: ThinkingConfig
	effort?: ReasoningEffort

	/** Names the agent in traces and events. Defaults to `Agent`. */
	name?: string

	signal?: AbortSignal
	listener?: RunEventListener
}

export interface RunAgentResult {
	/** The model's final text, or `undefined` if it produced none. */
	readonly output: string | undefined

	/**
	 * The schema-validated answer, when {@link RunAgentOptions.structuredOutput}
	 * asked for one and the model produced it.
	 *
	 * Mirrors `run.structuredOutput` the way {@link output} mirrors
	 * `run.result` — the whole point of this shape is that the two answers a
	 * run can give are reachable without unpacking the run.
	 */
	readonly structuredOutput?: unknown

	/** The full run — usage, cost, steps, stop reason, every message. */
	readonly run: Run

	/**
	 * The identity this run used, with anything generated filled in.
	 *
	 * Pass it straight back into the next call to continue the same session.
	 */
	readonly identity: Required<AgentIdentity>
}

/**
 * Defaults chosen to be safe rather than generous.
 *
 * A front door exists so a first run works without a decision, and the cost of
 * that convenience is that nobody reads these numbers before their first
 * runaway loop. So: a budget that ends a stuck run in seconds rather than
 * dollars, and an iteration cap that stops a tool-calling loop well before a
 * context window does. Every one is overridable and named on the option.
 */
export const DEFAULT_MAX_ITERATIONS = 16
export const DEFAULT_TOKEN_BUDGET = 200_000
export const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Run an agent, without assembling a kernel by hand.
 *
 * `drainQuery` is the kernel's real entry point and takes eleven required
 * parameters, four of which are identity fields that throw when missing. That
 * is the correct shape for a kernel — a run with no tenant is a run no auditor
 * can attribute — and it is the wrong shape for the first thing anybody
 * writes. The proof was in this repo: the eval suites, the test files and the
 * CLI each hand-assemble the same block, which is what a missing front door
 * looks like from the inside.
 *
 * So this supplies an environment rather than a new engine. It generates the
 * identity a single-tenant local run has no opinion about, defaults the
 * budgets, points the working directory at the process's own, and hands back
 * both the answer and the identity it used. Everything it fills in is a normal
 * `drainQuery` parameter; there is no second code path, and a caller who
 * outgrows it passes more options until they are calling `drainQuery` in all
 * but name.
 *
 * ```ts
 * const { output } = await runAgent({
 *   provider,
 *   model: 'claude-sonnet-4-5',
 *   prompt: 'What is 2 + 2?',
 * })
 * ```
 *
 * A second turn in the same session is the identity handed back, and the
 * previous messages carried forward:
 *
 * ```ts
 * const first = await runAgent({ provider, model, prompt: 'My name is Ada.' })
 *
 * const second = await runAgent({
 *   provider,
 *   model,
 *   ...first.identity,
 *   prompt: [...first.run.messages, createUserMessage('What is my name?')],
 * })
 * ```
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
	const identity: Required<AgentIdentity> = {
		sessionId: options.sessionId ?? generateSessionId(),
		topicId: options.topicId ?? generateTopicId(),
		projectId: options.projectId ?? generateProjectId(),
		tenantId: options.tenantId ?? generateTenantId(),
	}

	const messages: Message[] =
		typeof options.prompt === 'string'
			? [{ role: 'user', content: options.prompt, timestamp: Date.now() } as Message]
			: options.prompt

	const run = await drainQuery(
		{
			provider: options.provider,
			tools: options.tools ?? new ToolRegistry(),
			messages,
			workingDirectory: options.workingDirectory ?? process.cwd(),
			runConfig: {
				model: options.model,
				maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
				tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
				...(options.thinking ? { thinking: options.thinking } : {}),
				...(options.effort ? { effort: options.effort } : {}),
			},
			// One option covers both. `drainQuery` separates the id from the
			// display name because a fleet needs a stable key and a readable
			// label; a single agent has no such tension, and asking for two
			// strings that will always be the same is the kind of ceremony this
			// function exists to remove.
			agentId: options.name ?? 'agent',
			agentName: options.name ?? 'Agent',
			...(options.instructions ? { systemPrompt: options.instructions } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.skills ? { skills: options.skills } : {}),
			...(options.verificationGate ? { verificationGate: options.verificationGate } : {}),
			...(options.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
			...identity,
		},
		options.listener,
	)

	return { output: run.result, structuredOutput: run.structuredOutput, run, identity }
}
