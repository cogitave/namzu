import { execFile } from 'node:child_process'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import {
	type ComputerSecretSource,
	type ResolveSecretDeps,
	homeQualifies,
	resolveComputerSecret,
} from '@namzu/sdk'

/** The real file system and process calls behind `resolveComputerSecret`. */
export function systemSecretDeps(harden: (dir: string) => void): ResolveSecretDeps {
	return {
		realpath: (path) => realpath(path),
		exists: (path) =>
			access(path).then(
				() => true,
				() => false,
			),
		fileOwner: (path) =>
			lstat(path).then(
				(info) => info.uid,
				() => undefined,
			),
		uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
		readText: (path) => readFile(path, 'utf8').catch(() => undefined),
		writeText: async (path, text) => {
			const dir = dirname(path)
			harden(dir)
			await mkdir(dir, { recursive: true, mode: 0o700 })
			await writeFile(path, text, { mode: 0o600 })
		},
		exec: (command, args) =>
			new Promise((resolve) => {
				try {
					// A short real wait on a real child process; nothing depends on it finishing.
					execFile(
						command,
						[...args],
						{ timeout: 4000, windowsHide: true, cwd: '/mnt/c' },
						(error, stdout) => resolve(error ? undefined : String(stdout).trim()),
					)
				} catch {
					resolve(undefined)
				}
			}),
	}
}

export interface HomeSecret {
	readonly source: ComputerSecretSource | undefined
	/** The name of the scheduler service whose home this is; undefined for the default home and for any other. */
	readonly serviceName: string | undefined
}

/** Which computer secret this home uses, and which service it is when it is one. Never throws. */
export async function secretForHome(
	home: string,
	env: NodeJS.ProcessEnv,
	harden: (dir: string) => void,
	osHome: string = homedir(),
): Promise<HomeSecret> {
	try {
		const deps = systemSecretDeps(harden)
		const source = await resolveComputerSecret({
			home,
			osHome,
			platform: process.platform,
			env,
			deps,
		})
		if (!source) return { source: undefined, serviceName: undefined }
		const real = await deps.realpath(home).catch(() => home)
		const underServices = basename(dirname(real)) === 'services'
		const isDefault = !(underServices && (await homeQualifies(real, osHome, deps.realpath)))
		return { source, serviceName: isDefault ? undefined : basename(real) }
	} catch {
		return { source: undefined, serviceName: undefined }
	}
}
