import { ToolRegistry } from '../registry/tool/execute.js'
import { type QueryParams, drainQuery } from '../runtime/query/index.js'
import type { ProjectInstructionContext } from '../runtime/query/project-instructions.js'
import { resolveNamzuHome } from '../session/home.js'
import { SessionPaths, ensureProject } from '../session/paths.js'
import { InMemorySessionLog } from '../store/session-log/index.js'
import type { AuthorizationGateConfig } from '../types/authorization/index.js'
import type { ProjectId, SessionId, TenantId, TopicId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { LLMProvider, ReasoningEffort, ThinkingConfig } from '../types/provider/index.js'
import type { SandboxProvider } from '../types/sandbox/index.js'
import type { SessionEventListener } from '../types/session/events.js'
import type { Turn } from '../types/session/turn.js'
import type { Skill } from '../types/skills/index.js'
import type { StructuredOutputConfig } from '../types/structured-output/index.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../utils/id.js'

/**
 * The session a turn belongs to.
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
 * to read. A turn that has to delegate should be given the id returned by
 * `store.createProject()`.
 */
export interface AgentIdentity {
	sessionId?: SessionId
	topicId?: TopicId
	/**
	 * Omitted: the project the working directory stands for, read from (or
	 * minted once into) `~/.namzu/projects/<slug>/project.json` by
	 * `ensureProject`, so every turn in one directory shares a Project. A
	 * session held in memory with no `paths` gets a fresh id and writes
	 * nothing. A host whose `paths` name a slug of its own passes the id. The
	 * other three are minted per call when omitted.
	 */
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
	 * Screens to run against every tool result, where the registry was not
	 * built with its own.
	 *
	 * The front door needs its own way to say this, because the registry it
	 * was handed — usually the host's, assembled before this call — is not a
	 * place a turn can reach. Absent installs the shipped default
	 * ({@link DEFAULT_TOOL_RESULT_GUARDRAILS}: a connected server's result
	 * that restates the request is refused). **An empty array is how a caller
	 * turns that off**, and it is the reason this option is here at all: a
	 * default a caller cannot disable is not a default, it is a change to
	 * their program.
	 */
	toolResultGuardrails?: readonly import('../types/guardrail/index.js').ToolResultGuardrailSpec[]
	/** Execute sandbox-aware tools inside this provider's boundary. */
	sandboxProvider?: SandboxProvider
	/** What a supplied sandbox is rooted at and its per-turn limits. */
	sandbox?: import('../types/session/config.js').TurnConfig['sandbox']
	/** Sandbox teardown wait; defaults to 30 seconds and `0` is unbounded. */
	sandboxTeardownTimeoutMs?: number

	/**
	 * Skills to put in front of the model.
	 *
	 * The kernel has taken these since it had a prompt builder; this door did
	 * not forward them, so a caller who assembled skills — `@namzu/project`
	 * reads a whole `skills/` directory — handed them over and got a turn that
	 * had never heard of them. Silent, because the `drainQuery` call below was
	 * cast, and a cast seam reports nothing when a field goes missing.
	 */
	skills?: Skill[]

	/**
	 * Operator policy for tool calls: which ones need review before they run.
	 *
	 * Absent means every tool runs unreviewed, which is the right default for a
	 * library front door and the wrong one for a host that hands this an agent
	 * directory it did not write. The kernel builds a `AuthorizationGate` from
	 * this and consults it on every call; without it there is nothing to
	 * consult, so a front-door turn is strictly less mediated than a kernel one.
	 */
	/**
	 * @deprecated Renamed to `authorizationGate`. Removed in the next major.
	 * Setting both to different configs throws.
	 */
	verificationGate?: AuthorizationGateConfig

	authorizationGate?: AuthorizationGateConfig

	/** Defaults to the current working directory. */
	workingDirectory?: string

	/** Host-owned state layout (`NAMZU_HOME` and the project slug), independent of the tool working directory. */
	paths?: QueryParams['paths']
	/**
	 * The session log this turn appends to; omitted uses the log in the
	 * resolved layout. An `InMemorySessionLog` keeps the whole session in
	 * memory.
	 */
	sessionLog?: QueryParams['sessionLog']
	/** Optional checkpoint store; omitted uses the resolved disk layout. */
	checkpointStore?: QueryParams['checkpointStore']

	/** Default 16 main-loop iterations; 0 disables the iteration guard. */
	maxIterations?: number
	/** Default 200,000 cumulative tokens; 0 is unlimited and still metered. */
	tokenBudget?: number
	/** Default five minutes; 0 disables the turn deadline. */
	timeoutMs?: number
	/** Maximum provider-stream silence; defaults to five minutes. `0` disables. */
	streamIdleTimeoutMs?: number
	/** Accumulated inline image/document bytes per provider request. `0` disables. */
	maxRequestRichContentBytes?: number
	/** Maximum stored-attachment materialization time; defaults to one minute. `0` disables. */
	attachmentResolveTimeoutMs?: number
	/** Store that owns any `stored` attachment refs carried by `prompt`. */
	attachmentStore?: import('../store/attachment/index.js').AttachmentStore
	temperature?: number

	/**
	 * Demand a schema-validated answer instead of prose.
	 *
	 * The front door could not ask for one at all: the runtime has supported
	 * structured output throughout and this function never forwarded the
	 * config, so the single most convenient way into the kernel was the one way
	 * that could not produce a typed answer. Present, the validated value comes
	 * back on {@link RunAgentResult.structuredOutput} and on `turn`.
	 */
	structuredOutput?: StructuredOutputConfig

	/**
	 * Extended-thinking request and response-effort level, forwarded on every
	 * model call.
	 *
	 * These are here because the turn config below is assembled by HAND, and a
	 * hand-listed literal silently drops whatever nobody remembered to add —
	 * which is precisely what happened. `thinking` shipped on the turn config
	 * and was reachable only from the raw kernel entry point, because this
	 * function, `ReactiveAgent` and `SupervisorAgent` each rebuilt the object
	 * from a fixed list. So the capability existed and the front door could not
	 * open it.
	 *
	 * A live turn is what found it: the unit tests passed because they drove the
	 * kernel directly, and a real agent run through this function put no effort
	 * on the wire at all.
	 */
	thinking?: ThinkingConfig
	effort?: ReasoningEffort

	/** Names the agent in traces and events. Defaults to `Agent`. */
	name?: string

	signal?: AbortSignal
	listener?: SessionEventListener
	/** Live project policy for hosts that discover nested instruction scopes. */
	projectInstructionContext?: ProjectInstructionContext
}

export interface RunAgentResult {
	/** The model's final text, or `undefined` if it produced none. */
	readonly output: string | undefined

	/**
	 * The schema-validated answer, when {@link RunAgentOptions.structuredOutput}
	 * asked for one and the model produced it.
	 *
	 * Mirrors `turn.structuredOutput` the way {@link output} mirrors
	 * `turn.result` — the whole point of this shape is that the two answers a
	 * turn can give are reachable without unpacking the turn.
	 */
	readonly structuredOutput?: unknown

	/** The full turn — usage, cost, steps, stop reason, every message. */
	readonly turn: Turn

	/**
	 * The identity this turn used, with anything generated filled in.
	 *
	 * Pass it straight back into the next call to continue the same session.
	 */
	readonly identity: Required<AgentIdentity>
}

/**
 * Defaults chosen to be safe rather than generous.
 *
 * A front door exists so a first turn works without a decision, and the cost of
 * that convenience is that nobody reads these numbers before their first
 * runaway loop. So: a budget that ends a stuck turn in seconds rather than
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
 * is the correct shape for a kernel — a turn with no tenant is a turn no auditor
 * can attribute — and it is the wrong shape for the first thing anybody
 * writes. The proof was in this repo: the eval suites, the test files and the
 * CLI each hand-assemble the same block, which is what a missing front door
 * looks like from the inside.
 *
 * So this supplies an environment rather than a new engine. It generates the
 * identity a single-tenant local turn has no opinion about, defaults the
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
 *   prompt: [...first.turn.messages, createUserMessage('What is my name?')],
 * })
 * ```
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
	const workingDirectory = options.workingDirectory ?? process.cwd()
	const layout = await resolveLayout(options, workingDirectory)
	const identity: Required<AgentIdentity> = {
		sessionId: options.sessionId ?? generateSessionId(),
		topicId: options.topicId ?? generateTopicId(),
		// The working directory's project, not a minted one: a minted Project
		// put every call in a Project of its own.
		projectId: options.projectId ?? layout.projectId,
		tenantId: options.tenantId ?? generateTenantId(),
	}

	const messages: Message[] =
		typeof options.prompt === 'string'
			? [
					{
						role: 'user',
						content: options.prompt,
						timestamp: Date.now(),
					} as Message,
				]
			: options.prompt

	const turn = await drainQuery(
		{
			provider: options.provider,
			...(layout.paths ? { paths: layout.paths } : {}),
			...(options.sessionLog ? { sessionLog: options.sessionLog } : {}),
			...(options.checkpointStore ? { checkpointStore: options.checkpointStore } : {}),
			tools: options.tools ?? new ToolRegistry(),
			...(options.toolResultGuardrails !== undefined
				? { toolResultGuardrails: options.toolResultGuardrails }
				: {}),
			...(options.attachmentStore ? { attachmentStore: options.attachmentStore } : {}),
			...(options.attachmentResolveTimeoutMs !== undefined
				? { attachmentResolveTimeoutMs: options.attachmentResolveTimeoutMs }
				: {}),
			...(options.sandboxProvider ? { sandboxProvider: options.sandboxProvider } : {}),
			...(options.sandboxTeardownTimeoutMs !== undefined
				? { sandboxTeardownTimeoutMs: options.sandboxTeardownTimeoutMs }
				: {}),
			messages,
			workingDirectory,
			turnConfig: {
				model: options.model,
				...(options.sandbox ? { sandbox: options.sandbox } : {}),
				maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
				tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				...(options.streamIdleTimeoutMs !== undefined
					? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
					: {}),
				...(options.maxRequestRichContentBytes !== undefined
					? { maxRequestRichContentBytes: options.maxRequestRichContentBytes }
					: {}),
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
			...(options.authorizationGate ? { authorizationGate: options.authorizationGate } : {}),
			...(options.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
			...(options.projectInstructionContext
				? { projectInstructionContext: options.projectInstructionContext }
				: {}),
			...identity,
		},
		options.listener,
	)

	return {
		output: turn.result,
		structuredOutput: turn.structuredOutput,
		turn,
		identity,
	}
}

/**
 * Where the turn is written and which project it belongs to.
 *
 * - A session held in memory with no `paths`: nothing on disk, and a fresh
 *   project id unless the caller named one.
 * - Otherwise the project the working directory stands for, found or minted
 *   once by `ensureProject` under the given `paths.home` (or `NAMZU_HOME`),
 *   so every turn in one directory shares a Project and its log sits beside
 *   that project's `project.json`.
 *
 * A caller that passes both `paths` and a `projectId` chose both, and nothing
 * is read. One that passes `paths` alone must name the working directory's
 * slug: a layout pointing at a different project than the directory is
 * refused rather than filing the turn under a project it does not belong to.
 */
async function resolveLayout(
	options: Pick<RunAgentOptions, 'paths' | 'sessionLog' | 'projectId'>,
	workingDirectory: string,
): Promise<{ readonly paths?: SessionPaths; readonly projectId: ProjectId }> {
	if (options.sessionLog instanceof InMemorySessionLog && options.paths === undefined) {
		return { projectId: options.projectId ?? generateProjectId() }
	}
	if (options.paths && options.projectId) {
		return { paths: options.paths, projectId: options.projectId }
	}
	const home = options.paths?.home ?? resolveNamzuHome()
	const project = await ensureProject({ home, cwd: workingDirectory })
	if (options.paths && options.paths.slug !== project.slug) {
		throw new Error(
			`runAgent: paths name project "${options.paths.slug}", but ${project.cwd} is project "${project.slug}". Pass projectId to file the turn under paths of your own.`,
		)
	}
	return {
		paths: options.paths ?? new SessionPaths({ home, slug: project.slug }),
		projectId: project.projectId,
	}
}
