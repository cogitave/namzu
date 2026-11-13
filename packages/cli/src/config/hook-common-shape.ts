/**
 * The `hooks` key written in the common hook contract's shape.
 *
 * Our own shape is event → flat list of entries. The common one is event
 * (PascalCase) → list of groups, a group having an optional `matcher` and a
 * list `hooks`, each hook a `type`, its settings and a `timeout` in seconds.
 * Both live in the same `hooks` key; this file reads a group into our entries.
 *
 * Nothing is dropped in silence. What cannot be loaded, and what is read but
 * not acted on, goes to `report` in plain words, and one hook that cannot be
 * read never switches off the others in its group, event or file. Where a
 * hook's own words cannot be read the reading errs towards running it: an
 * unreadable `matcher`, `if`, `timeout` or `once` is left off, so the hook
 * runs for more calls and never fewer.
 */
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	type ShellHookEvent,
	type ShellHookHandler,
	shellHookEnvNameProblem,
} from '@namzu/sdk'

/** `problem` is a hook that cannot be loaded and would have guarded something; `note` is anything else. */
export type HookProblemSeverity = 'problem' | 'note'

export type ReportHookProblem = (severity: HookProblemSeverity, message: string) => void

/** The events whose hooks can refuse, redirect or feed back into a turn: a hook lost here is a guard lost. */
const GUARD_EVENTS: ReadonlySet<ShellHookEvent> = new Set([
	'user_prompt_submit',
	'pre_tool_use',
	'post_tool_use',
	'post_tool_use_failure',
	'permission_request',
	'pre_compact',
	'turn_end',
	'subagent_start',
	'subagent_stop',
])

/** Whether a hook on this event can refuse, redirect or feed back into a turn: one lost here is a guard lost. */
export function isGuardHookEvent(event: ShellHookEvent): boolean {
	return GUARD_EVENTS.has(event)
}

const KIND_KEYS = {
	command: ['command', 'args', 'async', 'env'],
	http: ['url', 'headers', 'allowedEnvVars'],
	prompt: ['prompt'],
} as const
const SHARED_KEYS = ['type', 'timeout', 'if', 'once', 'statusMessage', 'onFailure']

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The event a `hooks` key names, in either spelling (`pre_tool_use` or `PreToolUse`). */
export function hookEventForKey(key: string): ShellHookEvent | undefined {
	if ((SHELL_HOOK_EVENTS as readonly string[]).includes(key)) return key as ShellHookEvent
	for (const event of SHELL_HOOK_EVENTS) {
		if (SHELL_HOOK_PASCAL_EVENT_NAMES[event] === key) return event
	}
	return undefined
}

/** Whether a key reads as an event name written in PascalCase, whether or not this kernel has it. */
export function looksLikeWrittenEvent(key: string): boolean {
	return /^[A-Z][A-Za-z]+$/.test(key)
}

/** Whether a list element is a group (it has a list `hooks`), not one of our flat entries. */
export function isHookGroup(element: unknown): element is Record<string, unknown> {
	return isMapping(element) && Array.isArray(element.hooks)
}

/**
 * What to say of a list element under a PascalCase event that is not a mapping at
 * all (a bare string, a number): it cannot be a hook, so it is set aside and
 * the others load. A problem where the event can guard something.
 */
export function unreadableElement(
	event: ShellHookEvent,
	index: number,
): { severity: 'problem' | 'note'; message: string } {
	const guard = GUARD_EVENTS.has(event)
	return {
		severity: guard ? 'problem' : 'note',
		message: `entry ${index + 1} is not a mapping, so it will not run${
			guard ? ' and what it was meant to guard is not checked' : ''
		}.`,
	}
}

/** The hooks inside a group, or the element itself when it is a flat entry; for readers that only list. */
export function hooksOfElement(element: unknown): unknown[] {
	return isHookGroup(element) ? (element.hooks as unknown[]) : [element]
}

