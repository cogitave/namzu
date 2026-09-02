/**
 * Shell commands the operator runs at points in the agent's loop.
 *
 * The kernel's plugin manager already carries a hook system — `pre_tool_use`,
 * `post_tool_use`, `run_start`, `run_end` and more — and lets a host attach a
 * handler without a plugin on disk. What was missing was the form an
 * operator actually writes: not a JavaScript module with a manifest, but one
 * line of config saying "before every write, run the formatter" or "when a
 * run ends, notify me". That is this file.
 *
 * ```yaml
 * hooks:
 *   pre_tool_use:
 *     - matcher: "bash"
 *       command: "./scripts/check-command.sh"
 *   post_tool_use:
 *     - matcher: "edit|write"
 *       command: "pnpm biome format --write \"$NAMZU_TOOL_PATH\""
 *   run_end:
 *     - command: "notify-send namzu 'turn settled'"
 * ```
 *
 * ## The contract, and why it is this one
 *
 * A hook is a shell command. It receives one JSON object on stdin — the
 * event, the tool name and input when there is one, the run id and the
 * working directory — and the same facts as `NAMZU_HOOK_*` environment
 * variables for a one-liner that does not want to parse JSON. Its exit code
 * is its answer:
 *
 * - `0` — carry on.
 * - `2` — **block.** For `pre_tool_use` the call does not run and the model is
 *   told why, with the hook's stderr as the reason. For any other event a 2
 *   is reported and the run carries on, because there is nothing left to
 *   block: the tool has run, the run has started.
 * - anything else — a hook that failed on its own account. Reported, never
 *   blocking. A formatter that crashed must not stop the agent editing.
 *
 * `2` rather than any non-zero, because a hook's own failure and a hook's
 * verdict are different facts and one exit code cannot carry both. A script
 * that is missing its interpreter exits 127; treating that as "the operator
 * forbade this call" would block every tool on a typo.
 *
 * ## What a hook cannot do here
 *
 * Modify a tool's input, or replace its result. The kernel's hook protocol
 * allows both; this first cut exposes neither, because a shell command that
 * rewrites what the model asked for is a capability that deserves its own
 * design and its own audit, not a JSON field on stdout that nobody reviewed.
 *
 * ## Bounds
 *
 * Each hook has a deadline (`timeoutMs`, default 30 s), and stdout/stderr are
 * captured to a bound. A hook that times out is reported and does not block;
 * a `pre_tool_use` hook that cannot answer in time has not answered "no".
 */

import { spawn } from 'node:child_process'

import type {
	PluginHookContext,
	PluginHookResult,
	PluginId,
	PluginLifecycleManager,
} from '@namzu/sdk'

import type { HookEntry, HookEvent, HooksConfig } from '../../config/schema.js'
import { cliLogger } from '../../logging.js'

/** The plugin id the host registers its shell hooks under. */
export const SHELL_HOOKS_PLUGIN_ID = 'plg_namzu-shell-hooks' as PluginId

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000
/** Longest a hook may run, whatever the config asks. */
export const MAX_HOOK_TIMEOUT_MS = 10 * 60_000
/** Captured output bound per stream. */
const MAX_CAPTURE_BYTES = 64 * 1024

export const HOOK_EVENTS: readonly HookEvent[] = [
	'pre_tool_use',
	'post_tool_use',
	'run_start',
	'run_end',
]

/**
 * `matcher` against a tool name: `*`, or a `|`-separated list of names, each
 * of which may end in `*`. Case-sensitive, because tool names are.
 */
export function hookMatches(matcher: string | undefined, toolName: string | undefined): boolean {
	if (matcher === undefined || matcher.trim() === '' || matcher.trim() === '*') return true
	if (toolName === undefined) return false
	return matcher.split('|').some((part) => {
		const candidate = part.trim()
		if (candidate.length === 0) return false
		return candidate.endsWith('*')
			? toolName.startsWith(candidate.slice(0, -1))
			: toolName === candidate
	})
}

/** What one hook run came back with, before it is mapped to a verdict. */
export interface ShellHookOutcome {
	readonly exitCode: number | null
	readonly timedOut: boolean
	readonly stdout: string
	readonly stderr: string
	/** Set when the process could not be started at all. */
	readonly spawnError?: string
}

export interface ShellHookInput {
	readonly event: HookEvent
	readonly cwd: string
	readonly runId: string
	readonly toolName?: string
	readonly toolInput?: unknown
	readonly toolResult?: {
		readonly success: boolean
		readonly output: string
		readonly error?: string
	}
}

