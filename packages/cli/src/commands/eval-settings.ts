/**
 * The settings file `namzu eval --settings <file>` reads.
 *
 * It has the shape of the user's config, limited to what is safe to vary in an
 * eval: the settings that shape how the kernel behaves. A key that is not a
 * setting at all is refused as unknown, and a key that is a setting but holds a
 * credential, runs a command, reaches the network or only changes how the
 * terminal looks is refused as not allowed here. Each value is checked by the
 * loader's own reader, so a value that would stop Namzu starting stops the
 * eval too, with the same sentence.
 */

import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'

import { buildSettingsSnapshot, isEvalUsageError, validateSettingsName } from '@namzu/sdk'
import type { SettingsSnapshot } from '@namzu/sdk'
import { parse as yamlParse } from 'yaml'

import { CONFIG_KEYS, readConfigKey, takeConfigWarnings } from '../config/load.js'

/** The top-level settings an eval may vary. */
export const EVAL_SETTINGS_KEYS: readonly string[] = [
	'compaction',
	'goal',
	'handBack',
	'limits',
	'memory',
	'model',
	'refusalFallback',
	'routing',
	'smallModel',
	'workflow',
]

export class EvalSettingsError extends Error {}

/** Read, check and snapshot a settings file. Throws {@link EvalSettingsError} with a sentence for a person. */
export async function readEvalSettings(
	path: string,
	name: string | undefined,
	warn: (line: string) => void,
): Promise<SettingsSnapshot> {
	const full = isAbsolute(path) ? path : resolve(process.cwd(), path)
	let text: string
	try {
		text = await readFile(full, 'utf-8')
	} catch (err) {
		throw new EvalSettingsError(
			`Cannot read the settings file ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	let parsed: unknown
	try {
		parsed = yamlParse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
	} catch {
		throw new EvalSettingsError(`${path} is not valid JSON or YAML.`)
	}
	// An empty file states no settings.
	if (parsed === null || parsed === undefined) parsed = {}
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new EvalSettingsError(`${path} must hold an object of settings, as the config file does.`)
	}

	const values: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!CONFIG_KEYS.includes(key)) {
			throw new EvalSettingsError(
				`${path}: "${key}" is not a Namzu setting. An eval settings file may set: ${EVAL_SETTINGS_KEYS.join(', ')}.`,
			)
		}
		if (!EVAL_SETTINGS_KEYS.includes(key)) {
			throw new EvalSettingsError(
				`${path}: "${key}" is a Namzu setting but not one an eval varies. It holds credentials, runs commands, reaches the network, or changes only how the terminal looks, and none of those belongs in what a report says about how the kernel behaved. An eval settings file may set: ${EVAL_SETTINGS_KEYS.join(', ')}.`,
			)
		}
		try {
			values[key] = readConfigKey(key, value, path)
		} catch (err) {
			throw new EvalSettingsError(err instanceof Error ? err.message : String(err))
		}
	}
	for (const line of takeConfigWarnings()) warn(line)

	const label = name ?? basename(full, extname(full))
	try {
		validateSettingsName(label)
		return buildSettingsSnapshot(
			label,
			JSON.parse(JSON.stringify(values)) as Record<string, unknown>,
		)
	} catch (err) {
		if (isEvalUsageError(err)) {
			throw new EvalSettingsError(
				name === undefined && !/credential|default/.test(err.message)
					? `${err.message}. The snapshot is named after the file; name it with --settings-name.`
					: err.message,
			)
		}
		throw err
	}
}
