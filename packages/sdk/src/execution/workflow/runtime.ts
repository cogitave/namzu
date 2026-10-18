import { randomBytes } from 'node:crypto'
import { cpus } from 'node:os'

import { encodeCodeValue } from '../code-runtime/json-value.js'
import type { CodeFrame, CodeRuntime, HostCallResult } from '../code-runtime/types.js'
import { WorkerCodeRuntime } from '../code-runtime/worker.js'
import { WorkflowScriptError } from './errors.js'
import { preview, sha256 } from './journal.js'
import { splitWorkflowScript } from './meta.js'
import { type PhaseAgentView, PhaseRegistry, summarizeWorkflowPhases } from './phases.js'
import { buildPrelude, preludeLineCount } from './prelude.js'
import { parseJsonText, validateAgainstSchema } from './schema.js'
import type {
	WorkflowAgentEvent,
	WorkflowAgentOutcome,
	WorkflowAgentProgress,
	WorkflowAgentState,
	WorkflowEvent,
	WorkflowFinishStatus,
	WorkflowJournalRecord,
	WorkflowLimits,
	WorkflowResolvedLimits,
	WorkflowRunOptions,
	WorkflowRunResult,
	WorkflowUsage,
} from './types.js'

/** The one capability a script has. */
export const WORKFLOW_HOST_CALL = 'agent'

const MAX_ARGS_BYTES = 64 * 1024
const MAX_PROMPT_BYTES = 200 * 1024
const MAX_SCHEMA_BYTES = 32 * 1024
/** Printed lines (`log()` and `phase()` records) the interpreter may emit. */
const MAX_LOG_OUTPUT_BYTES = 256 * 1024
/** Headroom for the prelude and the serialized `args` on top of the script. */
const SOURCE_OVERHEAD_BYTES = 16 * 1024 + MAX_ARGS_BYTES
const AGENT_CALL_KEYS = new Set([
	'prompt',
	'cursor',
	'label',
	'phase',
	'schema',
	'agentType',
	'model',
	'effort',
])

