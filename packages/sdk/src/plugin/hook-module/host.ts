import { Worker } from 'node:worker_threads'

import type {
	PluginHookContext,
	PluginHookDefinition,
	PluginHookResult,
} from '../../types/plugin/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import {
	type ShellHookCall,
	type ShellHookEvent,
	type ShellHookOptions,
	shellHookInputFor,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'
import { type CapabilityBridge, createCapabilityBridge } from './capabilities.js'
import {
	MODULE_HOOK_EVENTS,
	classicEventName,
	classicWrittenName,
	resolvePattern,
} from './events.js'
import { type HookModuleScan, SUPPORTED_CAPABILITY_CALLS, scanHookModule } from './scan.js'
import { HOOK_WORKER_SOURCE } from './worker-source.js'

/** What a hook has to answer in, as the module is told by `next.budget`. */
export const HOOK_MODULE_BUDGET_MS = 10_000
/** How long a `.catch` has to answer once its hook overran. */
export const HOOK_MODULE_CATCH_MS = 1_000

/** The worker as the host sees it, so a test can stand in for it. */
export interface HookModuleTransport {
	post(message: unknown): void
	onMessage(listener: (message: any) => void): void
	/** Called once when the worker is gone, with why. */
	onExit(listener: (reason: string) => void): void
	terminate(): Promise<void>
}

export type HookModuleTransportFactory = () => HookModuleTransport

