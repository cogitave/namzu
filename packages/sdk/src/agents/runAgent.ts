import { ToolRegistry } from '../registry/tool/execute.js'
import { drainQuery } from '../runtime/query/index.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider } from '../types/provider/index.js'
import type { Run, RunEventListener } from '../types/run/index.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../utils/id.js'

/**
 * The session a run belongs to.
 *
 * Every field is generated when absent, and the generated values come back on
 * the result so a second turn can be handed the same ones. That pairing is the
 * point: auto-generating alone would make each call its own session, which is
 * right for a one-shot and silently wrong for a conversation — the second turn
 * would start with no history and no shared budget, and nothing would say so.
 */
export interface AgentIdentity {
	sessionId?: SessionId
	threadId?: ThreadId
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

	/** Defaults to the current working directory. */
	workingDirectory?: string

	maxIterations?: number
	tokenBudget?: number
	timeoutMs?: number
	temperature?: number

	/** Names the agent in traces and events. Defaults to `Agent`. */
	name?: string

	signal?: AbortSignal
	listener?: RunEventListener
}

export interface RunAgentResult {
	/** The model's final text, or `undefined` if it produced none. */
	readonly output: string | undefined

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
const DEFAULT_MAX_ITERATIONS = 16
const DEFAULT_TOKEN_BUDGET = 200_000
const DEFAULT_TIMEOUT_MS = 300_000

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
		threadId: options.threadId ?? generateThreadId(),
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
			...identity,
		} as never,
		options.listener,
	)

	return { output: run.result, run, identity }
}
