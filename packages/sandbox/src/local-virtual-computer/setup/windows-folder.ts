/**
 * The Windows folder as a path setup code may run programs from.
 *
 * The environment is only a claim, so a value is accepted when it is a drive
 * root followed by `Windows` or `WINNT`; anything else becomes `C:\Windows`.
 * A PC whose Windows folder has another name therefore cannot be set up by
 * this code: the launch fails (reported as `elevation-failed`) rather than
 * running a program from a folder the environment picked.
 */
export function trustedWindowsDirectory(env: NodeJS.ProcessEnv): string {
	const claimed = (env.SystemRoot ?? env.windir ?? '').replace(/[\\/]+$/, '')
	return /^[A-Za-z]:\\(Windows|WINNT)$/i.test(claimed) ? claimed : 'C:\\Windows'
}
