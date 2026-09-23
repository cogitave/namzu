/**
 * `/skills save off|on`: write `skills.suggest` to the user config, then read
 * the whole cascade back and say whether the value will take effect.
 *
 * The cascade replaces a top-level key whole, so a `skills` block in the
 * project file, a selected profile or the managed file hides the user file's
 * `skills.suggest` entirely (and the environment never sets it). Writing the
 * user file and saying "done" would then be false the next time namzu starts.
 * The running session follows the operator's choice either way; the message
 * says so, and names the file that wins later.
 */

import { formatConfigSource } from '../../config/debug.js'
import { type LoadConfigOptions, loadConfigWithProvenance } from '../../config/load.js'
import { setUserConfigValue } from '../../config/user-config.js'

export interface SkillSuggestionsWrite {
	/** The user config written, or absent when the write failed. */
	readonly file?: string
	/** What `skills.suggest` resolves to from the files after the write, when it could be read. */
	readonly effective?: boolean
	/** The sentence for the transcript. */
	readonly message: string
}

export function setSkillSuggestions(
	on: boolean,
	opts: Pick<LoadConfigOptions, 'cwd' | 'env' | 'home' | 'profile' | 'managedPath'> = {},
): SkillSuggestionsWrite {
	const value = on ? 'true' : 'false'
	let file: string
	try {
		file = setUserConfigValue(['skills', 'suggest'], on, {
			...(opts.home ? { home: opts.home } : {}),
			...(opts.env ? { env: opts.env } : {}),
		})
	} catch (error) {
		return {
			message: `Could not save skills.suggest: ${error instanceof Error ? error.message : String(error)} This session ${on ? 'suggests skills' : 'stops suggesting skills'} until it ends.`,
		}
	}
	const saved = on
		? `Skill suggestions are on: after a multi-step task you will be offered /skills save. Saved skills.suggest: ${value} to ${file}.`
		: `Skill suggestions are off. Saved skills.suggest: ${value} to ${file}; /skills save on turns them back on. /skills save and /skills new still work.`
	let resolved: ReturnType<typeof loadConfigWithProvenance>
	try {
		resolved = loadConfigWithProvenance(opts)
	} catch (error) {
		return {
			file,
			message: `${saved} Could not check the other config files (${error instanceof Error ? error.message : String(error)}), so a project, profile or managed skills block may still override it when namzu next starts; this session follows your choice.`,
		}
	}
	const effective = resolved.config.skills?.suggest ?? true
	if (effective === on) return { file, effective, message: saved }
	const source = resolved.provenance.skills
	const winner =
		source && source.kind !== 'user-file' && source.kind !== 'default'
			? formatConfigSource(source)
			: 'another config layer'
	return {
		file,
		effective,
		message: `${saved} But ${winner} sets its own skills block, which replaces the user file's, so from the next start skills.suggest will be ${effective ? 'true' : 'false'}. Add suggest: ${value} under skills there to make it stick; this session follows your choice.`,
	}
}