/** The clock the budgets run on. A test drives its own. */
export interface HookModuleClock {
	now(): number
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const realClock: HookModuleClock = {
	now: () => performance.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A worker thread running {@link HOOK_WORKER_SOURCE}. It never keeps the process alive. */
export const workerTransport: HookModuleTransportFactory = () => {
	const worker = new Worker(HOOK_WORKER_SOURCE, {
		eval: true,
		env: {},
		stdout: true,
		stderr: true,
		resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
	})
	worker.unref()
	let exited = false
	return {
		post: (message) => worker.postMessage(message),
		onMessage: (listener) => {
			worker.on('message', listener)
		},
		onExit: (listener) => {
			const once = (reason: string): void => {
				if (exited) return
				exited = true
				listener(reason)
			}
			worker.on('error', (error) => once(toErrorMessage(error)))
			worker.on('exit', (code) => once(`it exited with code ${code}`))
		},
		terminate: async () => {
			await worker.terminate()
		},
	}
}

export interface StartHookModuleOptions {
	readonly plugin: {
		readonly name: string
		/** The plugin's folder. */
		readonly root: string
		/** The folder kept for the plugin's data (`NAMZU_PLUGIN_DATA`). */
		readonly dataDir?: string
	}
	/** The module, relative to the plugin. */
	readonly entry: string
	readonly projectDir: string
	/** How an event becomes the input a hook reads; the same options a command hook gets. */
	readonly shell: ShellHookOptions
	readonly log: Logger
	/** The scan, when the caller has just made one. Read again otherwise. */
	readonly scan?: HookModuleScan
	/** The plugin's options. Empty until a plugin can ask for some. */
	readonly options?: Readonly<Record<string, unknown>>
	readonly budgetMs?: number
	readonly catchMs?: number
	readonly clock?: HookModuleClock
	readonly transport?: HookModuleTransportFactory
	readonly environment?: Readonly<Record<string, string | undefined>>
	readonly fetch?: typeof fetch
}

export interface HookModuleHandle {
	readonly scan: HookModuleScan
	readonly status: 'running' | 'unloaded'
	/** Why the module is not running, when it is not. */
	readonly message?: string
	/** The hooks to attach to the plugin manager. */
	readonly hooks: readonly PluginHookDefinition[]
	/** End the worker. Safe to call again. */
	dispose(): Promise<void>
}

interface Pending {
	readonly resolve: (outcome: DispatchOutcome) => void
	remaining: number
	startedAt: number
	timer: unknown
	phase: 'budget' | 'grace'
	paused: boolean
}

type DispatchOutcome =
	| { readonly kind: 'value'; readonly value: unknown; readonly failures: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The first refusal of a scan, as one line. */
function refusalLine(scan: HookModuleScan): string {
	const first = scan.refusals[0]
	if (first === undefined) return 'the module was refused'
	const more = scan.refusals.length > 1 ? ` (and ${scan.refusals.length - 1} more)` : ''
	return `${first.file}:${first.line}: ${first.message}${more}`
}

/**
 * What a module is shown for a tool call: the tool, the id of the call and the
 * tool's own arguments beside them. `tool` and `tool_use_id` are the engine's,
 * so no argument can stand over them.
 */
function toolEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
	const input = isRecord(payload.tool_input) ? payload.tool_input : {}
	return { ...input, tool: payload.tool_name, tool_use_id: payload.tool_use_id }
}

/**
 * The module's answer for a classic event as the JSON a command hook prints.
 * Both kinds of hook then go through the same reading, so the same answer has
 * the same effect whichever wrote it.
 */
function answerAsJson(
	event: ShellHookEvent,
	value: unknown,
): { readonly json: Record<string, unknown> } | { readonly problem: string } {
	if (!isRecord(value)) return { problem: 'its answer is not an object' }
	const top: Record<string, unknown> = {}
	const specific: Record<string, unknown> = {}
	const strings = (key: string): string[] | undefined | 'bad' => {
		const list = value[key]
		if (list === undefined) return undefined
		return Array.isArray(list) && list.every((item) => typeof item === 'string')
			? (list as string[])
			: 'bad'
	}
	const context = strings('additionalContext')
	if (context === 'bad') return { problem: '`additionalContext` is a list of strings' }
	if (context !== undefined && context.length > 0) specific.additionalContext = context.join('\n')

	if (event === 'pre_tool_use') {
		const { allow, ask, deny, updatedInput } = value
		if (allow !== undefined && allow !== true) return { problem: 'an allow that is not true' }
		if (ask !== undefined && typeof ask !== 'string')
			return { problem: 'an ask that is not a string' }
		if (deny !== undefined && typeof deny !== 'string')
			return { problem: 'a deny that is not a string' }
		const given = [allow, ask, deny].filter((item) => item !== undefined).length
		if (given > 1) return { problem: 'allow, ask and deny are one answer: only one is given' }
		if (allow === true) specific.permissionDecision = 'allow'
		if (typeof ask === 'string') {
			specific.permissionDecision = 'ask'
			specific.permissionDecisionReason = ask
		}
		if (typeof deny === 'string') {
			specific.permissionDecision = 'deny'
			specific.permissionDecisionReason = deny
		}
		if (updatedInput !== undefined) {
			if (!isRecord(updatedInput)) return { problem: '`updatedInput` is an object' }
			specific.updatedInput = updatedInput
		}
	} else {
		if (value.block !== undefined) {
			if (typeof value.block !== 'string') return { problem: '`block` is a string' }
			top.decision = 'block'
			top.reason = value.block
		}
		if (value.preventContinuation !== undefined) {
			if (value.preventContinuation !== true) return { problem: '`preventContinuation` is true' }
			top.continue = false
		}
		if (value.stopReason !== undefined) {
			if (typeof value.stopReason !== 'string') return { problem: '`stopReason` is a string' }
			top.stopReason = value.stopReason
		}
		const watch = strings('watchPaths')
		if (watch === 'bad') return { problem: '`watchPaths` is a list of strings' }
		if (watch !== undefined) specific.watchPaths = watch
		if (value.updatedToolOutput !== undefined) specific.updatedToolOutput = value.updatedToolOutput
		if (value.updatedMCPToolOutput !== undefined) {
			specific.updatedMCPToolOutput = value.updatedMCPToolOutput
		}
		if (value.decision !== undefined) {
			if (!isRecord(value.decision))
				return { problem: '`decision` is {behavior: "allow"} or {behavior: "deny"}' }
			specific.decision = value.decision
		}
		if (value.permissionDecision !== undefined) {
			if (!['allow', 'deny', 'ask'].includes(String(value.permissionDecision))) {
				return { problem: '`permissionDecision` is "allow", "deny" or "ask"' }
			}
			specific.permissionDecision = value.permissionDecision
			if (typeof value.permissionDecisionReason === 'string') {
				specific.permissionDecisionReason = value.permissionDecisionReason
			}
		}
	}
	if (Object.keys(specific).length > 0) {
		top.hookSpecificOutput = { hookEventName: classicWrittenName(event), ...specific }
	}
	return { json: top }
}

/**
 * Start the hooks module of one plugin: read it, and run it in a worker of its
 * own. The result lists the hooks to attach. A module that is refused, throws
 * where it loads or registers nothing that runs here is reported in `message`
 * and runs nothing; the plugin's other hooks are not touched.
 *
 * The worker is started when the first event it hooks arrives, not before, so a
 * plugin that is enabled and never reaches one of its events costs nothing.
 */
export async function startHookModule(options: StartHookModuleOptions): Promise<HookModuleHandle> {
	const { plugin, log } = options
	const clock = options.clock ?? realClock
	const budgetMs = options.budgetMs ?? HOOK_MODULE_BUDGET_MS
	const catchMs = options.catchMs ?? HOOK_MODULE_CATCH_MS
	const scan = options.scan ?? scanHookModule(plugin.root, options.entry)
	const label = `${plugin.name}/${options.entry}`
	const attrs = { 'namzu.plugin.name': plugin.name, 'namzu.hook_module.entry': options.entry }

	let status: 'running' | 'unloaded' = 'running'
	let message: string | undefined
	const unload = (why: string): void => {
		if (status === 'unloaded') return
		status = 'unloaded'
		message = why
		log.warn('Hooks module not loaded', { ...attrs, 'namzu.hook_module.reason': why })
	}
	const unloaded = (why: string): HookModuleHandle => {
		unload(why)
		return { scan, status, message: why, hooks: [], dispose: async () => undefined }
	}

	if (scan.refusals.length > 0 || scan.program === undefined) {
		return unloaded(`hooks module ${label} not loaded: ${refusalLine(scan)}`)
	}
	const program = scan.program
	const runnable = new Set<ShellHookEvent>()
	for (const hook of scan.hooks) for (const event of hook.runs) runnable.add(event)
	if (runnable.size === 0) {
		return unloaded(
			scan.hooks.length === 0
				? `hooks module ${label} registers no hook, so it is not loaded.`
				: `hooks module ${label} registers hooks that Namzu has no event for, so it is not loaded.`,
		)
	}

	const bridge: CapabilityBridge = createCapabilityBridge({
		root: plugin.root,
		...(plugin.dataDir !== undefined ? { dataDir: plugin.dataDir } : {}),
		projectDir: options.projectDir,
		envNames: scan.envNames,
		...(options.environment !== undefined ? { environment: options.environment } : {}),
		...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
		log,
		pluginName: plugin.name,
	})

	// --- the worker --------------------------------------------------------
	let transport: HookModuleTransport | undefined
	let ready: Promise<void> | undefined
	/** For each registration, in order: the Namzu events it runs on. */
	let registrationEvents: ReadonlySet<ShellHookEvent>[] = []
	const pending = new Map<number, Pending>()
	let nextId = 1
	let outstandingCalls = 0
	let loaded:
		| ((registrations: { pattern: string; hasMatcher: boolean }[] | string) => void)
		| undefined

	const settle = (id: number, outcome: DispatchOutcome): void => {
		const entry = pending.get(id)
		if (entry === undefined) return
		pending.delete(id)
		clock.clearTimeout(entry.timer)
		entry.resolve(outcome)
	}

	const armTimer = (id: number): void => {
		const entry = pending.get(id)
		if (entry === undefined) return
		entry.startedAt = clock.now()
		entry.paused = false
		entry.timer = clock.setTimeout(() => onTimer(id), entry.remaining)
	}
	const onTimer = (id: number): void => {
		const entry = pending.get(id)
		if (entry === undefined) return
		if (entry.phase === 'budget') {
			// The hook overran: tell it, and give its `.catch` the grace to answer.
			entry.phase = 'grace'
			entry.remaining = catchMs
			transport?.post({ t: 'overrun', id })
			armTimer(id)
			return
		}
		transport?.post({ t: 'grace-over', id })
		settle(id, { kind: 'failed', message: `exceeded ${budgetMs}ms budget` })
		// A worker that did not answer in the grace may be stuck in a loop: end it, and load afresh next time.
		void endWorker('the hooks worker was ended after a hook overran')
	}
	const pauseAll = (): void => {
		for (const entry of pending.values()) {
			if (entry.paused) continue
			entry.remaining = Math.max(0, entry.remaining - (clock.now() - entry.startedAt))
			clock.clearTimeout(entry.timer)
			entry.paused = true
		}
	}
	const resumeAll = (): void => {
		for (const id of pending.keys()) {
			const entry = pending.get(id)
			if (entry?.paused) armTimer(id)
		}
	}

	const endWorker = async (reason: string): Promise<void> => {
		const current = transport
		transport = undefined
		ready = undefined
		if (current === undefined) return
		for (const id of [...pending.keys()]) settle(id, { kind: 'failed', message: reason })
		outstandingCalls = 0
		try {
			await current.terminate()
		} catch {
			// A worker that is already gone cannot be ended again.
		}
	}

	const onMessage =
		(worker: HookModuleTransport) =>
		(incoming: any): void => {
			if (transport !== worker) return
			switch (incoming?.t) {
				case 'loaded':
					loaded?.(incoming.error !== undefined ? String(incoming.error) : incoming.registrations)
					return
				case 'result':
					settle(
						incoming.id,
						incoming.ok
							? { kind: 'value', value: incoming.value, failures: incoming.failures ?? [] }
							: { kind: 'failed', message: String(incoming.message) },
					)
					return
				case 'log':
					log.debug(
						`${plugin.name} console.${String(incoming.level)}: ${String(incoming.text)}`,
						attrs,
					)
					return
				case 'call': {
					outstandingCalls += 1
					if (outstandingCalls === 1) pauseAll()
					const reply = (body: Record<string, unknown>): void => {
						outstandingCalls = Math.max(0, outstandingCalls - 1)
						if (outstandingCalls === 0) resumeAll()
						if (transport === worker) worker.post({ t: 'call-result', cid: incoming.cid, ...body })
					}
					bridge
						.call(
							String(incoming.noun),
							String(incoming.method),
							Array.isArray(incoming.args) ? incoming.args : [],
						)
						.then(
							(value) => reply({ ok: true, value }),
							(error) => reply({ ok: false, message: toErrorMessage(error) }),
						)
					return
				}
			}
		}

	const start = (): Promise<void> => {
		if (ready !== undefined) return ready
		const worker = (options.transport ?? workerTransport)()
		transport = worker
		worker.onMessage(onMessage(worker))
		worker.onExit((reason) => {
			if (transport !== worker) return
			transport = undefined
			ready = undefined
			for (const id of [...pending.keys()]) {
				settle(id, { kind: 'failed', message: `the hooks worker died (${reason})` })
			}
			loaded?.(`the hooks worker died (${reason})`)
		})
		const attempt = new Promise<void>((resolve, reject) => {
			const timer = clock.setTimeout(() => {
				loaded = undefined
				reject(new Error(`it did not finish loading within ${budgetMs}ms`))
			}, budgetMs)
			loaded = (registrations) => {
				clock.clearTimeout(timer)
				loaded = undefined
				if (typeof registrations === 'string') {
					reject(new Error(registrations))
					return
				}
				// What the module registered is judged here, where the patterns are known.
				const events: ReadonlySet<ShellHookEvent>[] = []
				const seen = new Map<string, number>()
				for (const [index, registration] of registrations.entries()) {
					const resolved = resolvePattern(registration.pattern)
					if (!resolved.ok) {
						reject(new Error(resolved.message))
						return
					}
					if (!registration.hasMatcher) {
						const earlier = seen.get(registration.pattern)
						if (earlier !== undefined) {
							reject(
								new Error(
									`on("${registration.pattern}") is registered twice without a matcher; the first is registration ${earlier + 1}`,
								),
							)
							return
						}
						seen.set(registration.pattern, index)
					}
					events.push(new Set(resolved.runs))
				}
				if (registrations.length === 0) {
					reject(new Error('it registers nothing'))
					return
				}
				registrationEvents = events
				resolve()
			}
			worker.post({
				t: 'load',
				program,
				name: plugin.name,
				root: plugin.root,
				options: options.options ?? {},
				nouns: Object.fromEntries(
					Object.entries(SUPPORTED_CAPABILITY_CALLS).map(([noun, methods]) => [noun, [...methods]]),
				),
			})
		})
		ready = attempt.catch(async (error) => {
			await endWorker('the hooks worker was ended')
			throw error
		})
		return ready
	}

	const dispatch = async (
		name: string,
		e: unknown,
		registrations: readonly number[],
		signal: AbortSignal | undefined,
	): Promise<DispatchOutcome> => {
		try {
			await start()
		} catch (error) {
			const why = `hooks module ${label} failed to load: ${toErrorMessage(error)}`
			unload(why)
			return { kind: 'failed', message: why }
		}
		const worker = transport
		if (worker === undefined) return { kind: 'failed', message: 'the hooks worker is not running' }
		const id = nextId++
		return new Promise<DispatchOutcome>((resolve) => {
			const entry: Pending = {
				resolve,
				remaining: budgetMs,
				startedAt: clock.now(),
				timer: undefined,
				phase: 'budget',
				paused: outstandingCalls > 0,
			}
			pending.set(id, entry)
			if (!entry.paused) armTimer(id)
			signal?.addEventListener(
				'abort',
				() => {
					if (!pending.has(id)) return
					transport?.post({ t: 'abort', id })
					settle(id, { kind: 'failed', message: 'the turn was cancelled' })
				},
				{ once: true },
			)
			worker.post({ t: 'dispatch', id, name, e, regs: registrations })
		})
	}

	// --- the hooks ---------------------------------------------------------
	const commandLabel = `module ${label}`
	const failurePolicy = (event: ShellHookEvent, why: string): PluginHookResult => {
		log.warn('Hooks module hook failed', {
			...attrs,
			'namzu.hook.event': event,
			'namzu.hook_module.reason': why,
		})
		const line = `${commandLabel}: ${why}`
		// A guard that failed does not wave the call through: the call is refused and the model is told why.
		if (event === 'pre_tool_use') return { action: 'error', message: line }
		if (event === 'pre_skill_shell_command') return { action: 'skip', reason: line }
		return { action: 'continue', notice: line }
	}

	const hooks: PluginHookDefinition[] = []
	for (const event of MODULE_HOOK_EVENTS) {
		if (!runnable.has(event)) continue
		const eventName = classicEventName(event) as string
		hooks.push({
			event,
			handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
				if (status === 'unloaded') return { action: 'continue' }
				const input = shellHookInputFor(event, context, options.shell, { toolNames: 'written' })
				const payload = JSON.parse(shellHookPayload(input)) as Record<string, unknown>
				const e = event === 'pre_tool_use' ? toolEnvelope(payload) : payload
				// The module may not have been started yet; its registrations tell which hooks hear this.
				try {
					await start()
				} catch (error) {
					const why = `hooks module ${label} failed to load: ${toErrorMessage(error)}`
					unload(why)
					return { action: 'continue', notice: why }
				}
				const registrations: number[] = []
				for (const [index, events] of registrationEvents.entries()) {
					if (events.has(event)) registrations.push(index)
				}
				if (registrations.length === 0) return { action: 'continue' }
				const outcome = await dispatch(eventName, e, registrations, context.signal)
				if (outcome.kind === 'failed') return failurePolicy(event, outcome.message)
				if (outcome.failures.length > 0) return failurePolicy(event, outcome.failures.join('; '))
				const json = answerAsJson(event, outcome.value)
				if ('problem' in json) return failurePolicy(event, json.problem)
				const call: ShellHookCall = {
					...(context.toolName !== undefined ? { toolName: context.toolName } : {}),
					...(context.toolInput !== undefined ? { toolInput: context.toolInput } : {}),
				}
				return shellHookVerdict(
					event,
					{ type: 'command', command: commandLabel },
					{ exitCode: 0, timedOut: false, stdout: JSON.stringify(json.json), stderr: '' },
					log,
					call,
				)
			},
		} as PluginHookDefinition)
	}

	return {
		scan,
		get status() {
			return status
		},
		get message() {
			return message
		},
		hooks,
		dispose: async () => {
			status = 'unloaded'
			await endWorker('the hooks worker was stopped')
		},
	}
}
