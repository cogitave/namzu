/**
 * An `agent` job's gate: one shell command the operator wrote that runs
 * before every scheduled run and decides whether the model is called at all.
 *
 * The turn starts only when the command exits 0 AND prints something on
 * stdout. Every other outcome skips the run, with a reason in plain words and
 * no model call: the gate printed nothing, exited with a code, ran out of
 * time, or could not start. What it printed is the turn's starting context,
 * capped, as data: not an instruction from the operator.
 *
 * The command is bound by the job's confirmation digest, read by the same
 * scheduled-run floor and `deny` rules as a script job's body, and run
 * through the same `runScript` the script kinds use, with the environment
 * the scheduler gave the run and nothing more.
 */

import { type CommandShell, installedCommandShellForDialect, isCredentialEnvKey } from '@namzu/sdk'
import type { PermissionLayer } from '../config/load.js'
import { runScript } from './fire/run-script.js'
import { compileScriptCheckPolicy } from './policy.js'
import { verifyScheduledScript } from './script-check.js'
import { scriptShellUnavailableReason } from './script-shell.js'
import type { GateSkipKind, ScheduleJob, ScheduleJobGate } from './types.js'

/** How long a gate may run when the job does not say. */
export const DEFAULT_GATE_TIMEOUT_MS = 30_000
/** The longest a job may allow its gate: a gate is a cheap check, not the work. */
export const MAX_GATE_TIMEOUT_MS = 5 * 60_000
/** How much of what the gate printed the turn is given. */
export const GATE_OUTPUT_MAX_CHARS = 4_000
/** Gate-start failures in a row before the person is told, as for a failing task. */
export const GATE_START_FAILURES_BEFORE_NOTICE = 3

/** The marker at the cut; says how much was kept so nothing is cut silently. */
export function gateCutMarker(): string {
	return `\n...(cut: the gate printed more than ${GATE_OUTPUT_MAX_CHARS} characters; only the first ${GATE_OUTPUT_MAX_CHARS} are shown)`
}

export type GateOutcome =
	| {
			readonly run: true
			/** What the gate printed, capped, with the cut marked. */
			readonly output: string
			readonly cut: boolean
	  }
	| {
			readonly run: false
			readonly kind: GateSkipKind
			/** Plain words, one line, safe to show. */
			readonly reason: string
			readonly exitCode?: number
	  }

export type GateRunner = typeof runScript

function seconds(ms: number): string {
	return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/**
 * The environment a gate runs in: the one the scheduler gave the run, with
 * every credential-shaped key dropped, which is what the task's own turn
 * inherits for its shell commands. The gate gets no secret the turn would not.
 */
export function gateEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !isCredentialEnvKey(key)) out[key] = value
	}
	out.NAMZU_HOME = home
	return out
}

/** The text the turn is told: the kernel's words, then the output as data. */
export function gateContextText(output: string): string {
	return `The gate command printed:\n${output}`
}

/** What is wrong with a gate's shape, in words, or undefined. A job file is data anyone may edit. */
export function gateShapeProblem(gate: unknown): string | undefined {
	const g = gate as Partial<ScheduleJobGate> | null
	if (typeof g !== 'object' || g === null) return 'the gate is not an object'
	if (typeof g.command !== 'string' || g.command.trim() === '') {
		return 'the gate command is missing or empty'
	}
	if (g.shell !== 'bash' && g.shell !== 'sh') return 'the gate shell must be bash or sh'
	if (typeof g.timeoutMs !== 'number' || !validGateTimeout(g.timeoutMs)) {
		return `the gate timeout must be a whole number of milliseconds above zero and at most ${MAX_GATE_TIMEOUT_MS / 1000} s`
	}
	return undefined
}

/** Whether a timeout is one a job may carry. */
export function validGateTimeout(ms: number): boolean {
	return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_GATE_TIMEOUT_MS
}

/**
 * Run a job's gate. Never throws; the runner is a seam so a test gives it a
 * fake command and no real process.
 */
