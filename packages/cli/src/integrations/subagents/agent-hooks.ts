/**
 * The hooks an agent file carries, attached for the length of one run.
 *
 * An agent file's `hooks` block is read by the config loader's own reader
 * (`readSkillHooks`, which both shapes and every problem go through), made into
 * the same hooks a config file's entries become (`createShellHook`), and
 * attached to the session's lifecycle manager when a run of that agent starts.
 * What makes them different from a config file's:
 *
 *   - they last one run. The attachment is keyed by the child's session id and
 *     never by the agent's name, so two runs of one agent at the same time each
 *     have their own, and every one of them is taken off when its run ends: done,
 *     failed, stopped or abandoned;
 *   - they fire for that child's own session only: its tool calls, its turns.
 *     Not the parent's, not a sibling's, and not an agent the child starts (that
 *     agent is its own file's, or none);
 *   - an entry on `turn_end` means "when this agent is about to finish": it
 *     fires where `subagent_stop` fires for the child, carrying what that event
 *     carries, once. The same command written under both runs once;
 *   - an entry on a guarding event that cannot be loaded costs the agent its
 *     place: the file is not offered, and starting it is refused with a line
 *     naming the file and the entry. An agent has no half state in which it
 *     runs without the guard its file wrote.
 */
import {
	type HookAttachment,
	type PluginHookContext,
	type PluginHookDefinition,
	type PluginHookResult,
	type PluginLifecycleManager,
	SHELL_HOOKS_PLUGIN_ID,
	SHELL_HOOK_EVENTS,
	type ShellHookEvent,
	type ShellHookHandler,
	type ShellHookOptions,
	createShellHook,
} from '@namzu/sdk'

import { isGuardHookEvent } from '../../config/hook-common-shape.js'
import { type HooksSwitch, hookIdentity } from '../../config/hook-layers.js'
import type { HooksConfig } from '../../config/schema.js'
import { type SkillHookProblem, readSkillHooks } from '../../config/skill-hooks-reader.js'

/** The events no child session ever fires: the host fires them for the main conversation. */
const EVENTS_OF_THE_MAIN_CONVERSATION: ReadonlySet<ShellHookEvent> = new Set<ShellHookEvent>([
	'session_start',
	'session_end',
	'turn_failure',
])

const MAX_NOTICE_CHARS = 600

/** What an agent file gives of itself to this module. */
export interface AgentHooksCarrier {
	readonly name: string
	readonly path: string
	readonly source: string
	readonly hooksSource: string
}

/** An agent file that is not offered, and the line that says why. */
export interface RefusedAgent {
	readonly name: string
	readonly path: string
	/** One line for the person and for the model that asks for the agent. */
	readonly line: string
}

/** One hook an agent's run has attached right now, for `/hooks`. */
export interface AttachedAgentHook {
	readonly agent: string
	readonly event: string
	readonly runs: string
	readonly matcher?: string
	readonly once: boolean
	/** The child session it is attached to. */
	readonly session: string
}

export interface AgentHooksRead {
	/** The entries to attach, by the event they fire on (`turn_end` already moved to `subagent_stop`). */
	readonly hooks: HooksConfig
	readonly count: number
	readonly guardLost: boolean
	readonly problems: readonly SkillHookProblem[]
}

function cut(text: string): string {
	return text.length > MAX_NOTICE_CHARS ? `${text.slice(0, MAX_NOTICE_CHARS)}...` : text
}

function describeRuns(entry: ShellHookHandler): string {
	if (entry.type === 'http') return `POST ${entry.url}`
	if (entry.type === 'prompt') return `ask: ${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}`
	return [entry.command, ...(entry.args ?? [])].join(' ')
}

function withoutMatcher<T extends object>(entry: T): T {
	const { matcher: _matcher, ...rest } = entry as T & { matcher?: string }
	return rest as T
}

/**
 * Read an agent file's `hooks` text the way a config file's is read, then put
 * the entries where they fire for a child.
 *
 * `turn_end` is "when this agent is about to finish", which for a child is
 * `subagent_stop`: those entries move there, without their matcher (a
 * `turn_end` entry has none to test, and a name matcher on `subagent_stop`
 * could stop it firing for the agent it came from). An entry already written
 * under `subagent_stop` stays, and drops out when the same entry is written
 * under both, so it runs once. An event only the main conversation fires is set
 * aside with a note.
 */