function integer(name: string, value: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${name} must be an integer between ${min} and ${max}.`)
	}
	return value
}

export function resolveWorkflowLimits(limits: WorkflowLimits = {}): WorkflowResolvedLimits {
	const defaultConcurrency = Math.min(8, Math.max(1, cpus().length - 2))
	return {
		maxConcurrency: integer('maxConcurrency', limits.maxConcurrency ?? defaultConcurrency, 1, 16),
		maxAgents: integer('maxAgents', limits.maxAgents ?? 200, 1, 1000),
		maxSourceBytes: integer(
			'maxSourceBytes',
			limits.maxSourceBytes ?? 256 * 1024,
			1,
			4 * 1024 * 1024,
		),
		memoryLimitBytes: integer(
			'memoryLimitBytes',
			limits.memoryLimitBytes ?? 64 * 1024 * 1024,
			16 * 1024 * 1024,
			256 * 1024 * 1024,
		),
		maxValueBytes: integer(
			'maxValueBytes',
			limits.maxValueBytes ?? 1024 * 1024,
			1,
			16 * 1024 * 1024,
		),
		...(limits.tokenBudget !== undefined
			? { tokenBudget: integer('tokenBudget', limits.tokenBudget, 1, Number.MAX_SAFE_INTEGER) }
			: {}),
		maxDurationMs: integer(
			'maxDurationMs',
			limits.maxDurationMs ?? 6 * 3_600_000,
			1,
			2_147_483_647,
		),
		cpuSliceMs: integer('cpuSliceMs', limits.cpuSliceMs ?? 2_000, 1, 2_147_483_647),
		cpuTotalMs: integer('cpuTotalMs', limits.cpuTotalMs ?? 60_000, 1, 2_147_483_647),
	}
}

interface AgentCall {
	readonly prompt: string
	readonly cursor: string | null
	readonly label?: string
	readonly phase?: string
	readonly schema?: Record<string, unknown>
	readonly agentType?: string
	readonly model?: string
	readonly effort?: string
}

function boundedText(value: unknown, field: string, max: number): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value.length > max) {
		throw new Error(`agent(): ${field} must be a string of at most ${max} characters.`)
	}
	return value
}

/** The host owns this check: the prelude is convenience, not enforcement. */
function parseAgentCall(input: unknown): AgentCall {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error('agent(): the request must be an object.')
	}
	const record = input as Record<string, unknown>
	for (const key of Object.keys(record)) {
		if (!AGENT_CALL_KEYS.has(key)) throw new Error(`agent(): unknown option "${key}".`)
	}
	const prompt = record.prompt
	if (typeof prompt !== 'string' || prompt.length === 0) {
		throw new Error('agent(): a prompt string is required.')
	}
	if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
		throw new Error(`agent(): the prompt is larger than ${MAX_PROMPT_BYTES} bytes.`)
	}
	const cursor = record.cursor === null || record.cursor === undefined ? null : record.cursor
	if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 120)) {
		throw new Error('agent(): cursor must be a short string.')
	}
	let schema: Record<string, unknown> | undefined
	if (record.schema !== undefined) {
		if (
			typeof record.schema !== 'object' ||
			record.schema === null ||
			Array.isArray(record.schema)
		) {
			throw new Error('agent(): schema must be a JSON Schema object.')
		}
		let size: number
		try {
			size = JSON.stringify(record.schema).length
		} catch {
			throw new Error('agent(): schema must be plain JSON.')
		}
		if (size > MAX_SCHEMA_BYTES) {
			throw new Error(`agent(): schema is larger than ${MAX_SCHEMA_BYTES} bytes.`)
		}
		schema = record.schema as Record<string, unknown>
	}
	const label = boundedText(record.label, 'label', 120)
	const phase = boundedText(record.phase, 'phase', 120)
	const agentType = boundedText(record.agentType, 'agentType', 120)
	const model = boundedText(record.model, 'model', 120)
	const effort = boundedText(record.effort, 'effort', 32)
	return {
		prompt,
		cursor,
		...(label !== undefined ? { label } : {}),
		...(phase !== undefined ? { phase } : {}),
		...(schema !== undefined ? { schema } : {}),
		...(agentType !== undefined ? { agentType } : {}),
		...(model !== undefined ? { model } : {}),
		...(effort !== undefined ? { effort } : {}),
	}
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

interface AgentRecord {
	readonly index: number
	readonly label: string
	readonly prompt: string
	readonly phaseIndex?: number
	readonly phaseTitle?: string
	readonly agentType?: string
	readonly model?: string
	readonly queuedAt: number
	readonly controller: AbortController
	state: WorkflowAgentState
	startedAt?: number
	finishedAt?: number
	lastProgressAt: number
	tokens: number
	toolCalls: number
	lastToolName?: string
	lastToolSummary?: string
	resultPreview?: string
	error?: string
	skipped: boolean
	userSkipped: boolean
}

interface Waiter {
	readonly agent: AgentRecord
	readonly admit: (admitted: boolean) => void
}

export interface WorkflowRuntimeOptions {
	/** Test seam. Default: a fresh {@link WorkerCodeRuntime} per run, sized from the limits. */
	readonly codeRuntime?: CodeRuntime
	/** Clock, in epoch milliseconds. */
	readonly now?: () => number
	/** How long to wait for aborted agents to settle before reporting the run finished. Default 5000. */
	readonly settleGraceMs?: number
}

const MAX_SOURCE_LINE_CHARS = 200

/**
 * The failure text a model reads: the error, then where in ITS script it
 * happened and the line itself. Interpreter lines count the prelude and the
 * worker's wrapper, so the first frame that falls in the author's text is the
 * one reported (the innermost frame may be a prelude helper that rejected a
 * bad argument; the call site is the next one out).
 */
function describeScriptFailure(
	outcome: {
		readonly error: string
		readonly errorName?: string
		readonly frames?: readonly CodeFrame[]
	},
	body: string,
	preludeLines: number,
): string {
	const what =
		outcome.errorName !== undefined && outcome.errorName !== ''
			? `${outcome.errorName}: ${outcome.error}`
			: outcome.error
	const frame = outcome.frames
		?.map((f) => ({ line: f.line - preludeLines, column: f.column }))
		.find((f) => f.line >= 1)
	if (frame === undefined) {
		return `${what} — the interpreter gave no line number for this error.`
	}
	const text = (body.split('\n')[frame.line - 1] ?? '').trim().slice(0, MAX_SOURCE_LINE_CHARS)
	return `${what} — line ${frame.line}, column ${frame.column}: ${text}`
}

/**
 * Runs a workflow script: a program the MODEL wrote once that decides how
 * many subagents run and in which order.
 *
 * The script is untrusted input. It runs in the `run_code` interpreter (a
 * fresh QuickJS WASM context in a worker thread: no filesystem, network,
 * process, modules or timers, JSON-only crossings, memory and CPU limits) and
 * its single capability is `agent()`, which asks the host's `spawnAgent` to
 * start a subagent through the same delegation path as the `Agent` tool.
 * Scheduling, caps, the token budget, events and the journal are host-side.
 */
export class WorkflowRuntime {
	private readonly now: () => number

	constructor(private readonly options: WorkflowRuntimeOptions = {}) {
		this.now = options.now ?? Date.now
	}

	async run(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
		const limits = resolveWorkflowLimits(options.limits)
		if (Buffer.byteLength(options.script) > limits.maxSourceBytes) {
			throw new WorkflowScriptError(`The script is larger than ${limits.maxSourceBytes} bytes.`)
		}
		const { meta, body } = splitWorkflowScript(options.script)
		const args = options.args === undefined ? {} : options.args
		try {
			encodeCodeValue(args, MAX_ARGS_BYTES)
		} catch (error) {
			throw new WorkflowScriptError(
				`The workflow arguments cannot be used: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		const now = this.now
		const runId =
			options.runId ?? `w${[...randomBytes(8)].map((b) => (b % 36).toString(36)).join('')}`
		const startedAt = now()
		const phases = new PhaseRegistry()
		const agents = new Map<number, AgentRecord>()
		const inFlight = new Set<Promise<unknown>>()
		const waiters: Waiter[] = []
		const controller = new AbortController()
		let running = 0
		let requested = 0
		let fatal: string | undefined
		let closed = false
		let journalError: string | undefined
		let scriptPhase: string | undefined
		let journalChain: Promise<void> = Promise.resolve()

		const journal = (record: WorkflowJournalRecord): void => {
			const sink = options.journal
			if (!sink || closed) return
			journalChain = journalChain
				.then(() => sink.append(record))
				.catch((error: unknown) => {
					journalError ??= error instanceof Error ? error.message : String(error)
				})
		}
		const emit = (event: WorkflowEvent): void => {
			if (closed) return
			try {
				options.onEvent?.(event)
			} catch {
				// A listener bug must not decide the run's outcome.
			}
		}
		const setFatal = (reason: string): void => {
			if (fatal !== undefined) return
			fatal = reason
			controller.abort(new Error(reason))
		}
		const totalTokens = (): number => {
			let sum = 0
			for (const a of agents.values()) sum += a.tokens
			return sum
		}
		const announce = (rawTitle: string, declared: boolean): { index: number; title: string } => {
			const { phase, isNew } = phases.register(rawTitle, declared)
			if (isNew) {
				const at = now()
				emit({
					type: 'workflow_phase',
					runId,
					index: phase.index,
					title: phase.title,
					declared,
					at,
				})
				journal({ type: 'phase', at, index: phase.index, title: phase.title, declared })
			}
			return phase
		}
		const agentEvent = (agent: AgentRecord): WorkflowAgentEvent => ({
			type: 'workflow_agent',
			runId,
			state: agent.state,
			index: agent.index,
			label: agent.label,
			...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
			...(agent.phaseTitle !== undefined ? { phaseTitle: agent.phaseTitle } : {}),
			...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
			...(agent.model !== undefined ? { model: agent.model } : {}),
			queuedAt: agent.queuedAt,
			...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
			...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
			lastProgressAt: agent.lastProgressAt,
			tokens: agent.tokens,
			toolCalls: agent.toolCalls,
			...(agent.lastToolName !== undefined ? { lastToolName: agent.lastToolName } : {}),
			...(agent.lastToolSummary !== undefined ? { lastToolSummary: agent.lastToolSummary } : {}),
			promptPreview: preview(agent.prompt, 200),
			...(agent.resultPreview !== undefined ? { resultPreview: agent.resultPreview } : {}),
			...(agent.error !== undefined ? { error: agent.error } : {}),
			...(agent.skipped ? { skipped: true } : {}),
		})

		// FIFO admission: an agent starts when fewer than maxConcurrency run.
		const acquire = (agent: AgentRecord): Promise<boolean> => {
			if (running < limits.maxConcurrency && waiters.length === 0) {
				running++
				return Promise.resolve(true)
			}
			return new Promise<boolean>((admit) => {
				waiters.push({ agent, admit })
			})
		}
		const release = (): void => {
			running--
			while (running < limits.maxConcurrency && waiters.length > 0) {
				const next = waiters.shift() as Waiter
				running++
				next.admit(true)
			}
		}
		const cancelQueued = (agent: AgentRecord): boolean => {
			const at = waiters.findIndex((w) => w.agent === agent)
			if (at === -1) return false
			const [waiter] = waiters.splice(at, 1)
			waiter?.admit(false)
			return true
		}
		const abortAgents = (): void => {
			for (const waiter of waiters.splice(0)) waiter.admit(false)
			for (const agent of agents.values()) {
				if (agent.finishedAt === undefined) agent.controller.abort(controller.signal.reason)
			}
		}
		controller.signal.addEventListener('abort', abortAgents, { once: true })
		const onUserAbort = (): void => controller.abort(options.signal?.reason)
		if (options.signal?.aborted) onUserAbort()
		else options.signal?.addEventListener('abort', onUserAbort, { once: true })

		options.onControl?.({
			skipAgent: (index) => {
				const agent = agents.get(index)
				if (!agent || agent.finishedAt !== undefined) return false
				agent.userSkipped = true
				if (!cancelQueued(agent)) agent.controller.abort(new Error('The agent was skipped.'))
				return true
			},
		})

		const settle = (
			agent: AgentRecord,
			outcome: { state: 'done' | 'error'; skipped?: boolean; value?: unknown; error?: string },
		): HostCallResult => {
			const at = now()
			agent.state = outcome.state
			agent.finishedAt = at
			agent.lastProgressAt = at
			agent.skipped = outcome.skipped === true
			if (outcome.error !== undefined) agent.error = outcome.error
			let value: unknown =
				outcome.state === 'done' && !outcome.skipped ? (outcome.value ?? null) : null
			if (value !== null) {
				agent.resultPreview = preview(typeof value === 'string' ? value : JSON.stringify(value))
			}
			try {
				encodeCodeValue({ v: value, t: totalTokens() }, limits.maxValueBytes)
			} catch {
				agent.state = 'error'
				agent.error = `Its result is larger than ${limits.maxValueBytes} bytes and could not be given to the script.`
				agent.resultPreview = undefined
				agent.skipped = false
				value = null
			}
			emit(agentEvent(agent))
			journal({
				type: 'agent_outcome',
				at,
				index: agent.index,
				state: agent.state === 'error' ? 'error' : agent.skipped ? 'skipped' : 'done',
				tokens: agent.tokens,
				toolCalls: agent.toolCalls,
				queuedAt: agent.queuedAt,
				...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
				finishedAt: at,
				...(agent.resultPreview !== undefined ? { resultPreview: agent.resultPreview } : {}),
				...(agent.error !== undefined ? { error: agent.error } : {}),
			})
			return { ok: true, value: { v: value, t: totalTokens() } }
		}

		const interpret = (
			agent: AgentRecord,
			call: AgentCall,
			outcome: WorkflowAgentOutcome,
		): HostCallResult => {
			agent.tokens = count(outcome.tokens)
			agent.toolCalls = count(outcome.toolCalls)
			if (agent.userSkipped || outcome.state === 'skipped') {
				return settle(agent, { state: 'done', skipped: true })
			}
			if (controller.signal.aborted) {
				return settle(agent, {
					state: 'error',
					error: 'The workflow was stopped before this agent finished.',
				})
			}
			if (outcome.state === 'error') {
				return settle(agent, { state: 'error', error: outcome.error ?? 'The agent failed.' })
			}
			if (call.schema === undefined) {
				return settle(agent, { state: 'done', value: outcome.text ?? '' })
			}
			let candidate: unknown = outcome.data
			if (candidate === undefined) {
				const parsed = parseJsonText(outcome.text ?? '')
				if (!parsed.ok) {
					return settle(agent, {
						state: 'error',
						error: 'The agent was asked for structured output but its answer was not valid JSON.',
					})
				}
				candidate = parsed.value
			}
			const problem = validateAgainstSchema(candidate, call.schema)
			if (problem) {
				return settle(agent, {
					state: 'error',
					error: `The agent's answer did not match the schema: ${problem}.`,
				})
			}
			return settle(agent, { state: 'done', value: candidate })
		}

		const handleAgentCall = async (call: AgentCall): Promise<HostCallResult> => {
			if (controller.signal.aborted) {
				return { ok: false, error: fatal ?? 'The workflow was stopped.' }
			}
			if (requested >= limits.maxAgents) {
				const reason = `This workflow tried to start more than ${limits.maxAgents} agents, which is the limit for one run. No agent past the limit was started.`
				setFatal(reason)
				return { ok: false, error: reason }
			}
			const index = ++requested
			const phaseTitle = call.phase ?? call.cursor
			const phase = phaseTitle?.trim() ? announce(phaseTitle, false) : undefined
			const queuedAt = now()
			const agent: AgentRecord = {
				index,
				label: call.label || `Agent ${index}`,
				prompt: call.prompt,
				...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
				...(call.agentType !== undefined ? { agentType: call.agentType } : {}),
				...(call.model !== undefined ? { model: call.model } : {}),
				queuedAt,
				controller: new AbortController(),
				state: 'start',
				lastProgressAt: queuedAt,
				tokens: 0,
				toolCalls: 0,
				skipped: false,
				userSkipped: false,
			}
			agents.set(index, agent)
			emit(agentEvent(agent))
			journal({
				type: 'agent_request',
				at: queuedAt,
				index,
				label: agent.label,
				...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
				promptPreview: preview(call.prompt),
				promptSha256: sha256(call.prompt),
				options: {
					...(call.agentType !== undefined ? { agentType: call.agentType } : {}),
					...(call.model !== undefined ? { model: call.model } : {}),
					...(call.effort !== undefined ? { effort: call.effort } : {}),
					schema: call.schema !== undefined,
				},
			})

			const admitted = await acquire(agent)
			if (!admitted) {
				return agent.userSkipped
					? settle(agent, { state: 'done', skipped: true })
					: settle(agent, {
							state: 'error',
							error: 'The workflow was stopped before this agent started.',
						})
			}
			try {
				if (limits.tokenBudget !== undefined && totalTokens() >= limits.tokenBudget) {
					return settle(agent, {
						state: 'error',
						error: `Not started: the token budget for this workflow (${limits.tokenBudget} tokens) is spent.`,
					})
				}
				if (controller.signal.aborted || agent.userSkipped) {
					return agent.userSkipped
						? settle(agent, { state: 'done', skipped: true })
						: settle(agent, {
								state: 'error',
								error: 'The workflow was stopped before this agent started.',
							})
				}
				agent.startedAt = now()
				agent.lastProgressAt = agent.startedAt
				emit(agentEvent(agent))
				let outcome: WorkflowAgentOutcome
				try {
					outcome = await options.spawnAgent(
						{
							index,
							label: agent.label,
							prompt: call.prompt,
							...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
							...(call.schema !== undefined ? { schema: call.schema } : {}),
							...(call.agentType !== undefined ? { agentType: call.agentType } : {}),
							...(call.model !== undefined ? { model: call.model } : {}),
							...(call.effort !== undefined ? { effort: call.effort } : {}),
							onProgress: (progress: WorkflowAgentProgress) => {
								if (agent.finishedAt !== undefined || closed) return
								if (progress.tokens !== undefined) agent.tokens = count(progress.tokens)
								if (progress.toolCalls !== undefined) agent.toolCalls = count(progress.toolCalls)
								if (progress.lastToolName !== undefined) agent.lastToolName = progress.lastToolName
								if (progress.lastToolSummary !== undefined) {
									agent.lastToolSummary = preview(progress.lastToolSummary, 200)
								}
								agent.state = 'progress'
								agent.lastProgressAt = now()
								emit(agentEvent(agent))
							},
						},
						agent.controller.signal,
					)
				} catch (error) {
					outcome = {
						state: 'error',
						tokens: agent.tokens,
						toolCalls: agent.toolCalls,
						error: error instanceof Error ? error.message : String(error),
					}
				}
				return interpret(agent, call, outcome)
			} finally {
				release()
			}
		}

		const onOutput = (line: string): void => {
			let record: unknown
			try {
				record = JSON.parse(line)
			} catch {
				return
			}
			if (typeof record !== 'object' || record === null) return
			const { k, title, message } = record as Record<string, unknown>
			if (k === 'phase' && typeof title === 'string' && title.trim()) {
				announce(title, false)
				scriptPhase = title.trim()
			} else if (k === 'log' && typeof message === 'string') {
				const at = now()
				emit({ type: 'workflow_log', runId, message, at })
				journal({ type: 'log', at, message })
			}
		}

		// --- start ---
		if (options.journal?.writeScript) {
			try {
				await options.journal.writeScript(options.script, sha256(options.script))
			} catch (error) {
				journalError = error instanceof Error ? error.message : String(error)
			}
		}
		journal({
			type: 'run_started',
			at: startedAt,
			runId,
			scriptSha256: sha256(options.script),
			scriptBytes: Buffer.byteLength(options.script),
			meta,
			args,
			limits,
		})
		emit({
			type: 'workflow_started',
			runId,
			name: meta.name,
			description: meta.description,
			phases: meta.phases,
			at: startedAt,
		})
		for (const declared of meta.phases) announce(declared.title, true)

		const codeRuntime =
			this.options.codeRuntime ??
			new WorkerCodeRuntime({
				memoryLimitBytes: limits.memoryLimitBytes,
				maxSourceBytes: limits.maxSourceBytes + SOURCE_OVERHEAD_BYTES,
				maxValueBytes: limits.maxValueBytes,
				maxHostCalls: limits.maxAgents + 100,
				maxPendingHostCalls: limits.maxAgents + 100,
			})

		const preludeConfig = { args, tokenLimit: limits.tokenBudget ?? null }
		const runResult = await codeRuntime.run({
			source: `${buildPrelude(preludeConfig)}\n${body}`,
			allowedCalls: [WORKFLOW_HOST_CALL],
			timeoutMs: limits.maxDurationMs,
			maxOutputBytes: MAX_LOG_OUTPUT_BYTES,
			cpuLimits: { sliceMs: limits.cpuSliceMs, totalMs: limits.cpuTotalMs },
			signal: controller.signal,
			onOutput,
			onHostCall: (request) => {
				if (request.name !== WORKFLOW_HOST_CALL) {
					return Promise.resolve({ ok: false, error: `Unknown host call "${request.name}".` })
				}
				let call: AgentCall
				try {
					call = parseAgentCall(request.input)
				} catch (error) {
					return Promise.resolve({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					})
				}
				const pending = handleAgentCall(call).catch(
					(error: unknown): HostCallResult => ({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
				)
				inFlight.add(pending)
				void pending.finally(() => inFlight.delete(pending))
				return pending
			},
		})

		// --- finish ---
		const userStopped = options.signal?.aborted === true && fatal === undefined
		if (!controller.signal.aborted) controller.abort(new Error('The workflow finished.'))
		options.signal?.removeEventListener('abort', onUserAbort)
		if (inFlight.size > 0) {
			const grace = this.options.settleGraceMs ?? 5_000
			let timer: ReturnType<typeof setTimeout> | undefined
			await Promise.race([
				Promise.allSettled([...inFlight]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, grace)
				}),
			])
			clearTimeout(timer)
		}

		let status: WorkflowFinishStatus
		let result: unknown
		let error: string | undefined
		const outcome = runResult.outcome
		if (fatal !== undefined) {
			status = 'failed'
			error = fatal
		} else if (outcome.status === 'completed') {
			status = 'completed'
			result = outcome.result
		} else if (outcome.status === 'cancelled' || userStopped) {
			status = 'stopped'
		} else if (outcome.status === 'timed-out') {
			status = 'failed'
			error = `The script was stopped. It spent more than ${limits.cpuSliceMs} ms in one synchronous stretch, more than ${limits.cpuTotalMs} ms in all, or ran past the ${limits.maxDurationMs} ms limit for one run.`
		} else {
			status = 'failed'
			const begun = [...agents.values()].filter((a) => a.startedAt !== undefined)
			const finished = begun.filter((a) => a.state === 'done' && !a.skipped).length
			const failedAgents = begun.filter((a) => a.state === 'error').length
			const progress =
				begun.length === 0
					? 'No agent had started.'
					: `Before it failed: ${begun.length} agent${begun.length === 1 ? '' : 's'} started, ${finished} finished, ${failedAgents} failed. A rerun starts the whole script again, so finished agents run again.`
			error = `${describeScriptFailure(outcome, body, preludeLineCount(preludeConfig))}\n${progress}${scriptPhase !== undefined ? ` Last phase: "${scriptPhase}".` : ''}`
		}

		const all = [...agents.values()]
		const usage: WorkflowUsage = {
			agents: all.length,
			agentsDone: all.filter((a) => a.state === 'done' && !a.skipped).length,
			agentsFailed: all.filter((a) => a.state === 'error').length,
			agentsSkipped: all.filter((a) => a.skipped).length,
			tokens: all.reduce((sum, a) => sum + a.tokens, 0),
			toolCalls: all.reduce((sum, a) => sum + a.toolCalls, 0),
			elapsedMs: Math.max(0, now() - startedAt),
		}
		const at = now()
		emit({
			type: 'workflow_finished',
			runId,
			status,
			...(status === 'completed' && result !== undefined ? { result } : {}),
			...(error !== undefined ? { error } : {}),
			usage,
			at,
		})
		journal({
			type: 'run_finished',
			at,
			status,
			...(status === 'completed' && result !== undefined ? { result } : {}),
			...(error !== undefined ? { error } : {}),
			usage,
		})
		await journalChain
		closed = true

		const views: PhaseAgentView[] = all.map((a) => ({
			...(a.phaseIndex !== undefined ? { phaseIndex: a.phaseIndex } : {}),
			state: a.state,
			tokens: a.tokens,
		}))
		return {
			runId,
			status,
			...(status === 'completed' && result !== undefined ? { result } : {}),
			...(error !== undefined ? { error } : {}),
			usage,
			phases: summarizeWorkflowPhases(meta.phases, phases.all(), views),
			logsTruncated: runResult.outputTruncated,
			...(journalError !== undefined ? { journalError } : {}),
		}
	}
}
