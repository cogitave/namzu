/**
 * The hooks a skill carries, attached while the skill is in use.
 *
 * A skill's `hooks` block is read by the config loader's own reader
 * (`readSkillHooks`), made into the same hooks a config file's entries become
 * (`createShellHook`), and attached to the session's lifecycle manager when the
 * skill is used, not when skills are listed. What makes them different from a
 * config file's is how long they last and what a bad entry costs:
 *
 *   - an inline skill's hooks last as long as the conversation: `/clear`, a
 *     resume, a fork or leaving removes them (`endConversation`), and using the
 *     skill again does not attach them twice;
 *   - a forked skill's hooks belong to the delegated agent's run: they fire
 *     only in that agent (and agents it starts) and end when it ends;
 *   - an entry on a guarding event that cannot be loaded costs the skill its
 *     hooks and its tool pre-approval, and the model and the person are told
 *     in one line: a skill written to run its commands under its own guard
 *     must not run them unguarded and pre-approved.
 */
import { createHash } from 'node:crypto'
import {
	type HookAttachment,
	type PluginHookContext,
	type PluginHookDefinition,
	type PluginHookResult,
	type PluginLifecycleManager,
	SHELL_HOOKS_PLUGIN_ID,
	SHELL_HOOK_EVENTS,
	type ShellHookHandler,
	type ShellHookOptions,
	type SkillHooksHandle,
	type SkillHooksOptions,
	type SkillHooksPlan,
	createShellHook,
} from '@namzu/sdk'

import type { HooksSwitch } from '../config/hook-layers.js'
import {
	type SkillHookProblem,
	readSkillHooks,
	withoutConversationEvents,
	withoutSessionStart,
} from '../config/skill-hooks-reader.js'

/** What a skill's hook commands see of the skill: its own folder. One place, so a rule beside it can add to it. */
export function skillHookEnv(skillRoot: string): Record<string, string> {
	return { NAMZU_SKILL_ROOT: skillRoot }
}

/** `${NAMZU_SKILL_ROOT}` in a command and its arguments, replaced by the skill's folder. */
function withSkillRoot(entry: ShellHookHandler, skillRoot: string): ShellHookHandler {
	if (entry.type === 'http' || entry.type === 'prompt') return entry
	const put = (text: string): string => text.split('${NAMZU_SKILL_ROOT}').join(skillRoot)
	return {
		...entry,
		command: put(entry.command),
		...(entry.args !== undefined ? { args: entry.args.map(put) } : {}),
	}
}

/** One hook a skill has attached right now, for `/hooks`. */
export interface AttachedSkillHook {
	readonly skill: string
	readonly event: string
	/** What it runs: the command, the address or the prompt. */
	readonly runs: string
	readonly matcher?: string
	readonly once: boolean
	/** `conversation` for an inline skill, `agent` for a forked one's run. */
	readonly scope: 'conversation' | 'agent'
}

export interface SkillHooksHostOptions {
	/** The session's lifecycle manager; absent when the session has no hook runtime. */
	readonly manager: () => PluginLifecycleManager | undefined
	/** What every hook of the session is run with (folder, log, permission mode, judge). */
	readonly hookOptions: () => ShellHookOptions | undefined
	/** `disableHooks`, the environment switch or `hooksManagedOnly`. */
	readonly hooksSwitch: () => HooksSwitch | undefined
	/** Whether the folder's own skills may attach hooks: the person trusted the folder. */
	readonly projectTrusted: () => boolean
	/** Whether a skill, by the name the registry gives it, is one the folder carries. */
	readonly isProjectSkill: (name: string) => boolean
}

export interface SkillHooksHost {
	/** What the `skill` tool asks; see `SkillRegistryRef.prepareHooks`. */
	readonly prepareHooks: (
		skill: { readonly name: string; readonly dirPath?: string; readonly hooksSource: string },
		options: SkillHooksOptions,
	) => SkillHooksPlan
	/**
	 * The person ran a skill by name (`/skills <name>`, `/<name>`, `--skills`):
	 * its hooks attach for the rest of the conversation, as when the model loads it.
	 */
	use(skill: {
		readonly name: string
		readonly dirPath: string
		readonly hooksSource: string
	}): void
	/** Every hook a skill has attached and not lost. */
	attached(): readonly AttachedSkillHook[]
	/** The conversation ended or was replaced: every skill's hooks come off. */
	endConversation(): void
	/** Lines for the person (a skill's hooks that could not be loaded). */
	subscribe(listener: (line: string) => void): () => void
}

const MAX_NOTICE_CHARS = 600

function describeRuns(entry: ShellHookHandler): string {
	if (entry.type === 'http') return `POST ${entry.url}`
	if (entry.type === 'prompt') return `ask: ${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}`
	return [entry.command, ...(entry.args ?? [])].join(' ')
}

