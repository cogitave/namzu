import type { SpawnOptions } from 'node:child_process'
import { TASK_NAME } from '../signin/registrar.js'

/**
 * How the background runner is started, as plain command lines.
 *
 * The runner must never be a child of Namzu: Desktop's fallback ends the engine with
 * `taskkill /pid <engine> /t /f`, which walks the whole process tree under the engine, and a runner in
 * that tree would stop with the app and take the recording with it. So on Windows the runner starts
 * through the registered scheduled task (Task Scheduler is its parent, not Namzu), and when there is no
 * task it starts through `cmd start`, whose short-lived `cmd` exits at once and leaves the runner with
 * no living parent for `taskkill /t` to follow. On Linux and macOS a detached start already leaves the
 * process group and the parent, so that stays as it was.
 */

export type RunnerStartPlan =
	| {
			readonly kind: 'task'
			readonly file: 'schtasks'
			readonly args: readonly string[]
	  }
	| {
			readonly kind: 'detached'
			readonly file: string
			readonly args: readonly string[]
			readonly options: SpawnOptions
			/** Windows: the arguments are one command line for `cmd`, not an argument list. */
			readonly verbatim: boolean
	  }

export const runTaskArgs = (): string[] => ['/run', '/tn', TASK_NAME]
export const queryTaskExistsArgs = (): string[] => ['/query', '/tn', TASK_NAME]

/** A value that can sit between double quotes in a `cmd` command line without changing its meaning. */
function cmdSafe(v: string): boolean {
	return !/["%\r\n]/.test(v)
}

export interface PlanInput {
	readonly platform: NodeJS.Platform
	/** Windows only: whether the scheduled task `\Namzu\Extension Runner` is registered. */
	readonly taskExists: boolean
	readonly exe: string
	readonly args: readonly string[]
	readonly env: NodeJS.ProcessEnv
}

/** What to run to start `daemon run`, or `undefined` when the command line cannot be made safely. */
export function planRunnerStart(i: PlanInput): RunnerStartPlan | undefined {
	if (i.platform !== 'win32') {
		return {
			kind: 'detached',
			file: i.exe,
			args: i.args,
			options: { detached: true, stdio: 'ignore', windowsHide: true, env: i.env },
			verbatim: false,
		}
	}
	if (i.taskExists) return { kind: 'task', file: 'schtasks', args: runTaskArgs() }
	const words = [i.exe, ...i.args]
	if (!words.every(cmdSafe)) return undefined
	const line = `start "" /b ${words.map((w) => `"${w}"`).join(' ')}`
	return {
		kind: 'detached',
		file: 'cmd.exe',
		args: ['/d', '/s', '/c', `"${line}"`],
		options: {
			// No new process group and no console of its own: `start /b` hands the runner to the system
			// and the `cmd` that asked for it ends.
			detached: false,
			stdio: 'ignore',
			windowsHide: true,
			windowsVerbatimArguments: true,
			env: i.env,
		},
		verbatim: true,
	}
}