export async function runGate(
	gate: ScheduleJobGate,
	options: {
		readonly cwd: string
		readonly env: NodeJS.ProcessEnv
		readonly resolvedShell?: CommandShell
		readonly runner?: GateRunner
	},
): Promise<GateOutcome> {
	const shape = gateShapeProblem(gate)
	if (shape) return { run: false, kind: 'start', reason: `the gate could not start: ${shape}` }
	const result = await (options.runner ?? runScript)(gate.command, gate.shell, {
		cwd: options.cwd,
		env: options.env,
		timeoutMs: gate.timeoutMs,
		...(options.resolvedShell ? { resolvedShell: options.resolvedShell } : {}),
	})
	if (result.shellUnavailable) {
		return {
			run: false,
			kind: 'start',
			reason: `the gate could not start: ${scriptShellUnavailableReason(result.shellUnavailable)}`,
		}
	}
	if (result.dialectMismatch) {
		return {
			run: false,
			kind: 'start',
			reason: `the gate could not start: it was confirmed for ${result.dialectMismatch.expected}, but this host now runs commands as ${result.dialectMismatch.actual}`,
		}
	}
	if (result.timedOut) {
		return {
			run: false,
			kind: 'timeout',
			reason: `the gate ran out of time (${seconds(gate.timeoutMs)})`,
		}
	}
	if (result.outputOverflow) {
		return {
			run: false,
			kind: 'abnormal',
			reason: 'the gate printed too much and was ended (more than 10 MB)',
		}
	}
	if (result.signal) {
		return { run: false, kind: 'abnormal', reason: `the gate was ended by ${result.signal}` }
	}
	if (result.exitCode === null) {
		return { run: false, kind: 'start', reason: 'the gate could not start' }
	}
	if (result.exitCode !== 0) {
		return {
			run: false,
			kind: 'exit',
			reason: `the gate exited with ${result.exitCode}`,
			exitCode: result.exitCode,
		}
	}
	if (result.stdout.trim() === '') {
		return { run: false, kind: 'silent', reason: 'the gate printed nothing' }
	}
	const cut = result.stdout.length > GATE_OUTPUT_MAX_CHARS
	let kept = cut ? result.stdout.slice(0, GATE_OUTPUT_MAX_CHARS) : result.stdout
	// Never end on half of a surrogate pair.
	if (cut && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
	return { run: true, cut, output: cut ? `${kept}${gateCutMarker()}` : kept }
}

/**
 * The same static check a script job's body passes, over the gate's command:
 * the shell must exist and the scheduled-run floor and every `deny` rule must
 * accept it. Returns the refusal in words, or undefined when it passes.
 */
export function gateRefusal(
	job: Pick<ScheduleJob, 'gate' | 'permissions' | 'folder'>,
	layers: readonly PermissionLayer[],
	namzuHome: string,
): string | undefined {
	const gate = job.gate
	if (!gate) return undefined
	const shape = gateShapeProblem(gate)
	if (shape) return `the gate was refused: ${shape}`
	const shell = installedCommandShellForDialect(gate.shell)
	if (!shell) return scriptShellUnavailableReason(gate.shell)
	const policy = compileScriptCheckPolicy(job.permissions, {
		layers,
		namzuHome,
		folder: job.folder,
	})
	const checked = verifyScheduledScript(gate.command, shell.dialect, policy)
	return checked.ok ? undefined : `the gate was refused: ${checked.reason}`
}

/** `Gate` lines for a preview or `show`: the exact command, and how it decides. */
export function gateLines(gate: ScheduleJobGate): string[] {
	if (gateShapeProblem(gate)) {
		return [
			'Gate        malformed in the job file; it will not run until it is fixed and confirmed again',
		]
	}
	return [
		`Gate        runs first (${gate.shell}, up to ${seconds(gate.timeoutMs)}); the model is called only if it exits 0 and prints something`,
		...gate.command.split('\n').map((line) => `  │ ${line}`),
	]
}