/** Run one hook command to completion, bounded by its deadline and capture. */
export function runShellHook(
	entry: HookEntry,
	input: ShellHookInput,
	signal?: AbortSignal,
): Promise<ShellHookOutcome> {
	const timeoutMs = Math.min(
		MAX_HOOK_TIMEOUT_MS,
		Math.max(1, entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS),
	)
	const payload = JSON.stringify({
		event: input.event,
		cwd: input.cwd,
		run_id: input.runId,
		...(input.toolName !== undefined ? { tool_name: input.toolName } : {}),
		...(input.toolInput !== undefined ? { tool_input: input.toolInput } : {}),
		...(input.toolResult !== undefined ? { tool_result: input.toolResult } : {}),
	})
	const toolPath = pathOf(input.toolInput)
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>
		try {
			child = spawn('sh', ['-c', entry.command], {
				cwd: input.cwd,
				env: {
					...process.env,
					NAMZU_HOOK_EVENT: input.event,
					NAMZU_RUN_ID: input.runId,
					...(input.toolName !== undefined ? { NAMZU_TOOL_NAME: input.toolName } : {}),
					...(toolPath !== undefined ? { NAMZU_TOOL_PATH: toolPath } : {}),
				},
				stdio: ['pipe', 'pipe', 'pipe'],
			})
		} catch (error) {
			resolve({
				exitCode: null,
				timedOut: false,
				stdout: '',
				stderr: '',
				spawnError: error instanceof Error ? error.message : String(error),
			})
			return
		}
		let stdout = ''
		let stderr = ''
		let timedOut = false
		let settled = false
		const capture = (current: string, chunk: Buffer): string =>
			current.length >= MAX_CAPTURE_BYTES
				? current
				: (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES)
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout = capture(stdout, chunk)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = capture(stderr, chunk)
		})
		const finish = (outcome: ShellHookOutcome) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			resolve(outcome)
		}
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, timeoutMs)
		const onAbort = () => child.kill('SIGKILL')
		signal?.addEventListener('abort', onAbort, { once: true })
		child.on('error', (error) => {
			finish({ exitCode: null, timedOut, stdout, stderr, spawnError: error.message })
		})
		child.on('close', (code) => {
			finish({ exitCode: code, timedOut, stdout, stderr })
		})
		child.stdin?.on('error', () => {
			// A hook that never reads stdin closes it; that is not a failure.
		})
		child.stdin?.end(payload)
	})
}

function pathOf(toolInput: unknown): string | undefined {
	if (toolInput === null || typeof toolInput !== 'object') return undefined
	const record = toolInput as Record<string, unknown>
	for (const key of ['path', 'file_path', 'filePath']) {
		const value = record[key]
		if (typeof value === 'string' && value.length > 0) return value
	}
	return undefined
}

/**
 * The verdict, from the outcome and the event. Pure, so the mapping above
 * is testable without a process: it is the part that decides what the
 * model is told.
 */
export function hookVerdict(
	event: HookEvent,
	entry: HookEntry,
	outcome: ShellHookOutcome,
): PluginHookResult {
	const label = `hook \`${entry.command}\``
	if (outcome.spawnError !== undefined) {
		cliLogger().warn('hook could not start', {
			'namzu.hook.event': event,
			'namzu.hook.command': entry.command,
			'namzu.hook.error': outcome.spawnError,
		})
		return { action: 'continue' }
	}
	if (outcome.timedOut) {
		cliLogger().warn('hook timed out', {
			'namzu.hook.event': event,
			'namzu.hook.command': entry.command,
		})
		return { action: 'continue' }
	}
	if (outcome.exitCode === 0) return { action: 'continue' }
	if (outcome.exitCode === 2) {
		const reason = outcome.stderr.trim() || outcome.stdout.trim() || `blocked by ${label}`
		if (event === 'pre_tool_use') return { action: 'skip', reason }
		cliLogger().warn('hook returned 2 on an event it cannot block', {
			'namzu.hook.event': event,
			'namzu.hook.command': entry.command,
			'namzu.hook.reason': reason,
		})
		return { action: 'continue' }
	}
	cliLogger().warn('hook failed', {
		'namzu.hook.event': event,
		'namzu.hook.command': entry.command,
		'namzu.hook.exit': outcome.exitCode ?? -1,
		'namzu.hook.stderr': outcome.stderr.trim().slice(0, 500),
	})
	return { action: 'continue' }
}

/**
 * Register every configured hook on the manager. Order within an event is
 * the order in the file; the manager runs `post_*` in reverse, as it does
 * for plugins, so a formatter registered last runs first after a write.
 */
export function attachShellHooks(
	manager: PluginLifecycleManager,
	hooks: HooksConfig,
	cwd: string,
): number {
	let count = 0
	for (const event of HOOK_EVENTS) {
		for (const entry of hooks[event] ?? []) {
			manager.registerHook(SHELL_HOOKS_PLUGIN_ID, {
				event,
				handler: async (context: PluginHookContext) => {
					if (!hookMatches(entry.matcher, context.toolName)) return { action: 'continue' }
					const outcome = await runShellHook(
						entry,
						{
							event,
							cwd,
							runId: String(context.runId),
							...(context.toolName !== undefined ? { toolName: context.toolName } : {}),
							...(context.toolInput !== undefined ? { toolInput: context.toolInput } : {}),
							...(context.toolResult !== undefined
								? {
										toolResult: {
											success: context.toolResult.success,
											output: context.toolResult.output,
											...(context.toolResult.error !== undefined
												? { error: context.toolResult.error }
												: {}),
										},
									}
								: {}),
						},
						context.signal,
					)
					return hookVerdict(event, entry, outcome)
				},
			})
			count += 1
		}
	}
	return count
}