function digestOf(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function cut(text: string): string {
	return text.length > MAX_NOTICE_CHARS ? `${text.slice(0, MAX_NOTICE_CHARS)}...` : text
}

function firstSentence(
	problems: readonly SkillHookProblem[],
	severity: 'problem' | 'note',
): string {
	const found = problems.filter((problem) => problem.severity === severity)
	return found.map((problem) => `${problem.event} ${problem.message}`).join(' ')
}

interface Live {
	readonly skill: string
	readonly scope: 'conversation' | 'agent'
	readonly digest: string
	readonly attachment: HookAttachment
	readonly rows: (AttachedSkillHook & { gone: boolean })[]
}

export function createSkillHooksHost(options: SkillHooksHostOptions): SkillHooksHost {
	const live = new Set<Live>()
	const listeners = new Set<(line: string) => void>()
	/** What the person was already told, so a skill read in pages says it once. */
	const told = new Set<string>()
	const tell = (line: string): void => {
		if (told.has(line)) return
		told.add(line)
		for (const listener of listeners) listener(line)
	}
	const inert: SkillHooksHandle = { remove: () => undefined }

	const prepareHooks: SkillHooksHost['prepareHooks'] = (skill, how) => {
		const name = skill.name
		// Switched off: the skill loads as if it had no `hooks` key. No skills place
		// is managed, so no skill's hooks are an exception to either switch.
		if (options.hooksSwitch() !== undefined) {
			return { withholdGrants: false, attach: () => inert }
		}
		const refuse = (why: string): SkillHooksPlan => {
			const line = `Skill ${name}: ${why} None of its hooks are attached and its allowed-tools are not pre-approved.`
			tell(cut(line))
			return { notice: cut(line), withholdGrants: true, attach: () => inert }
		}
		if (options.isProjectSkill(name) && !options.projectTrusted()) {
			return refuse('it is in a folder that is not trusted.')
		}
		const readAll = withoutSessionStart(readSkillHooks(skill.hooksSource, `skill ${name}`))
		const read = how.forked ? withoutConversationEvents(readAll) : readAll
		// Nothing of the block could be told from a guard (not YAML, too large,
		// or every entry unreadable): the skill is refused. One unreadable entry
		// among readable ones costs only that entry, and the pre-approval.
		if (read.guardLost && read.count === 0) {
			return refuse(firstSentence(read.problems, 'problem'))
		}
		if (read.count === 0 && read.problems.length === 0) {
			return { withholdGrants: false, attach: () => inert }
		}
		const manager = options.manager()
		const base = options.hookOptions()
		if (!manager || !base) {
			return refuse('this session has no hook runtime.')
		}
		const root = skill.dirPath ?? ''
		const digest = digestOf(skill.hooksSource)
		const events = SHELL_HOOK_EVENTS.filter((event) => (read.hooks[event]?.length ?? 0) > 0)
		const setAside = firstSentence(read.problems, 'note')
		const unreadable = read.guardLost ? firstSentence(read.problems, 'problem') : ''
		if (setAside) tell(cut(`Skill ${name}: ${setAside}`))
		// What could not be read is said first and never softened: the hooks that
		// could be read are attached, and the skill's tools are not pre-approved.
		const partial = unreadable
			? ` Not loaded: ${unreadable} Its allowed-tools are not pre-approved.`
			: ''
		if (unreadable) tell(cut(`Skill ${name}:${partial}`))
		// The `pre_tool_use` hooks of a whole message are asked before any call of
		// it runs, so a call written beside the skill was checked before the
		// skill's guard existed. Said last and never cut: the model can act on it.
		const sameMessage =
			!how.forked && (events.includes('pre_tool_use') || events.includes('permission_request'))
				? ' Calls written in the same message as this skill were checked before these hooks attached; make the calls they should guard in a later message.'
				: ''
		const notice =
			cut(
				read.count === 0
					? `Skill ${name}: no hook of its could be loaded. ${setAside}`
					: how.forked
						? `Skill ${name}: its hooks (${events.join(', ')}) apply to the delegated agent's run only.${setAside ? ` Set aside: ${setAside}` : ''}${partial}`
						: `Skill ${name}: its hooks (${events.join(', ')}) are attached for the rest of this conversation, until it is cleared or resumed.${setAside ? ` Set aside: ${setAside}` : ''}${partial}`,
			) + (read.count === 0 ? '' : sameMessage)
		return {
			notice,
			withholdGrants: read.guardLost,
			attach: () => {
				if (read.count === 0) return inert
				if (!how.forked) {
					for (const found of live) {
						if (found.skill !== name || found.scope !== 'conversation') continue
						// Using a skill again does not attach its hooks twice; one that was
						// edited meanwhile replaces what it attached.
						if (found.digest === digest) return inert
						found.attachment.remove()
						live.delete(found)
					}
				}
				const scoped = how.forked ? childScope(how.sessionId, how.prompt) : undefined
				const rows: Live['rows'] = []
				const defs: PluginHookDefinition[] = []
				const own: { entry?: Live } = {}
				for (const event of SHELL_HOOK_EVENTS) {
					for (const configured of read.hooks[event] ?? []) {
						const cooked: ShellHookHandler = {
							...withSkillRoot(configured, root),
							source: `skill ${name}`,
						}
						const once = cooked.once === true
						// `once` is decided here, not by the entry: a hook that failed to run
						// stays for the next call, and one that ran is taken off the manager.
						const { once: _once, ...withoutOnce } = cooked as ShellHookHandler & {
							once?: boolean
						}
						let runs = 0
						const created = createShellHook(event, withoutOnce as ShellHookHandler, {
							...base,
							extraEnv: { ...base.extraEnv, ...skillHookEnv(root) },
							skillRoot: root,
							onRun: (info) => {
								runs += 1
								base.onRun?.(info)
							},
						})
						const index = defs.length
						rows.push({
							skill: name,
							event,
							runs: describeRuns(cooked),
							...(cooked.matcher !== undefined ? { matcher: cooked.matcher } : {}),
							once,
							scope: how.forked ? 'agent' : 'conversation',
							gone: false,
						})
						defs.push({
							...created,
							handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
								if (scoped && !scoped.covers(context)) return { action: 'continue' }
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
				const binders = scoped ? scoped.definitions(() => own.entry?.attachment.remove()) : []
				const attachment = manager.attachHooks(SHELL_HOOKS_PLUGIN_ID, [...binders, ...defs])
				// The binders come first in the attachment: positions are offset by them.
				const offset = binders.length
				const entry: Live = {
					skill: name,
					scope: how.forked ? 'agent' : 'conversation',
					digest,
					attachment: {
						size: attachment.size - offset,
						remove: () => {
							live.delete(entry)
							return attachment.remove()
						},
						removeAt: (index) => attachment.removeAt(index + offset),
					},
					rows,
				}
				own.entry = entry
				live.add(entry)
				return {
					remove: () => {
						entry.attachment.remove()
					},
				}
			},
		}
	}

	return {
		prepareHooks,
		use: (skill) => {
			prepareHooks(skill, { forked: false }).attach()
		},
		attached: () =>
			[...live].flatMap((found) =>
				found.rows.filter((row) => !row.gone).map(({ gone: _gone, ...row }) => row),
			),
		endConversation: () => {
			for (const found of [...live]) found.attachment.remove()
			live.clear()
			told.clear()
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}

/**
 * Which sessions a forked skill's hooks cover: the delegated agent the skill
 * starts, and the agents it starts in turn.
 *
 * Several agents may start under the session at the same moment (the model
 * wrote the skill and an `Agent` call in one message), so "the first agent to
 * start" is not the skill's. The skill's own agent is the one that is given the
 * prompt the skill delegated: every agent that starts under the session is
 * covered while it starts, and each one that is then given another prompt is
 * let go. Until one starts the hooks cover no session at all. When the host
 * does not say what the prompt is, the first agent to start is bound, as
 * before. The hooks end when the skill's agent stops.
 */
function childScope(
	parent: string | undefined,
	prompt?: string,
): {
	covers(context: PluginHookContext): boolean
	definitions(end: () => void): PluginHookDefinition[]
} {
	const bound = new Set<string>()
	/** Started under the calling session, not yet given a prompt. */
	const candidates = new Set<string>()
	let primary: string | undefined
	const wanted = prompt?.trim()
	const isTheSkillsPrompt = (given: string | undefined): boolean => {
		const text = (given ?? '').trim()
		if (wanted === undefined || wanted === '') return true
		return text !== '' && (text.includes(wanted) || wanted.includes(text))
	}
	const definitions = (end: () => void): PluginHookDefinition[] => {
		const out: PluginHookDefinition[] = [
			{
				event: 'subagent_start',
				// First, so the agent is covered for its own start events.
				priority: 0,
				handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
					const self = String(context.sessionId)
					const above =
						context.parentSessionId !== undefined ? String(context.parentSessionId) : undefined
					if (primary === undefined && (parent === undefined || above === parent)) {
						if (wanted === undefined) {
							primary = self
						} else {
							candidates.add(self)
						}
						bound.add(self)
					} else if (above !== undefined && bound.has(above)) {
						bound.add(self)
					}
					return { action: 'continue' }
				},
			} as PluginHookDefinition,
			{
				event: 'subagent_stop',
				handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
					const self = String(context.sessionId)
					// After this event's own hooks have been started; the coverage stays
					// for them.
					if (primary !== undefined && self === primary) {
						queueMicrotask(end)
					} else if (candidates.delete(self)) {
						queueMicrotask(() => bound.delete(self))
					}
					return { action: 'continue' }
				},
			} as PluginHookDefinition,
		]
		if (wanted !== undefined) {
			out.push({
				event: 'user_prompt_submit',
				priority: 0,
				handler: async (context: PluginHookContext): Promise<PluginHookResult> => {
					const self = String(context.sessionId)
					if (!candidates.has(self)) return { action: 'continue' }
					candidates.delete(self)
					if (primary === undefined && isTheSkillsPrompt(context.prompt)) {
						primary = self
						// The others that started meanwhile are not the skill's agent.
						for (const other of candidates) bound.delete(other)
						candidates.clear()
					} else {
						bound.delete(self)
					}
					return { action: 'continue' }
				},
			} as PluginHookDefinition)
		}
		return out
	}
	return {
		covers: (context) => bound.has(String(context.sessionId)),
		definitions,
	}
}
