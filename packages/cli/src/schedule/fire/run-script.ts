/**
 * Running a job's own script on the host — a pure `script` job's body, or a
 * `script+agent`'s wake-gate — reusing the exact spawn `execHostShell`
 * already gives the `bash` tool: the same shell resolution the rules read
 * the line in, the same grace-period kill, the same capped, UTF-8-safe
 * output capture. No second copy of any of that lives here.
 *
 * The job's own `script.shell` chooses the interpreter. The resolved
 * executable is checked at confirmation and again at fire; if it was
 * removed, execution is refused rather than silently switching dialects.
 */

import { constants, accessSync } from 'node:fs'
import {
	type CommandShell,
	type ExecHostShellProgress,
	execHostShell,
	installedCommandShellForDialect,
} from '@namzu/sdk'

/** Per stream, capped with an explicit marker — never a silent cut. */
export const MAX_SCRIPT_OUTPUT_CHARS = 8_000

/** `text`, cut to `max` characters with an explicit truncation marker. */
export function capOutput(text: string, max: number = MAX_SCRIPT_OUTPUT_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n...(truncated)`
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

export interface ScriptRunResult {
	readonly stdout: string
	readonly stderr: string
	/** `null` when the process never started, or was killed before it could exit. */
	readonly exitCode: number | null
	readonly timedOut: boolean
	/** A caller gave a different dialect than the one this script was verified in. */
	readonly dialectMismatch?: { readonly expected: 'bash' | 'sh'; readonly actual: 'bash' | 'sh' }
	/** The requested interpreter is no longer executable on this host. */
	readonly shellUnavailable?: 'bash' | 'sh'
}

/**
 * Run `body` on the host, in `shell`'s dialect, capped at `timeoutMs`. Never
 * throws: every outcome — success, non-zero exit, timeout, a spawn error —
 * comes back as a `ScriptRunResult`, so the caller maps it to a status once,
 * in one place.
 */
export async function runScript(
	body: string,
	shell: 'bash' | 'sh',
	options: {
		readonly cwd: string
		readonly env: NodeJS.ProcessEnv
		readonly timeoutMs: number
		readonly maxOutputBytes?: number
		readonly onOutput?: ExecHostShellProgress
		/** Pass the executable already resolved for this fire's static check. */
		readonly resolvedShell?: CommandShell
	},
): Promise<ScriptRunResult> {
	const selected = options.resolvedShell ?? installedCommandShellForDialect(shell)
	if (!selected) {
		return { stdout: '', stderr: '', exitCode: null, timedOut: false, shellUnavailable: shell }
	}
	if (selected.dialect !== shell) {
		return {
			stdout: '',
			stderr: '',
			exitCode: null,
			timedOut: false,
			dialectMismatch: { expected: shell, actual: selected.dialect },
		}
	}
	try {
		const { stdout, stderr } = await execHostShell(body, {
			cwd: options.cwd,
			env: options.env,
			timeout: options.timeoutMs,
			maxBuffer: options.maxOutputBytes ?? 10 * 1024 * 1024,
			shell: selected,
			...(options.onOutput ? { onOutput: options.onOutput } : {}),
		})
		return { stdout, stderr, exitCode: 0, timedOut: false }
	} catch (error) {
		const failure = error as {
			stdout?: string
			stderr?: string
			code?: string | number
			timedOut?: boolean
			killed?: boolean
			message?: string
		}
		if (
			(failure.code === 'ENOENT' || failure.code === 'EACCES') &&
			selected.path !== undefined &&
			!isExecutable(selected.path)
		) {
			return {
				stdout: failure.stdout ?? '',
				stderr: failure.stderr ?? '',
				exitCode: null,
				timedOut: false,
				shellUnavailable: shell,
			}
		}
		return {
			stdout: failure.stdout ?? '',
			stderr: failure.stderr ?? (failure.message ? `${failure.message}\n` : ''),
			exitCode: typeof failure.code === 'number' ? failure.code : null,
			timedOut: failure.timedOut === true,
		}
	}
}
