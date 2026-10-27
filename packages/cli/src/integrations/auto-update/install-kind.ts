/**
 * How this copy of Namzu was installed, decided only from where the running
 * package sits. Namzu never guesses a package manager: a layout it does not
 * recognise is `unknown`, and only the layouts it owns are ever replaced.
 */

import { constants, accessSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'

import { npmGlobalPrefixFor } from '../npm-global.js'

export type InstallKind =
	/** `npm install --global`, including the installer's own `~/.namzu` prefix. */
	| {
			readonly kind: 'npm-global'
			readonly root: string
			readonly prefix: string
			/** The prefix is Namzu's own home (the installer fallback). */
			readonly owned: boolean
			readonly writable: boolean
	  }
	| {
			readonly kind: 'pnpm-global'
			readonly root: string
			/** `…/pnpm/global/<n>`: the folder pnpm keeps the global packages in. */
			readonly globalDir: string
			readonly writable: boolean
	  }
	/** A source checkout. Never updated. */
	| { readonly kind: 'development'; readonly root: string }
	/** `npx`, `pnpm dlx`, `bunx`: a throwaway copy; the next run is the update. */
	| { readonly kind: 'ephemeral'; readonly root: string }
	/** The copy inside the Desktop app, which moves only with the app. */
	| { readonly kind: 'desktop'; readonly root: string }
	| { readonly kind: 'unknown'; readonly root: string }

export interface ClassifyInstallInput {
	readonly packageRoot: string
	readonly platform: NodeJS.Platform
	/** The Namzu home, to tell the installer's own prefix from someone else's. */
	readonly namzuHome?: string
	readonly env?: NodeJS.ProcessEnv
	readonly isElectron?: boolean
	readonly exists?: (path: string) => boolean
	readonly writable?: (path: string) => boolean
}

function writableDir(path: string): boolean {
	try {
		accessSync(path, constants.W_OK)
		return true
	} catch {
		return false
	}
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	const paths = platform === 'win32' ? win32 : posix
	const left = paths.resolve(a)
	const right = paths.resolve(b)
	return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

const PNPM_GLOBAL = /^(.*[\\/]pnpm[\\/]global[\\/]\d+)[\\/]\.pnpm[\\/]/i

/** The `…/pnpm/global/<n>` folder a pnpm-global package root sits in, or null. */
export function pnpmGlobalDirFor(packageRoot: string): string | null {
	return PNPM_GLOBAL.exec(packageRoot)?.[1] ?? null
}

export function classifyInstall(input: ClassifyInstallInput): InstallKind {
	const exists = input.exists ?? existsSync
	const canWrite = input.writable ?? writableDir
	const root = input.packageRoot
	const platform = input.platform

	if (input.isElectron || /[\\/]resources[\\/]cli$/i.test(root)) return { kind: 'desktop', root }
	if (/[\\/](_npx|dlx-[^\\/]*|\.bun[\\/]install[\\/]cache|bunx-[^\\/]*)[\\/]/i.test(root)) {
		return { kind: 'ephemeral', root }
	}
	if (
		exists(join(root, 'src')) ||
		exists(join(root, '..', '..', 'pnpm-workspace.yaml')) ||
		exists(join(root, '.git'))
	) {
		return { kind: 'development', root }
	}

	const pnpmDir = pnpmGlobalDirFor(root)
	if (pnpmDir) {
		// pnpm is a `.cmd` shim on Windows, which cannot be started without a shell: tell the person instead.
		const writable = platform !== 'win32' && canWrite(pnpmDir)
		return { kind: 'pnpm-global', root, globalDir: pnpmDir, writable }
	}

	const prefix = npmGlobalPrefixFor(root, platform)
	if (prefix) {
		const owned = input.namzuHome !== undefined && samePath(prefix, input.namzuHome, platform)
		// On Windows `node_modules\@namzu\cli` is also what a project-local install looks like.
		// A real global prefix has the launcher npm wrote beside it, or is Namzu's own home.
		if (platform === 'win32' && !owned && !exists(win32.join(prefix, 'namzu.cmd'))) {
			return { kind: 'unknown', root }
		}
		// npm replaces the package folder inside its scope folder and writes the launcher into the prefix.
		const writable = canWrite(dirname(root)) && canWrite(prefix)
		return { kind: 'npm-global', root, prefix, owned, writable }
	}
	return { kind: 'unknown', root }
}

/** The running package root with symlinks resolved, or the path as given. */
export function realRoot(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}
