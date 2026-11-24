/**
 * Built-in skills that no longer ship, and the one line that answers a request
 * for one by name.
 *
 * A person who typed `/verify-change`, or a model that asks the `skill` tool for
 * it from habit or from an old note, should be told what replaced it instead of
 * "unknown command" or a list of names to guess from. A skill of that name a
 * person or project wrote is found first and is never answered with this line.
 */

import type { Skill } from '@namzu/sdk'

export const RETIRED_BUILTIN_SKILLS: Readonly<Record<string, string>> = {
	'verify-change':
		'verify-change was replaced by /run, which starts the app and uses it to see the change working; run the project’s own check as a command of its own afterwards.',
}

/** The one-line answer for a retired built-in name, or undefined for any other name. */
export function retiredSkillNotice(name: string): string | undefined {
	return Object.hasOwn(RETIRED_BUILTIN_SKILLS, name) ? RETIRED_BUILTIN_SKILLS[name] : undefined
}

/**
 * What the `skill` tool loads for a retired name: a body of that one line, so
 * the model reads it and loads `run`. Never listed in the manifest or by name.
 */
export function retiredSkill(name: string, dirPath: string): Skill | undefined {
	const notice = retiredSkillNotice(name)
	if (notice === undefined) return undefined
	return {
		metadata: {
			name,
			description: `Retired. ${notice}`,
			invocation: 'model',
		},
		body: notice,
		dirPath,
	}
}
