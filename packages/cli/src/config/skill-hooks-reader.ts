/**
 * The `hooks` block of a skill's front matter, read the way a config file's is.
 *
 * It goes through the config loader's own `hooks` reader, so both shapes (ours
 * and the common contract's) and every problem read the same. What differs is
 * what one bad entry costs. A config file with a hook it cannot read refuses to
 * load, so the person fixes it. A skill is loaded by a model in the middle of a
 * turn: a skill that cannot load is no better than one that loads unguarded, so
 * the reader says what it could not load and the host decides what that means.
 *
 *   - an entry on an event that can refuse a tool call or a permission (see
 *     `isGuardHookEvent`) that cannot be loaded is `guardLost`;
 *   - an entry on any other event that cannot be loaded is dropped with a note;
 *   - an event this kernel does not have is dropped with a note;
 *   - a block that is not YAML, is not a mapping, or is larger than the bounds
 *     below is `guardLost`: nothing in it can be told from a guard.
 *
 * One entry that cannot be read never switches off the others.
 */
import { RENAMED_PLUGIN_HOOK_EVENTS, type ShellHookEvent } from '@namzu/sdk'
import { parse as yamlParse } from 'yaml'

import { hookEventForKey, isGuardHookEvent, unknownEventMessage } from './hook-common-shape.js'
import { ConfigValueError, readConfigKey, withHookProblemSink } from './load.js'
import type { HooksConfig } from './schema.js'

/** The most hook entries one skill may carry. Beyond it the skill's guard is not loaded. */
export const MAX_SKILL_HOOK_ENTRIES = 32
/** The longest `matcher` or `if` text one skill entry may carry. */
export const MAX_SKILL_HOOK_MATCHER_CHARS = 256
/** The most characters of `hooks` text one skill may carry. */
export const MAX_SKILL_HOOKS_SOURCE_CHARS = 32_768

export interface SkillHookProblem {
	/** The event as the skill spells it, or `hooks` for the block as a whole. */
	readonly event: string
	/** `problem`: it would have guarded something. `note`: anything else. */
	readonly severity: 'problem' | 'note'
	readonly message: string
}

