/**
 * `/skills save off|on`: write `skills.suggest` to the user config, then read
 * the whole cascade back and say whether the value will take effect.
 *
 * The `skills` table merges key by key across the cascade, so only a project
 * file, a selected profile or the managed file that sets `skills.suggest`
 * itself outranks the user file (the environment never sets it). Writing the
 * user file and saying "done" would then be false the next time namzu starts.
 * The running session follows the operator's choice either way; the message
 * says so, and names the file that wins later.
 */

import { formatConfigSource } from '../../config/debug.js'
import { type LoadConfigOptions, loadConfigWithProvenance } from '../../config/load.js'
import { setUserConfigValue } from '../../config/user-config.js'
import { explainFailure } from '../plain-failure.js'

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
			message: `${explainFailure(error, 'Could not save that setting.')} This conversation ${on ? 'suggests skills' : 'stops suggesting skills'} until it ends.`,
		}
	}
	const saved = on
		? 'Skill suggestions are on: after a multi-step task you will be offered /skills save.'
		: 'Skill suggestions are off. /skills save on turns them back on. /skills save and /skills new still work.'
	let resolved: ReturnType<typeof loadConfigWithProvenance>
	try {
		resolved = loadConfigWithProvenance(opts)
	} catch (error) {
		return {
			file,
			message: `${saved} ${explainFailure(error, 'Could not check the other config files.')} A project, profile or managed skills block may still override it when namzu next starts; this conversation follows your choice.`,
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
		message: `${saved} But a stronger config layer sets suggest under skills itself (the strongest skills block is in ${winner}), so from the next start suggestions will be ${effective ? 'on' : 'off'}. Set suggest: ${value} under skills there to make it stick; this conversation follows your choice.`,
	}
}
