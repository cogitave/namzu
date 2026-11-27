import { COMMON_MODULE_EVENT_NAMESPACE } from '../common-layout-names.js'
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	type ShellHookEvent,
} from '../shell-hook.js'

/**
 * The settings-style hook events a hooks module may name, as `classic.<Event>`.
 * Some have no counterpart in Namzu; they are accepted and never run.
 */
export const CLASSIC_HOOK_EVENTS: readonly string[] = [
	'PreToolUse',
	'PostToolUse',
	'PostToolUseFailure',
	'PostToolBatch',
	'PermissionDenied',
	'Notification',
	'UserPromptSubmit',
	'UserPromptExpansion',
	'SessionStart',
	'SessionEnd',
	'Stop',
	'StopFailure',
	'SubagentStart',
	'SubagentStop',
	'PreCompact',
	'PostCompact',
	'PreModelSwitch',
	'PostModelSwitch',
	'PermissionRequest',
	'Setup',
	'TeammateIdle',
	'TaskCreated',
	'TaskCompleted',
	'Elicitation',
	'ElicitationResult',
	'ConfigChange',
	'InstructionsLoaded',
	'WorktreeCreate',
	'WorktreeRemove',
	'CwdChanged',
	'FileChanged',
	'DirectoryAdded',
	'MessageDisplay',
	'PreSkillShellCommand',
]

/**
 * The namespaces of the events the other engine runs inside itself (tool calls,
 * the interface, agents and the rest). A module may register on them; Namzu has
 * no such events, so none of those hooks run.
 */
const ENGINE_NAMESPACES: ReadonlySet<string> = new Set([
	'tool',
	'turn',
	'session',
	'prompt',
	'agent',
	'command',
	'config',
	'settings',
	'env',
	'state',
	'store',
	'telemetry',
	'skill',
	'attribution',
	'ui',
	'theme',
	'vcs',
	'process',
	'fs',
	'http',
	'model',
	'mcp',
	'audio',
	'clock',
	'wasm',
	'plugin',
	'engine',
])

const NAMESPACE = COMMON_MODULE_EVENT_NAMESPACE

/** Each classic name that Namzu has an event for, to that event. */
const CLASSIC_TO_NAMZU: ReadonlyMap<string, ShellHookEvent> = new Map(
	SHELL_HOOK_EVENTS.flatMap((event) => {
		const written = SHELL_HOOK_PASCAL_EVENT_NAMES[event]
		return written !== undefined && CLASSIC_HOOK_EVENTS.includes(written)
			? [[written, event] as const]
			: []
	}),
)

const NAMZU_TO_CLASSIC: ReadonlyMap<ShellHookEvent, string> = new Map(
	[...CLASSIC_TO_NAMZU].map(([classic, event]) => [event, classic] as const),
)

/** The Namzu events a module can run on. */
export const MODULE_HOOK_EVENTS: readonly ShellHookEvent[] = [...NAMZU_TO_CLASSIC.keys()]

/** The name a module registers on for a Namzu event: `classic.PreToolUse`. */
export function classicEventName(event: ShellHookEvent): string | undefined {
	const written = NAMZU_TO_CLASSIC.get(event)
	return written === undefined ? undefined : `${NAMESPACE}.${written}`
}

/** The written (PascalCase) name of a Namzu event, as a module's `e.hook_event_name` spells it. */
export function classicWrittenName(event: ShellHookEvent): string | undefined {
	return NAMZU_TO_CLASSIC.get(event)
}

export type ResolvedPattern =
	| {
			readonly ok: true
			/** The Namzu events the pattern selects and Namzu runs. */
			readonly runs: readonly ShellHookEvent[]
			/**
			 * Set when the pattern names only events Namzu does not have: nothing it
			 * hooks ever runs, and the message says so.
			 */
			readonly notUsed?: string
	  }
	| { readonly ok: false; readonly message: string }

function notAvailable(pattern: string): string {
	return `Namzu runs ${NAMESPACE}.* hooks from modules; ${pattern} is not available.`
}

function isEngineName(name: string): boolean {
	const dot = name.indexOf('.')
	if (dot <= 0 || dot === name.length - 1) return false
	return (
		ENGINE_NAMESPACES.has(name.slice(0, dot)) && /^[A-Za-z][A-Za-z0-9]*$/.test(name.slice(dot + 1))
	)
}

/**
 * What a pattern selects: one event by name, every event under a namespace
 * (`classic.*`), every event (`*`), or every event but those another pattern
 * selects (`!tool.*`, `!classic.Stop`). A name that is no event and a glob that
 * selects nothing are refused.
 */
export function resolvePattern(pattern: string): ResolvedPattern {
	const all = (): readonly ShellHookEvent[] => [...MODULE_HOOK_EVENTS]
	if (pattern === '*') return { ok: true, runs: all() }
	if (pattern.startsWith('!')) {
		const inner = resolvePattern(pattern.slice(1))
		if (!inner.ok) return inner
		if (pattern.startsWith('!!')) {
			return { ok: false, message: `"${pattern}" is not a pattern: a negation is made once` }
		}
		const taken = new Set(inner.runs)
		return { ok: true, runs: all().filter((event) => !taken.has(event)) }
	}
	if (pattern.endsWith('.*')) {
		const space = pattern.slice(0, -2)
		if (space === NAMESPACE) return { ok: true, runs: all() }
		if (ENGINE_NAMESPACES.has(space)) {
			return { ok: true, runs: [], notUsed: notAvailable(pattern) }
		}
		return { ok: false, message: `"${pattern}" is not a pattern: it selects no event` }
	}
	if (pattern.startsWith(`${NAMESPACE}.`)) {
		const name = pattern.slice(NAMESPACE.length + 1)
		if (!CLASSIC_HOOK_EVENTS.includes(name)) {
			return { ok: false, message: `"${pattern}" is not an event` }
		}
		const event = CLASSIC_TO_NAMZU.get(name)
		return event === undefined
			? { ok: true, runs: [], notUsed: notAvailable(pattern) }
			: { ok: true, runs: [event] }
	}
	if (isEngineName(pattern)) return { ok: true, runs: [], notUsed: notAvailable(pattern) }
	return { ok: false, message: `"${pattern}" is not an event` }
}
