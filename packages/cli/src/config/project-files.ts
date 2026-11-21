/**
 * The settings files a project folder carries, by name and layer.
 *
 * Two layers live in the folder, both read only once the folder is trusted:
 *
 * - The project layer is the folder's shared settings, meant to be checked in:
 *   `namzu.config.json` at the top of the folder and `.namzu/settings.json`.
 *   They hold the same keys. Both are read; where both set a key,
 *   `.namzu/settings.json` wins, and `namzu doctor` and `/status` say that both
 *   are there so a person can keep one.
 * - The local layer is this computer's settings for the folder, kept out of
 *   git: `.namzu/settings.local.json`, where a "don't ask again" answer and
 *   `/permissions add` are written. `namzu.config.local.json` at the top of the
 *   folder is the name an earlier Namzu wrote. It is still read, under the new
 *   file, until a session in the trusted folder moves it
 *   (`permissions/local-settings.ts`), and it is not read again once it holds
 *   exactly what the new file holds.
 *
 * Every reader of the folder's files (the loader, the trust screen, `/hooks`,
 * `namzu doctor`, the settings layers) takes the list from here, so they cannot
 * disagree about which files there are. All of them sit in the working folder,
 * the same folder trust is decided for.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

/** The project's shared file at the top of the folder. */
export const PROJECT_CONFIG_FILE = 'namzu.config.json'
/** The project's shared file inside the folder's `.namzu` directory, over `namzu.config.json`. */
export const PROJECT_SETTINGS_FILE = '.namzu/settings.json'
/** This computer's file for the folder; where remembered answers are written. */
export const LOCAL_SETTINGS_FILE = '.namzu/settings.local.json'
/** The local file's earlier name and place, still read until its content moves. */
export const LEGACY_LOCAL_CONFIG_FILE = 'namzu.config.local.json'

export type FolderFileLayer = 'project' | 'local'

export interface FolderConfigFile {
	/** The name relative to the folder, with `/`, as a person reads it. */
	readonly name: string
	readonly path: string
	readonly layer: FolderFileLayer
	/** The earlier name of the local file. */
	readonly legacy: boolean
}

function file(cwd: string, name: string, layer: FolderFileLayer, legacy = false): FolderConfigFile {
	return { name, path: resolve(cwd, ...name.split('/')), layer, legacy }
}

/** The project layer's files, lowest first: `namzu.config.json`, then `.namzu/settings.json`. */
export function projectConfigFiles(cwd: string): readonly FolderConfigFile[] {
	return [file(cwd, PROJECT_CONFIG_FILE, 'project'), file(cwd, PROJECT_SETTINGS_FILE, 'project')]
}

/** Both local files, lowest first, whatever they hold. */
export function allLocalConfigFiles(cwd: string): readonly FolderConfigFile[] {
	return [
		file(cwd, LEGACY_LOCAL_CONFIG_FILE, 'local', true),
		file(cwd, LOCAL_SETTINGS_FILE, 'local'),
	]
}

/**
 * The local layer's files to read, lowest first. The earlier file is left out
 * when it holds the same settings as the new one: a move whose last step (the
 * removal) did not happen would otherwise attach every hook in it twice.
 */
export function localConfigFiles(cwd: string): readonly FolderConfigFile[] {
	const [legacy, current] = allLocalConfigFiles(cwd) as [FolderConfigFile, FolderConfigFile]
	return sameSettingsFiles(legacy.path, current.path) ? [current] : [legacy, current]
}

/** Every file of the folder, in cascade order: the project layer, then the local layer. */
export function folderConfigFiles(cwd: string): readonly FolderConfigFile[] {
	return [...projectConfigFiles(cwd), ...localConfigFiles(cwd)]
}

/** Every file of the folder, the earlier local file included even when it is a copy. */
export function allFolderConfigFiles(cwd: string): readonly FolderConfigFile[] {
	return [...projectConfigFiles(cwd), ...allLocalConfigFiles(cwd)]
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

function parsed(text: string): { readonly value: unknown } | undefined {
	try {
		return { value: JSON.parse(text.replace(/^﻿/, '')) }
	} catch {
		return undefined
	}
}

/** Whether two JSON texts hold the same settings, key order aside. Unreadable text never matches. */
export function sameSettings(a: string, b: string): boolean {
	const left = parsed(a)
	const right = parsed(b)
	return left !== undefined && right !== undefined && isDeepStrictEqual(left.value, right.value)
}

/** Whether both files exist and hold the same settings. */
export function sameSettingsFiles(a: string, b: string): boolean {
	const left = readText(a)
	if (left === undefined) return false
	const right = readText(b)
	return right !== undefined && sameSettings(left, right)
}

/**
 * The folder a file's relative path rules are read against: the project folder
 * for a file inside its `.namzu` directory, the file's own folder otherwise.
 */
export function folderFileRoot(path: string): string {
	const parent = dirname(resolve(path))
	return /(?:^|[\\/])\.namzu$/.test(parent) && /(?:^|[\\/])settings(?:\.local)?\.json$/.test(path)
		? dirname(parent)
		: parent
}

/** Whether a path names one of a folder's settings files (any of the four names). */
export function isFolderConfigPath(path: string): boolean {
	return /(?:^|[\\/])(?:namzu\.config(?:\.local)?\.json|\.namzu[\\/]settings(?:\.local)?\.json)$/.test(
		path,
	)
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

/** The files of `layer` that exist in the folder, lowest first. Looks at names only, never contents. */
export function presentFolderFiles(
	cwd: string,
	layer: FolderFileLayer,
): readonly FolderConfigFile[] {
	const files = layer === 'project' ? projectConfigFiles(cwd) : allLocalConfigFiles(cwd)
	return files.filter((one) => isFile(one.path))
}

/**
 * One sentence for each layer that has both of its files, saying that both are
 * read and which one to keep; empty when each layer has at most one. It reads
 * the two local files to tell a moved copy from a second file, so it is for a
 * trusted folder only.
 */
export function bothFilesNotes(cwd: string): string[] {
	const notes: string[] = []
	if (presentFolderFiles(cwd, 'project').length === 2) {
		notes.push(
			`Both ${PROJECT_CONFIG_FILE} and ${PROJECT_SETTINGS_FILE} are read: the rules and hooks of both apply, and ${PROJECT_SETTINGS_FILE} wins any other setting both set. Keep one: move the settings into ${PROJECT_SETTINGS_FILE} and delete ${PROJECT_CONFIG_FILE}, or the other way round.`,
		)
	}
	const local = allLocalConfigFiles(cwd)
	if (presentFolderFiles(cwd, 'local').length === 2) {
		const [legacy, current] = local as [FolderConfigFile, FolderConfigFile]
		if (!sameSettingsFiles(legacy.path, current.path))
			notes.push(
				`Both ${LEGACY_LOCAL_CONFIG_FILE} and ${LOCAL_SETTINGS_FILE} are read: the rules and hooks of both apply, and ${LOCAL_SETTINGS_FILE} wins any other setting both set. Move what you keep into ${LOCAL_SETTINGS_FILE} and delete ${LEGACY_LOCAL_CONFIG_FILE}.`,
			)
	}
	return notes
}
