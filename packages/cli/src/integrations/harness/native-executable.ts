import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path'

export interface HarnessExecutableOptions {
	readonly executable?: string
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
}

/** Find authored executable files, never interpret a shell or npm command shim. */
export async function resolveHarnessExecutable(
	engine: 'codex' | 'claude',
	options: HarnessExecutableOptions = {},
): Promise<string> {
	const platform = options.platform ?? process.platform
	const env = options.env ?? process.env
	const windows = platform === 'win32'
	const paths = windows ? win32 : { dirname, join, isAbsolute, resolve }
	const executableFile = async (candidate: string): Promise<string | undefined> => {
		if (!paths.isAbsolute(candidate)) return undefined
		if (windows && !/\.(?:exe|com)$/i.test(candidate)) return undefined
		try {
			if (!(await stat(candidate)).isFile()) return undefined
			await access(candidate, windows ? constants.F_OK : constants.X_OK)
			return await realpath(candidate)
		} catch {
			return undefined
		}
	}
	if (options.executable !== undefined) {
		const executable = await executableFile(options.executable)
		if (!executable) throw new Error(`The configured ${engine} native executable is unavailable.`)
		return executable
	}
	const search = (env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter).filter(Boolean)
	const home = windows ? env.USERPROFILE : (env.HOME ?? homedir())
	if (home) search.push(paths.join(home, '.local', 'bin'))
	if (windows && env.APPDATA) search.push(paths.join(env.APPDATA, 'npm'))
	for (const directory of search) {
		const native = await executableFile(paths.join(directory, windows ? `${engine}.exe` : engine))
		if (native) return native
	}
	if (windows && engine === 'codex') {
		const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
		const target = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
		for (const directory of search) {
			const packageRoot = paths.join(directory, 'node_modules', '@openai', 'codex')
			for (const vendorRoot of [
				paths.join(packageRoot, 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor'),
				paths.join(directory, 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor'),
				paths.join(packageRoot, 'vendor'),
			]) {
				const native = await executableFile(paths.join(vendorRoot, target, 'bin', 'codex.exe'))
				if (native) return native
			}
		}
	}
	throw new Error(
		`${engine === 'codex' ? 'Codex CLI' : 'Claude Code'} native executable was not found.`,
	)
}
