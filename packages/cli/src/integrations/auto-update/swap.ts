/**
 * Replacing the install folder while a window runs from it.
 *
 * A running process reads some of its own files only when it first needs them: the bundle is a
 * tree of hash-named chunks under `dist/chunks`. So the new version is never installed into the
 * live folder. It is installed into a side folder on the same filesystem; every chunk of the live
 * folder that the new one lacks is carried into it (a chunk's name carries a hash of its content,
 * so an old and a new file never share a name unless they are the same file); and the two folders
 * trade places with two renames. A window that started before keeps loading its own chunks from
 * the same path, and the next start runs the new version.
 *
 * What stays true of a swap and cannot be removed: between the two renames the path is absent for a
 * few microseconds, and a window that loads a file in exactly that moment gets the "installed while
 * this window was open" line from `replaced-install.ts` instead of a crash. The layouts where a
 * swap is not safe (Windows, where a running program locks its files; a prefix on another
 * filesystem; a folder whose chunks are not hash-named) keep the older way: the install waits until
 * the last window closes.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { InstallKind } from './install-kind.js'
import { carriedHostName, versionOnDisk } from './replaced-install.js'
import { listRunning } from './running.js'

/** The record of chunks carried into a folder from the ones it replaced. */
export const CARRIED_FILE = join('dist', '.carried-chunks.json')

/** esbuild names a chunk `<name>-<8 characters of a content hash>.js` (and `.js.map`). */
const HASHED_CHUNK = /-[A-Z0-9]{8}\.js(?:\.map)?$/

type Npm = Extract<InstallKind, { kind: 'npm-global' }>

/**
 * Whether an install can be swapped under a running window. False means "wait until the last window
 * closes", never "give up": Windows (a running program holds its files), another layout than an npm
 * prefix, a folder Namzu may not write, a package folder and prefix on different filesystems, and a
 * chunks folder with a file whose name is not content-hashed (that name could collide).
 */
export function canSwapInstall(
	install: InstallKind,
	platform: NodeJS.Platform,
): install is Npm & { readonly writable: true } {
	if (platform === 'win32' || install.kind !== 'npm-global' || !install.writable) return false
	try {
		if (statSync(dirname(install.root)).dev !== statSync(install.prefix).dev) return false
		const chunks = readdirSync(join(install.root, 'dist', 'chunks'))
		return (
			chunks.length > 0 && chunks.every((name) => HASHED_CHUNK.test(name) || name.startsWith('.'))
		)
	} catch {
		return false
	}
}

/** Where the new version's folder is built, next to the live one. */
export function nextFolder(root: string, pid: number): string {
	return join(dirname(root), `.cli-next-${pid}`)
}

/** Where the live folder goes during a swap. */
export function asideFolder(root: string, pid: number): string {
	return join(dirname(root), `.cli-aside-${pid}`)
}

/** The side prefix the package manager installs the new version into. */
export function stagePrefix(prefix: string, pid: number): string {
	return join(prefix, `.namzu-stage-${pid}`)
}

/** The package folder a global npm install into `stage` creates. */
export function stagedPackage(stage: string): string {
	return join(stage, 'lib', 'node_modules', '@namzu', 'cli')
}

/** The parsing child script of the bundle, and the name an older copy of it is carried under. */
const HOST_SCRIPT = 'analysis-host.js'
const CARRIED_HOST = /^analysis-host\.[0-9A-Za-z.+-]+\.js$/

interface Carried {
	/** Names under `dist/chunks`. */
	readonly files: string[]
	/** Names under `dist`: the parsing child script of an older version. */
	readonly hosts: string[]
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : []
}

async function carriedBefore(root: string): Promise<Carried> {
	try {
		const parsed = JSON.parse(readFileSync(join(root, CARRIED_FILE), 'utf8')) as {
			files?: unknown
			hosts?: unknown
		}
		return { files: strings(parsed.files), hosts: strings(parsed.hosts) }
	} catch {
		return { files: [], hosts: [] }
	}
}

async function linkOrCopy(from: string, to: string): Promise<void> {
	try {
		await link(from, to)
	} catch {
		await copyFile(from, to)
	}
}

/**
 * Put every chunk of `live` that `next` lacks into `next`, by hard link (a copy where links are not
 * possible). Everything already carried into `live` is carried on, so a window left open across two
 * updates keeps its files. Returns the names carried.
 */