export interface SkillHooksRead {
	/** The entries that were read, in the config's own shape. */
	readonly hooks: HooksConfig
	/** How many entries that is. */
	readonly count: number
	/** An entry that would have guarded something could not be loaded, or a bound was passed. */
	readonly guardLost: boolean
	readonly problems: readonly SkillHookProblem[]
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The part of a reader error after the setting path, without the file it names. */
function tailOf(error: ConfigValueError): string {
	const at = error.message.indexOf(`: ${error.settingPath}`)
	const sentence = at === -1 ? error.message : error.message.slice(at + 2)
	return sentence.replace(/^hooks\./, '')
}

/**
 * Read a skill's `hooks` text (`SkillMetadata.hooksSource`: the key's own line
 * and the lines under it).
 *
 * @param file what the reader's own messages call the source, for a person.
 */
export function readSkillHooks(
	source: string,
	file: string,
	/** What carries the block, for the bounds' messages: a skill or an agent file. */
	carrier: 'skill' | 'agent file' = 'skill',
): SkillHooksRead {
	const problems: SkillHookProblem[] = []
	const seen = new Set<string>()
	const report = (event: string, severity: 'problem' | 'note', message: string): void => {
		const key = `${event}\n${severity}\n${message}`
		if (seen.has(key)) return
		seen.add(key)
		problems.push({ event, severity, message })
	}
	const lost = (): SkillHooksRead => ({
		hooks: {} as HooksConfig,
		count: 0,
		guardLost: true,
		problems,
	})

	if (source.length > MAX_SKILL_HOOKS_SOURCE_CHARS) {
		report(
			'hooks',
			'problem',
			`is ${source.length} characters long, more than the ${MAX_SKILL_HOOKS_SOURCE_CHARS} ${carrier === 'skill' ? 'a skill' : 'an agent file'} may carry, so none of it is loaded.`,
		)
		return lost()
	}
	let parsed: unknown
	try {
		parsed = yamlParse(source)
	} catch (error) {
		const why = error instanceof Error ? error.message.split('\n')[0] : String(error)
		report('hooks', 'problem', `cannot be read as YAML (${why}), so none of it is loaded.`)
		return lost()
	}
	const block = isMapping(parsed) ? parsed.hooks : undefined
	// `hooks:` with nothing after it declared nothing.
	if (block === undefined || block === null) {
		return { hooks: {} as HooksConfig, count: 0, guardLost: false, problems }
	}
	if (!isMapping(block)) {
		report(
			'hooks',
			'problem',
			'must be a mapping of event to list of hooks, so none of it is loaded.',
		)
		return lost()
	}

	let guardLost = false
	const out: Record<string, unknown[]> = {}
	for (const [key, list] of Object.entries(block)) {
		const renamed = Object.hasOwn(RENAMED_PLUGIN_HOOK_EVENTS, key)
			? RENAMED_PLUGIN_HOOK_EVENTS[key]
			: undefined
		if (renamed !== undefined) {
			// A renamed event was written by someone who meant a guard as often as not.
			const guard = isGuardHookEvent(renamed as ShellHookEvent)
			report(
				key,
				guard ? 'problem' : 'note',
				`was renamed; name it \`${renamed}\`, so none of its hooks will run${guard ? ' and what they were meant to guard is not checked' : ''}.`,
			)
			if (guard) guardLost = true
			continue
		}
		const target = hookEventForKey(key)
		if (target === undefined) {
			report(key, 'note', `${unknownEventMessage()}.`)
			continue
		}
		if (!Array.isArray(list)) {
			const guard = isGuardHookEvent(target)
			report(
				key,
				guard ? 'problem' : 'note',
				`must be a list of hooks, so none of them will run${guard ? ' and what they were meant to guard is not checked' : ''}.`,
			)
			if (guard) guardLost = true
			continue
		}
		out[key] = list
	}

	const hooks: Record<string, unknown[]> = {}
	for (const [key, list] of Object.entries(out)) {
		const target = hookEventForKey(key) as ShellHookEvent
		const guard = isGuardHookEvent(target)
		const elements: unknown[] = [...list]
		// One read of the whole list says what is wrong in the first element
		// that cannot be read; that element is set aside (an empty group keeps
		// the others' positions) and the list is read again.
		for (let attempt = 0; attempt <= list.length; attempt += 1) {
			try {
				const read = withHookProblemSink(
					(event, severity, message) => report(event, severity, message),
					() => readConfigKey('hooks', { [key]: elements }, file),
				) as Record<string, unknown[]>
				for (const [event, entries] of Object.entries(read)) {
					hooks[event] = [...(hooks[event] ?? []), ...entries]
				}
				break
			} catch (error) {
				if (!(error instanceof ConfigValueError)) {
					report(key, guard ? 'problem' : 'note', 'cannot be read, so none of its hooks will run.')
					if (guard) guardLost = true
					break
				}
				const index = /^hooks\.[^[]*\[(\d+)\]/.exec(error.settingPath)?.[1]
				const tail = tailOf(error)
				if (index === undefined) {
					report(key, guard ? 'problem' : 'note', `${tail}, so none of its hooks will run.`)
					if (guard) guardLost = true
					break
				}
				report(
					key,
					guard ? 'problem' : 'note',
					`entry ${Number(index) + 1}: ${tail}, so it will not run${guard ? ' and what it was meant to guard is not checked' : ''}.`,
				)
				if (guard) guardLost = true
				elements[Number(index)] = { hooks: [] }
			}
		}
	}

	let count = 0
	for (const entries of Object.values(hooks)) {
		for (const entry of entries as Record<string, unknown>[]) {
			count += 1
			for (const field of ['matcher', 'if'] as const) {
				const value = entry[field]
				if (typeof value === 'string' && value.length > MAX_SKILL_HOOK_MATCHER_CHARS) {
					report(
						'hooks',
						'problem',
						`an entry's "${field}" is ${value.length} characters long, more than the ${MAX_SKILL_HOOK_MATCHER_CHARS} ${carrier === 'skill' ? 'a skill' : 'an agent file'} may carry, so none of its hooks are loaded.`,
					)
					return lost()
				}
			}
		}
	}
	if (count > MAX_SKILL_HOOK_ENTRIES) {
		report(
			'hooks',
			'problem',
			`has ${count} hooks, more than the ${MAX_SKILL_HOOK_ENTRIES} ${carrier === 'skill' ? 'a skill' : 'an agent file'} may carry, so none of them are loaded.`,
		)
		return lost()
	}
	// Whatever the reader called a problem (a hook lost on a guarding event) is a guard lost.
	return {
		hooks: hooks as unknown as HooksConfig,
		count,
		guardLost: guardLost || problems.some((problem) => problem.severity === 'problem'),
		problems,
	}
}
