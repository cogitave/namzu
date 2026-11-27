/**
 * Which files the engine may be asked to read when the person adds a skill. A path counts only
 * when it came from a gesture main saw (the file dialog, the folder dialog, a drop whose path the
 * preload read with `webUtils.getPathForFile`) and passed a `lstat` check: a regular file within
 * 30 MB, or a folder, never a link. The page names paths only to take them back; a path it made up
 * was never registered and is refused. The engine checks everything again.
 */

import { lstat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

export const SKILL_PATH_FILE_MAX_BYTES = 30 * 1024 * 1024
export const SKILL_PATHS_MAX = 20
/** Paths remembered per window before the oldest is forgotten. */
const REGISTERED_MAX = 64
const EXTENSIONS = new Set(['.zip', '.skill', '.md'])

export const OTHER_FILE_SYSTEM_MESSAGE =
	"This engine cannot read that file. Use a file on the engine's computer."

/** One thing the person chose. `error` set means it was not registered and cannot be added. */
export interface SkillPathChoice {
	fileName: string
	path?: string
	kind?: 'file' | 'folder'
	error?: string
}

export type SkillPathStat = (path: string) => Promise<{
	isFile(): boolean
	isDirectory(): boolean
	isSymbolicLink(): boolean
	size: number
}>

/** `file` or `folder` when the path may be added, otherwise the sentence that says why not. */
export async function checkSkillPath(
	path: string,
	stat: SkillPathStat = lstat,
): Promise<{ kind: 'file' | 'folder' } | { error: string }> {
	if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096)
		return { error: 'That path cannot be used.' }
	let info: Awaited<ReturnType<SkillPathStat>>
	try {
		info = await stat(path)
	} catch {
		return { error: `${basename(path)} could not be read.` }
	}
	if (info.isSymbolicLink())
		return {
			error: `${basename(path)} is a link. Skills are added as plain files and folders only.`,
		}
	if (info.isDirectory()) return { kind: 'folder' }
	if (!info.isFile()) return { error: `${basename(path)} is not a file or a folder.` }
	if (!EXTENSIONS.has(extname(path).toLowerCase()))
		return {
			error: 'Skill files must have a .skill, .zip, or .md file extension.',
		}
	if (info.size > SKILL_PATH_FILE_MAX_BYTES)
		return { error: 'Skill file is too large. Maximum size is 30 MB.' }
	return { kind: 'file' }
}

/**
 * The path as an engine on another file system reads it. A Windows drive path becomes the mount
 * WSL gives it; a path inside a WSL distribution's share becomes the distribution's own path;
 * anything else (a network share, a path the other side has no name for) is refused.
 */
export function enginePath(
	path: string,
	engine: 'local' | 'wsl',
	distro?: string,
): { path: string } | { error: string } {
	if (engine === 'local') return { path }
	const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path)
	if (drive)
		return {
			path: `/mnt/${(drive[1] as string).toLowerCase()}/${(drive[2] as string).replace(/\\/g, '/')}`,
		}
	const share = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.*)$/i.exec(path)
	if (share) {
		// A path in another distribution names a different file system than the engine reads.
		if (distro !== undefined && (share[1] as string).toLowerCase() !== distro.toLowerCase())
			return { error: OTHER_FILE_SYSTEM_MESSAGE }
		return { path: `/${(share[2] as string).replace(/\\/g, '/')}` }
	}
	return { error: OTHER_FILE_SYSTEM_MESSAGE }
}

export interface SkillPathRegistry {
	/** Checks and remembers what the person chose in window `windowId`. */
	register(windowId: string, paths: readonly string[]): Promise<SkillPathChoice[]>
	/** The engine's spelling of each path, once each was registered for this window. A path stays
	 * registered until the window closes or newer choices push it out, so the page can stage again. */
	take(windowId: string, paths: unknown): { paths: string[] } | { error: string }
	/** The window is gone. */
	forget(windowId: string): void
}

export function createSkillPathRegistry(
	options: {
		stat?: SkillPathStat
		engine?: () => 'local' | 'wsl'
		/** The WSL distribution the engine runs in, when known. */
		distro?: () => string | undefined
	} = {},
): SkillPathRegistry {
	const known = new Map<string, Set<string>>()
	return {
		async register(windowId, paths) {
			const out: SkillPathChoice[] = []
			const set = known.get(windowId) ?? new Set<string>()
			for (const path of paths.slice(0, SKILL_PATHS_MAX)) {
				const fileName = typeof path === 'string' ? basename(path) || path : 'file'
				const checked = await checkSkillPath(path, options.stat)
				if ('error' in checked) {
					out.push({ fileName, error: checked.error })
					continue
				}
				set.delete(path)
				set.add(path)
				while (set.size > REGISTERED_MAX) {
					const oldest = set.values().next().value
					if (oldest === undefined) break
					set.delete(oldest)
				}
				out.push({ fileName, path, kind: checked.kind })
			}
			known.set(windowId, set)
			return out
		},
		take(windowId, paths) {
			if (
				!Array.isArray(paths) ||
				paths.length < 1 ||
				paths.length > SKILL_PATHS_MAX ||
				paths.some((p) => typeof p !== 'string')
			)
				return { error: 'Choose between 1 and 20 skills.' }
			const set = known.get(windowId)
			if (!set || paths.some((p) => !set.has(p as string)))
				return { error: 'Choose the file again.' }
			const forwarded: string[] = []
			for (const path of paths as string[]) {
				const translated = enginePath(path, options.engine?.() ?? 'local', options.distro?.())
				if ('error' in translated) return translated
				forwarded.push(translated.path)
			}
			return { paths: forwarded }
		},
		forget(windowId) {
			known.delete(windowId)
		},
	}
}