export function readAgentHooks(source: string, name: string): AgentHooksRead {
	const read = readSkillHooks(source, `agent ${name}`, 'agent file')
	const problems = [...read.problems]
	const out: Record<string, unknown[]> = {}
	const stop: Record<string, unknown>[] = []
	const seen = new Set<string>()
	const addStop = (entry: Record<string, unknown>): void => {
		const identity = hookIdentity('subagent_stop', withoutMatcher(entry) as never)
		if (seen.has(identity)) return
		seen.add(identity)
		stop.push(entry)
	}
	const entries = read.hooks as unknown as Record<string, Record<string, unknown>[]>
	for (const entry of entries.turn_end ?? []) addStop(withoutMatcher(entry))
	for (const entry of entries.subagent_stop ?? []) addStop(entry)
	for (const event of SHELL_HOOK_EVENTS) {
		const list = entries[event]
		if (!list || list.length === 0) continue
		if (event === 'turn_end' || event === 'subagent_stop') continue
		if (EVENTS_OF_THE_MAIN_CONVERSATION.has(event)) {
			problems.push({
				event,
				severity: 'note',
				message: `is fired for the main conversation only, never inside an agent's run, so it will not run.`,
			})
			continue
		}
		out[event] = list
	}
	if (stop.length > 0) out.subagent_stop = stop
	const count = Object.values(out).reduce((n, list) => n + list.length, 0)
	return {
		hooks: out as unknown as HooksConfig,
		count,
		guardLost: read.guardLost,
		problems,
	}
}

function lines(problems: readonly SkillHookProblem[], severity: 'problem' | 'note'): string {
	return problems
		.filter((problem) => problem.severity === severity)
		.map((problem) => `${problem.event} ${problem.message}`)
		.join(' ')
}

/** The line for an agent that cannot be offered, naming its file and the entry. */
export function refusalLine(name: string, path: string, why: string): string {
	return cut(
		`Agent "${name}" is not offered: ${path}, hooks: ${why} The agent is not started without the guard its file wrote; fix the entry or take it out of the file.`,
	)
}

export interface VetOptions {
	/** `disableHooks`, the environment switch or `hooksManagedOnly`. */
	readonly hooksSwitch?: HooksSwitch | undefined
	/** Whether the person trusted the folder the project's own agent files are in. */
	readonly projectTrusted: boolean
}

/**
 * Which agent files may be offered. A file whose guard cannot be loaded is not;
 * nor is a project file that carries a guard in a folder that is not trusted,
 * because its hooks cannot attach before trust and the agent would run
 * without them. A file that carries no hooks is offered as ever; a switch that
 * turns hooks off offers the file as if it had none (a person's own choice).
 */
export function vetAgentHooks<
	T extends Omit<AgentHooksCarrier, 'hooksSource'> & { readonly hooksSource?: string },
>(
	definitions: readonly T[],
	options: VetOptions,
): { readonly offered: readonly T[]; readonly refused: readonly RefusedAgent[] } {
	const offered: T[] = []
	const refused: RefusedAgent[] = []
	for (const definition of definitions) {
		const carried = definition
		if (carried.hooksSource === undefined || options.hooksSwitch !== undefined) {
			offered.push(carried)
			continue
		}
		const read = readAgentHooks(carried.hooksSource, carried.name)
		if (read.guardLost) {
			refused.push({
				name: carried.name,
				path: carried.path,
				line: refusalLine(carried.name, carried.path, lines(read.problems, 'problem')),
			})
			continue
		}
		if (carried.source === 'project' && !options.projectTrusted) {
			const guards = SHELL_HOOK_EVENTS.filter(
				(event) =>
					isGuardHookEvent(event) &&
					((read.hooks as unknown as Record<string, unknown[]>)[event]?.length ?? 0) > 0,
			)
			if (guards.length > 0) {
				refused.push({
					name: carried.name,
					path: carried.path,
					line: refusalLine(
						carried.name,
						carried.path,
						`the folder is not trusted, so its ${guards.join(', ')} hooks cannot attach.`,
					),
				})
				continue
			}
		}
		offered.push(carried)
	}
	return { offered, refused }
}

export interface AgentHooksHostOptions {
	/** The session's lifecycle manager; absent when the session has no hook runtime. */
	readonly manager: () => PluginLifecycleManager | undefined
	/** What every hook of the session is run with (folder, log, permission mode, judge). */
	readonly hookOptions: () => ShellHookOptions | undefined
	readonly hooksSwitch: () => HooksSwitch | undefined
	readonly projectTrusted: () => boolean
}