/**
 * Whether an element of a list under a PascalCase key is meant as a group: it
 * has a `hooks` key, or it has none of the keys that make a flat entry.
 */
export function isMeantAsGroup(element: unknown): boolean {
	if (!isMapping(element)) return false
	if (element.hooks !== undefined) return true
	return !('command' in element || 'url' in element || 'prompt' in element || 'type' in element)
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * An `env` map in a hook of the common shape. A name that cannot be used, or a
 * value that is not text, is left out with a note and the hook runs with the
 * rest: the hook still starts, and what it needed is said out loud.
 */
function readHookEnv(
	value: unknown,
	at: string,
	report: ReportHookProblem,
): Record<string, string> | undefined {
	if (value === undefined) return undefined
	if (!isMapping(value)) {
		report(
			'note',
			`${at}: "env" must be a mapping of variable names to text; it is left off and the hook runs without it.`,
		)
		return undefined
	}
	const out: Record<string, string> = {}
	for (const [name, each] of Object.entries(value)) {
		const bad = shellHookEnvNameProblem(name)
		if (bad !== undefined) {
			report('note', `${at}: "env" ${JSON.stringify(name)} ${bad}; it is left off.`)
		} else if (typeof each !== 'string') {
			report('note', `${at}: "env" ${JSON.stringify(name)} must be text; it is left off.`)
		} else out[name] = each
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Read one group of the common shape into our entries. `report` is told what
 * could not be loaded and what is not acted on; the caller names the file and
 * the event.
 */
export function readHookGroup(
	event: ShellHookEvent,
	group: Record<string, unknown>,
	groupIndex: number,
	report: ReportHookProblem,
): ShellHookHandler[] {
	const where = `group ${groupIndex + 1}`
	const guard = GUARD_EVENTS.has(event)
	const lost = (hook: number, why: string): void => {
		report(
			guard ? 'problem' : 'note',
			`${where}, hook ${hook + 1} ${why}, so it will not run${
				guard ? ' and what it was meant to guard is not checked' : ''
			}.`,
		)
	}
	for (const key of Object.keys(group)) {
		if (key !== 'matcher' && key !== 'hooks') {
			report('note', `${where}: "${key}" is not a setting of a group and is not acted on.`)
		}
	}
	let matcher: string | undefined
	if (group.matcher !== undefined) {
		if (typeof group.matcher === 'string') matcher = group.matcher
		else {
			report(
				'note',
				`${where}: "matcher" is not text and is left off, so its hooks run for every call.`,
			)
		}
	}
	const out: ShellHookHandler[] = []
	const hooks = Array.isArray(group.hooks) ? group.hooks : []
	for (const [index, hook] of hooks.entries()) {
		const at = `${where}, hook ${index + 1}`
		if (!isMapping(hook)) {
			lost(index, 'is not a mapping')
			continue
		}
		const kind = hook.type === undefined ? 'command' : hook.type
		if (kind !== 'command' && kind !== 'http' && kind !== 'prompt') {
			lost(
				index,
				`is of type ${JSON.stringify(kind)}, a kind this kernel does not have (it has command, http and prompt)`,
			)
			continue
		}
		const acted: readonly string[] = [...SHARED_KEYS, ...KIND_KEYS[kind]]
		for (const key of Object.keys(hook)) {
			if (!acted.includes(key)) {
				report(
					'note',
					`${at}: "${key}" is not acted on${kind === 'command' ? '' : ` in a ${kind} hook`}; the hook runs without it.`,
				)
			}
		}
		const ignored = (key: string, need: string): void =>
			report(
				'note',
				`${at}: "${key}" must be ${need}; it is left off and the hook runs without it.`,
			)
		let timeoutMs: number | undefined
		if (hook.timeout !== undefined) {
			if (typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) && hook.timeout > 0) {
				timeoutMs = Math.max(1, Math.round(hook.timeout * 1000))
			} else ignored('timeout', 'a number of seconds above zero')
		}
		let filter: string | undefined
		if (hook.if !== undefined) {
			filter = text(hook.if)
			if (filter === undefined) ignored('if', 'non-empty text')
		}
		let once: boolean | undefined
		if (hook.once !== undefined) {
			if (typeof hook.once === 'boolean') once = hook.once
			else ignored('once', 'true or false')
		}
		let statusMessage: string | undefined
		if (hook.statusMessage !== undefined) {
			statusMessage = text(hook.statusMessage)
			if (statusMessage === undefined) ignored('statusMessage', 'non-empty text')
		}
		let onFailure: 'continue' | 'block' | undefined
		if (hook.onFailure !== undefined) {
			if (hook.onFailure === 'continue' || hook.onFailure === 'block') onFailure = hook.onFailure
			else ignored('onFailure', '"continue" or "block"')
		}
		const shared = {
			...(matcher !== undefined ? { matcher } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(filter !== undefined ? { if: filter } : {}),
			...(once !== undefined ? { once } : {}),
			...(statusMessage !== undefined ? { statusMessage } : {}),
			...(onFailure !== undefined ? { onFailure } : {}),
			toolNames: 'written' as const,
		}
		if (kind === 'http') {
			const url = text(hook.url)
			let protocol: string | undefined
			try {
				protocol = url === undefined ? undefined : new URL(url).protocol
			} catch {
				protocol = undefined
			}
			if (protocol !== 'http:' && protocol !== 'https:') {
				lost(index, 'has no http or https "url"')
				continue
			}
			let headers: Record<string, string> | undefined
			if (hook.headers !== undefined) {
				if (
					isMapping(hook.headers) &&
					Object.values(hook.headers).every((v) => typeof v === 'string')
				) {
					headers = hook.headers as Record<string, string>
				} else ignored('headers', 'a mapping of header names to text')
			}
			let allowedEnvVars: string[] | undefined
			if (hook.allowedEnvVars !== undefined) {
				if (
					Array.isArray(hook.allowedEnvVars) &&
					hook.allowedEnvVars.every((v) => typeof v === 'string')
				) {
					allowedEnvVars = hook.allowedEnvVars as string[]
				} else ignored('allowedEnvVars', 'a list of variable names')
			}
			out.push({
				type: 'http',
				url: url as string,
				...(headers !== undefined ? { headers } : {}),
				...(allowedEnvVars !== undefined ? { allowedEnvVars } : {}),
				...shared,
			})
		} else if (kind === 'prompt') {
			const prompt = text(hook.prompt)
			if (prompt === undefined) {
				lost(index, 'has no "prompt" text')
				continue
			}
			out.push({ type: 'prompt', prompt, ...shared })
		} else {
			const command = text(hook.command)
			if (command === undefined) {
				lost(index, 'has no "command"')
				continue
			}
			let args: string[] | undefined
			if (hook.args !== undefined) {
				if (Array.isArray(hook.args) && hook.args.every((v) => typeof v === 'string')) {
					args = hook.args as string[]
				} else {
					// The command would run with the wrong arguments, or none: not loaded.
					lost(index, 'has "args" that are not a list of text')
					continue
				}
			}
			let async: boolean | undefined
			if (hook.async !== undefined) {
				if (typeof hook.async === 'boolean') async = hook.async
				else ignored('async', 'true or false')
			}
			const env = readHookEnv(hook.env, at, report)
			out.push({
				command,
				...(args !== undefined ? { args } : {}),
				...(async !== undefined ? { async } : {}),
				...(env !== undefined ? { env } : {}),
				...shared,
			})
		}
	}
	if (hooks.length === 0 && !Array.isArray(group.hooks)) {
		report(guard ? 'problem' : 'note', `${where} has no list "hooks", so nothing in it will run.`)
	}
	return out
}

/** What is said of an event key this kernel has no event for. */
export function unknownEventMessage(): string {
	return 'is not an event this kernel has, so none of its hooks will run'
}
