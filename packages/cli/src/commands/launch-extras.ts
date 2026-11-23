/**
 * The launch flags that shape what a run starts with: `--system-prompt`,
 * `--tools`, `--bare` and `--settings`. The interactive launcher, `exec` and
 * `exec --json` all read them through these functions, so a flag one of them
 * applies is applied by the others the same way.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { type LaunchSettingsLayer, launchSettingsLayer } from '../config/load.js'
import { splitToolList, toolKey } from '../permissions/tool-flags.js'
import { MAX_APPEND_SYSTEM_CHARS } from './append-system.js'

/** Characters of replacement system prompt one run may carry. */
export const MAX_SYSTEM_PROMPT_CHARS = MAX_APPEND_SYSTEM_CHARS

export type SystemPromptResult = { readonly text: string } | { readonly error: string } | undefined

/** The system prompt a `--system-prompt <text|@file>` value names, or why it cannot be used. */
export function resolveSystemPromptFlag(
	raw: string | null,
	base: string = process.cwd(),
): SystemPromptResult {
	if (raw === null) return undefined
	let text = raw
	if (raw.startsWith('@')) {
		const requested = raw.slice(1).trim()
		if (!requested) return { error: '--system-prompt @ needs a file name after the @' }
		const path = resolve(base, requested)
		try {
			if (!statSync(path).isFile()) return { error: `--system-prompt ${path} is not a file` }
			text = readFileSync(path, 'utf8')
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			return { error: `--system-prompt could not read ${path}: ${reason}` }
		}
	}
	text = text.trim()
	if (!text) return { error: '--system-prompt is empty' }
	if (text.length > MAX_SYSTEM_PROMPT_CHARS)
		return {
			error: `--system-prompt is ${text.length.toLocaleString('en-US')} characters; the limit is ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString('en-US')}`,
		}
	return { text }
}

/**
 * The tool names a `--tools <list>` value leaves on offer. Undefined means no
 * restriction (`default`, or the flag was not given); an empty list means no
 * tools at all.
 */
export type ToolsResult =
	| { readonly only: readonly string[] | undefined }
	| { readonly error: string }

export function resolveToolsFlag(raw: string | null | undefined): ToolsResult {
	if (raw === null || raw === undefined) return { only: undefined }
	const { items, unbalanced } = splitToolList(raw.trim())
	if (unbalanced || items.some((item) => item.includes('(') || item.includes(')')))
		return {
			error:
				'--tools takes tool names only, such as "read edit bash". A rule for some calls of a tool goes in --allowed-tools.',
		}
	if (items.length === 1 && items[0]?.toLowerCase() === 'default') return { only: undefined }
	if (items.some((item) => item.toLowerCase() === 'default'))
		return {
			error:
				'--tools default stands alone: it offers every tool, so it cannot be listed with others.',
		}
	return { only: [...new Set(items.map(toolKey))] }
}

/**
 * What `--bare` turns off, as the settings it overrides for this launch. The
 * settings layer carries these so the rest of the program reads them the way it
 * reads any setting; what a setting cannot express (project instruction files,
 * the saved memory notes) is switched off by the session option `bare`.
 */
export const BARE_SETTINGS: Readonly<Record<string, unknown>> = {
	disableHooks: true,
	plugins: { enabled: false },
	memory: { recall: false },
	learningObservations: false,
	learningGenerator: false,
	modelCatalogueRefresh: false,
	updates: { check: false, auto: false },
	skills: { suggest: false },
	codeAnalysis: { enabled: false },
}

/** `--settings <file-or-json>`: the layer it names, or one line saying what is wrong. */
export function readSettingsFlag(
	raw: string,
	base: string = process.cwd(),
): LaunchSettingsLayer | { readonly error: string } {
	const value = raw.trim()
	if (!value) return { error: '--settings needs a JSON file or a JSON object.' }
	let text: string
	let label: string
	if (value.startsWith('{')) {
		text = value
		label = '--settings'
	} else {
		const path = resolve(base, value)
		try {
			if (!statSync(path).isFile()) return { error: `--settings ${path} is not a file.` }
			text = readFileSync(path, 'utf8')
		} catch {
			return { error: `--settings could not read ${path}.` }
		}
		label = `--settings ${value}`
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
	} catch {
		return {
			error: `${label} is not valid JSON. Give a JSON object, or the path of a file that holds one.`,
		}
	}
	try {
		return launchSettingsLayer(label, parsed)
	} catch (error) {
		const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
		return { error: message ?? `${label} could not be read.` }
	}
}

/** The layers `--bare` and `--settings` add, lowest first, or the first thing wrong. */
export function launchLayersFor(
	flags: { readonly bare?: boolean; readonly settings?: string },
	base: string = process.cwd(),
): { readonly layers: readonly LaunchSettingsLayer[] } | { readonly error: string } {
	const layers: LaunchSettingsLayer[] = []
	if (flags.bare === true) layers.push(launchSettingsLayer('--bare', BARE_SETTINGS))
	if (flags.settings !== undefined) {
		const layer = readSettingsFlag(flags.settings, base)
		if ('error' in layer) return layer
		layers.push(layer)
	}
	return { layers }
}