export interface AgentHooksHost {
	/**
	 * A run of this agent starts as the child session `sessionId`: attach its
	 * file's hooks to that session. Returns what takes them off, which the run's
	 * end calls whatever the end was. Throws the refusal line when the agent's
	 * guard cannot be loaded or attached, so the run does not start.
	 */
	attachRun(agent: AgentHooksCarrier, sessionId: string): () => void
	/** Every hook a live run has attached. */
	attached(): readonly AttachedAgentHook[]
	/** Lines for the person (an agent's hooks set aside). */
	subscribe(listener: (line: string) => void): () => void
}

export function createAgentHooksHost(options: AgentHooksHostOptions): AgentHooksHost {
	interface Live {
		readonly attachment: HookAttachment
		readonly rows: (AttachedAgentHook & { gone: boolean })[]
	}
	const live = new Set<Live>()
	const listeners = new Set<(line: string) => void>()
	const told = new Set<string>()
	const tell = (line: string): void => {
		if (told.has(line)) return
		told.add(line)
		for (const listener of listeners) listener(line)
	}

	return {
		attachRun: (agent, sessionId) => {
			const none = (): void => undefined
			// Switched off: the agent runs as if its file had no `hooks` key.
			if (options.hooksSwitch() !== undefined) return none
			const read = readAgentHooks(agent.hooksSource, agent.name)
			if (read.guardLost) {
				throw new Error(refusalLine(agent.name, agent.path, lines(read.problems, 'problem')))
			}
			const setAside = lines(read.problems, 'note')
			if (setAside) tell(cut(`Agent ${agent.name}: ${setAside}`))
			if (read.count === 0) return none
			const trusted = agent.source !== 'project' || options.projectTrusted()
			const manager = options.manager()
			const base = options.hookOptions()
			const guards = SHELL_HOOK_EVENTS.filter(
				(event) =>
					isGuardHookEvent(event) &&
					((read.hooks as unknown as Record<string, unknown[]>)[event]?.length ?? 0) > 0,
			)
			if (!trusted || !manager || !base) {
				const why = !trusted
					? 'the folder is not trusted, so its hooks cannot attach.'
					: 'this session has no hook runtime, so its hooks cannot attach.'
				if (guards.length > 0) throw new Error(refusalLine(agent.name, agent.path, why))
				tell(cut(`Agent ${agent.name}: ${why}`))
				return none
			}
			const rows: Live['rows'] = []
			const defs: PluginHookDefinition[] = []
			const own: { entry?: Live } = {}
			for (const event of SHELL_HOOK_EVENTS) {
				for (const configured of (read.hooks as unknown as Record<string, ShellHookHandler[]>)[
					event
				] ?? []) {
					const cooked: ShellHookHandler = { ...configured, source: `agent ${agent.name}` }
					const once = cooked.once === true
					// `once` is decided here: a hook that failed to run stays, one that ran is taken off.
					const { once: _once, ...withoutOnce } = cooked as ShellHookHandler & { once?: boolean }
					let runs = 0
					const created = createShellHook(event, withoutOnce as ShellHookHandler, {
						...base,
						onRun: (info) => {
							runs += 1
							base.onRun?.(info)
						},
					})
					const index = defs.length
					rows.push({
						agent: agent.name,
						event,
						runs: describeRuns(cooked),
						...(cooked.matcher !== undefined ? { matcher: cooked.matcher } : {}),
						once,
						session: sessionId,
						gone: false,
					})
					defs.push({
						...created,
						handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
							// The child's own events only: not the parent's, not a sibling's.
							if (String(context.sessionId) !== sessionId) return { action: 'continue' }
							const before = runs
							const result = await created.handler(context)
							if (once && runs > before && result.action !== 'error') {
								const row = rows[index]
								if (row) row.gone = true
								own.entry?.attachment.removeAt(index)
							}
							return result
						},
					} as PluginHookDefinition)
				}
			}
			const attachment = manager.attachHooks(SHELL_HOOKS_PLUGIN_ID, defs)
			const entry: Live = {
				attachment: {
					size: attachment.size,
					remove: () => {
						live.delete(entry)
						return attachment.remove()
					},
					removeAt: (index) => attachment.removeAt(index),
				},
				rows,
			}
			own.entry = entry
			live.add(entry)
			return () => {
				entry.attachment.remove()
			}
		},
		attached: () =>
			[...live].flatMap((found) =>
				found.rows.filter((row) => !row.gone).map(({ gone: _gone, ...row }) => row),
			),
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}
