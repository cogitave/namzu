/**
 * A skill the person ran by name attaches its hooks, as one the model loaded does.
 *
 * `/skills <name>`, `/<name>` and `--skills <name>` put a skill's instructions
 * in front of the model without the `skill` tool, so the hooks it carries have
 * to be attached here or they are lost without a word.
 */
import { dirname } from 'node:path'

import type { SkillsConfig } from '../config/schema.js'
import { type SkillInfo, discoverSkills } from './store.js'

/** What a session says it can do with a skill's hooks; `AgentSession.skillHooks` is one. */
export interface SkillHooksPort {
	readonly use: (skill: {
		readonly name: string
		readonly dirPath: string
		readonly hooksSource: string
	}) => void
}

/** The skill, as the port takes it, when it carries hooks. */
export function hooksOf(
	info: Pick<SkillInfo, 'name' | 'path' | 'hooksSource'>,
): { name: string; dirPath: string; hooksSource: string } | undefined {
	return info.hooksSource === undefined
		? undefined
		: { name: info.name, dirPath: dirname(info.path), hooksSource: info.hooksSource }
}

/**
 * Attach the hooks of the named skills that carry any. A session with no hook
 * runtime says so through `say`, once per skill, since the hooks cannot attach.
 */
export function useSkillHooksByName(
	port: SkillHooksPort | undefined,
	options: { readonly cwd: string; readonly skills?: SkillsConfig },
	names: readonly string[],
	say: (line: string) => void,
): void {
	if (names.length === 0) return
	const wanted = new Set(names)
	for (const info of discoverSkills({
		cwd: options.cwd,
		...(options.skills ? { config: options.skills } : {}),
	})) {
		if (!wanted.has(info.name) || info.problem !== undefined) continue
		const carried = hooksOf(info)
		if (!carried) continue
		if (!port) {
			say(
				`Skill ${info.name} carries hooks, but this session has no hook runtime, so they are not attached.`,
			)
			continue
		}
		port.use(carried)
	}
}
