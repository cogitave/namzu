import { constants, accessSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join, win32 } from 'node:path'

// npm's Node .cmd shim has a fixed prologue. Recognize that wrapper rather
// than trusting a target-looking substring in an arbitrary batch program.
const npmNodeShimHeader = [
	'@ECHO off',
	'GOTO start',
	':find_dp0',
	'SET dp0=%~dp0',
	'EXIT /b',
	':start',
	'SETLOCAL',
	'CALL :find_dp0',
	'',
	'IF EXIST "%dp0%\\node.exe" (',
	'  SET "_prog=%dp0%\\node.exe"',
	') ELSE (',
	'  SET "_prog=node"',
	'  SET PATHEXT=%PATHEXT:;.JS;=;%',
	')',
	'',
].join('\n')

function npmNodeShimTarget(candidate: string): string | undefined {
	const lines = readFileSync(candidate, 'utf8').replaceAll('\r\n', '\n').trimEnd().split('\n')
	const invocation = lines.pop()
	if (lines.join('\n') !== npmNodeShimHeader) return undefined
	const target = invocation?.match(
		/^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\([^"%!\r\n]+)" %\*$/,
	)?.[1]
	if (!target || win32.parse(target).root) return undefined
	return win32.resolve(win32.dirname(candidate), target)
}

function windowsPublicInvocation(entrypoint: string, path: string): 'namzu.cmd' | undefined {
	for (const directory of path.split(win32.delimiter)) {
		// Relative PATH entries would change meaning after a directory change.
		if (!win32.isAbsolute(directory) || win32.parse(directory).root.length === 1) break
		const candidate = win32.join(directory, 'namzu.cmd')
		try {
			accessSync(candidate, constants.F_OK)
		} catch (error) {
			const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
			if (code === 'ENOENT' || code === 'ENOTDIR') continue
			break
		}
		// The first existing .cmd controls this explicit public command. Never
		// skip an unreadable, unrecognized or conflicting shim for a later match.
		try {
			const target = npmNodeShimTarget(candidate)
			if (target && realpathSync(target) === realpathSync(entrypoint)) return 'namzu.cmd'
		} catch {
			// Missing or unverifiable targets retain the explicit Node invocation.
		}
		break
	}
	return undefined
}

/** Prefer the public command only when PATH resolves to this exact executable. */
export function resumeInvocation(
	entrypoint: string,
	path = process.env.PATH ?? '',
	platform: NodeJS.Platform = process.platform,
): readonly [string, ...string[]] {
	if (!entrypoint.endsWith('.ts') && platform === 'win32') {
		const command = windowsPublicInvocation(entrypoint, path)
		if (command) return [command]
	} else if (!entrypoint.endsWith('.ts')) {
		for (const directory of path.split(delimiter)) {
			// Relative PATH entries would change meaning after a directory change.
			if (!isAbsolute(directory)) break
			const candidate = join(directory, 'namzu')
			try {
				accessSync(candidate, constants.X_OK)
				if (realpathSync(candidate) === realpathSync(entrypoint)) return ['namzu']
				break
			} catch {
				// Continue past directories without an executable namzu.
			}
		}
	}
	return [process.execPath, ...(entrypoint.endsWith('.ts') ? process.execArgv : []), entrypoint]
}