export async function carryChunks(live: string, next: string): Promise<string[]> {
	const from = join(live, 'dist', 'chunks')
	const to = join(next, 'dist', 'chunks')
	await mkdir(to, { recursive: true })
	const carried: string[] = []
	for (const name of await readdir(from)) {
		if (name.startsWith('.') || existsSync(join(to, name))) continue
		await linkOrCopy(join(from, name), join(to, name))
		carried.push(name)
	}
	// The parsing child is started by path (`dist/analysis-host.js`) the first time a window needs
	// it, so a window that started before the swap would otherwise start the new version's script
	// against its own older code. Keep the live script under its version's name, and keep the ones
	// already carried, so that window can start its own.
	const hosts: string[] = []
	const liveVersion = versionOnDisk(live)
	const liveHost = join(live, 'dist', HOST_SCRIPT)
	if (liveVersion !== null && existsSync(liveHost)) {
		const name = carriedHostName(liveVersion)
		await linkOrCopy(liveHost, join(next, 'dist', name))
		hosts.push(name)
	}
	for (const name of (await carriedBefore(live)).hosts) {
		const source = join(live, 'dist', name)
		if (hosts.includes(name) || !existsSync(source) || !CARRIED_HOST.test(name)) continue
		await linkOrCopy(source, join(next, 'dist', name))
		hosts.push(name)
	}
	await writeFile(join(next, CARRIED_FILE), `${JSON.stringify({ files: carried, hosts })}\n`)
	return carried
}

export type SwapOutcome = 'swapped' | 'rolled-back'

/**
 * Trade places: `live` goes to `aside`, `next` becomes `live`. `check` looks at the new folder in its
 * place; when it says no, or throws, the folders trade back and the result is `rolled-back`. Throws
 * only when a rename itself fails, after putting back whatever it moved.
 */
export async function swapFolders(input: {
	readonly live: string
	readonly next: string
	readonly aside: string
	readonly check: (live: string) => Promise<boolean>
}): Promise<SwapOutcome> {
	const { live, next, aside } = input
	// Two synchronous renames, one right after the other, so the path is absent for as short a time
	// as the operating system allows (an awaited call would let the event loop run in between).
	renameSync(live, aside)
	try {
		renameSync(next, live)
	} catch (error) {
		renameSync(aside, live)
		throw error
	}
	let healthy = false
	try {
		healthy = await input.check(live)
	} catch {
		healthy = false
	}
	if (healthy) return 'swapped'
	renameSync(live, next)
	renameSync(aside, live)
	return 'rolled-back'
}

/** Remove a leftover folder; never throws. */
export async function removeFolder(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true })
	} catch {
		// A folder that cannot be removed now is removed by the next start.
	}
}

/**
 * Housekeeping at start: remove what an earlier swap left that nothing uses any more.
 *
 * - Folders of a swap whose process is gone (`.cli-next-<pid>`, `.cli-aside-<pid>`,
 *   `.namzu-stage-<pid>`).
 * - The carried chunks, once every live window runs the version on disk. A window of an older
 *   version still needs them, so they stay until the last such window ends.
 *
 * Never throws.
 */
export async function pruneAfterSwap(
	install: InstallKind,
	options: {
		readonly onDisk: string
		readonly isAlive?: (pid: number) => boolean
	},
): Promise<void> {
	if (install.kind !== 'npm-global') return
	try {
		const alive = options.isAlive ?? ((pid: number) => pidAlive(pid))
		const leftovers: [string, RegExp][] = [
			[dirname(install.root), /^\.cli-(?:next|aside)-(\d+)$/],
			[install.prefix, /^\.namzu-stage-(\d+)$/],
		]
		for (const [dir, pattern] of leftovers) {
			let names: string[] = []
			try {
				names = await readdir(dir)
			} catch {
				continue
			}
			for (const name of names) {
				const pid = pattern.exec(name)?.[1]
				if (pid !== undefined && !alive(Number(pid))) await removeFolder(join(dir, name))
			}
		}
		const running = listRunning(install, {
			...(options.isAlive ? { isAlive: options.isAlive } : {}),
		})
		if (running.some((entry) => entry.version !== options.onDisk)) return
		const { files, hosts } = await carriedBefore(install.root)
		if (files.length === 0 && hosts.length === 0) return
		for (const name of files) {
			await rm(join(install.root, 'dist', 'chunks', name), { force: true })
		}
		for (const name of hosts) {
			if (CARRIED_HOST.test(name)) await rm(join(install.root, 'dist', name), { force: true })
		}
		await rm(join(install.root, CARRIED_FILE), { force: true })
	} catch {
		// Housekeeping that cannot finish is tried again at the next start.
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}
