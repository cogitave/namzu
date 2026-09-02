/**
 * A shell command as a plugin hook.
 *
 * The lifecycle manager carries a hook system — `pre_tool_use`,
 * `post_tool_use`, `run_start`, `run_end` and the rest — and `registerHook`
 * lets a host attach a handler without a plugin on disk. What every host then
 * writes for itself is the same adapter: run a command, hand it the event,
 * read its exit code. This file is that adapter, once, so an operator
 * application, an ACP server and an embedder all offer the same contract and
 * an operator's hook script works under all three.
 *
 * ## The contract
 *
 * The command runs with `sh -c` in `cwd`. It receives one JSON object on
 * stdin — `event`, `cwd`, `run_id`, and for tool events `tool_name`,
 * `tool_input` and (after the call) `tool_result` — and the same facts as
 * `NAMZU_HOOK_EVENT`, `NAMZU_RUN_ID`, `NAMZU_TOOL_NAME` and, when the input
 * names a file, `NAMZU_TOOL_PATH`. Its exit code is its answer:
 *
 * - `0` — carry on.
 * - `2` — **block.** Before a tool (`pre_tool_use`) the call is skipped and the
 *   model is told why, with the hook's stderr as the reason. On any other
 *   event a 2 is reported and the run carries on: there is nothing left to
 *   block once the tool has run or the run has started.
 * - anything else — the hook's own failure. Reported through the logger,
 *   never blocking. A formatter that crashed must not stop the agent editing,
 *   and a script missing its interpreter (127) must not read as "forbidden".
 *
 * `2` rather than any non-zero, because a verdict and a failure are different
 * facts and one exit code cannot carry both.
 *
 * ## What a hook cannot do here
 *
 * Modify a tool's input or replace its result. The hook protocol allows both
 * (`modify`, `replace`); this adapter exposes neither, because a shell command
 * that rewrites what the model asked for deserves its own design and audit,
 * not a JSON field on stdout nobody reviewed.
 *
 * ## Bounds
 *
 * Each hook has a deadline (`timeoutMs`, default 30 s, capped at ten minutes)
 * and its output is captured to a bound. A hook that times out is reported
 * and does not block: one that could not answer in time has not answered no.
 */

import { spawn } from 'node:child_process'

import type { PluginId } from '../types/ids/index.js'
import type {
	PluginHookContext,
	PluginHookDefinition,
	PluginHookEvent,
	PluginHookResult,
} from '../types/plugin/index.js'
import { asPluginId } from '../utils/id.js'
import { NOOP_LOGGER } from '../utils/log/create-logger.js'
import type { Logger } from '../utils/logger.js'
import type { PluginLifecycleManager } from './lifecycle.js'

/** The events a shell hook may attach to: the ones with a clear verdict. */
export type ShellHookEvent = Extract<
	PluginHookEvent,
	'pre_tool_use' | 'post_tool_use' | 'run_start' | 'run_end'
>

export const SHELL_HOOK_EVENTS: readonly ShellHookEvent[] = [
	'pre_tool_use',
	'post_tool_use',
	'run_start',
	'run_end',
]

/** One shell command at one event. */
export interface ShellHookEntry {
	/** Run with `sh -c`, in the working directory, with the event JSON on stdin. */
	readonly command: string
	/** Tool names this applies to: `*`, a name, or `a|b|prefix*`. Absent means every tool. */
	readonly matcher?: string
	/** Deadline in milliseconds; default `DEFAULT_SHELL_HOOK_TIMEOUT_MS`, capped at `MAX_SHELL_HOOK_TIMEOUT_MS`. */
	readonly timeoutMs?: number
}

/** Event → entries, the shape a host's config file carries. */
export type ShellHooksConfig = { readonly [event in ShellHookEvent]?: readonly ShellHookEntry[] }

/** The plugin id host shell hooks register under when the host names none. */
export const SHELL_HOOKS_PLUGIN_ID: PluginId = asPluginId('plg_shell-hooks')

export const DEFAULT_SHELL_HOOK_TIMEOUT_MS = 30_000
export const MAX_SHELL_HOOK_TIMEOUT_MS = 10 * 60_000
/** Captured output bound per stream. */
const MAX_CAPTURE_BYTES = 64 * 1024

/**
 * `matcher` against a tool name: `*`, or a `|`-separated list of names, each
 * of which may end in `*`. Case-sensitive, because tool names are. A matcher
 * on an event with no tool (`run_start`) matches nothing unless it is `*`.
 */
export function shellHookMatches(
	matcher: string | undefined,
	toolName: string | undefined,
): boolean {
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
	readonly event: ShellHookEvent
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
	entry: ShellHookEntry,
	input: ShellHookInput,
	signal?: AbortSignal,
): Promise<ShellHookOutcome> {
	const timeoutMs = Math.min(
		MAX_SHELL_HOOK_TIMEOUT_MS,
		Math.max(1, entry.timeoutMs ?? DEFAULT_SHELL_HOOK_TIMEOUT_MS),
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
				// Its own process group, so the deadline can kill everything the
				// command started. `sh -c 'sleep 5'` is one process under a shell
				// that execs its last command and two under one that forks it;
				// killing only the shell in the second case leaves `sleep` holding
				// the stdout pipe, and the outcome cannot settle until it exits on
				// its own — the hook's deadline becomes the grandchild's.
				detached: process.platform !== 'win32',
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
		const killTree = () => {
			if (child.pid !== undefined && process.platform !== 'win32') {
				try {
					process.kill(-child.pid, 'SIGKILL')
					return
				} catch {
					// The group is already gone, or this platform has no groups;
					// the child alone is the best that can be done.
				}
			}
			child.kill('SIGKILL')
		}
		const timer = setTimeout(() => {
			timedOut = true
			killTree()
		}, timeoutMs)
		const onAbort = () => killTree()
		signal?.addEventListener('abort', onAbort, { once: true })
		child.on('error', (error) => {
			finish({ exitCode: null, timedOut, stdout, stderr, spawnError: error.message })
		})
		child.on('close', (code) => {
			finish({ exitCode: code, timedOut, stdout, stderr })
		})
		child.on('exit', () => {
			// After a kill, a survivor that still holds the pipes must not hold
			// the outcome: drop our ends so `close` follows `exit` promptly.
			if (timedOut || signal?.aborted) {
				child.stdout?.destroy()
				child.stderr?.destroy()
			}
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
 * The verdict, from the outcome and the event. Pure apart from the logger,
 * so the mapping — the part that decides what the model is told — is
 * testable without a process.
 */
export function shellHookVerdict(
	event: ShellHookEvent,
	entry: ShellHookEntry,
	outcome: ShellHookOutcome,
	log: Logger = NOOP_LOGGER,
): PluginHookResult {
	const attrs = { 'namzu.hook.event': event, 'namzu.hook.command': entry.command }
	if (outcome.spawnError !== undefined) {
		log.warn('hook could not start', { ...attrs, 'namzu.hook.error': outcome.spawnError })
		return { action: 'continue' }
	}
	if (outcome.timedOut) {
		log.warn('hook timed out', attrs)
		return { action: 'continue' }
	}
	if (outcome.exitCode === 0) return { action: 'continue' }
	if (outcome.exitCode === 2) {
		const reason =
			outcome.stderr.trim() || outcome.stdout.trim() || `blocked by hook \`${entry.command}\``
		if (event === 'pre_tool_use') return { action: 'skip', reason }
		log.warn('hook returned 2 on an event it cannot block', {
			...attrs,
			'namzu.hook.reason': reason,
		})
		return { action: 'continue' }
	}
	log.warn('hook failed', {
		...attrs,
		'namzu.hook.exit': outcome.exitCode ?? -1,
		'namzu.hook.stderr': outcome.stderr.trim().slice(0, 500),
	})
	return { action: 'continue' }
}

export interface ShellHookOptions {
	/** Where the command runs and what `cwd` says on stdin. */
	readonly cwd: string
	readonly log?: Logger
}

/** One entry as a hook definition the lifecycle manager accepts. */
export function createShellHook(
	event: ShellHookEvent,
	entry: ShellHookEntry,
	options: ShellHookOptions,
): PluginHookDefinition {
	const log = options.log ?? NOOP_LOGGER
	return {
		event,
		handler: async (context: PluginHookContext) => {
			if (!shellHookMatches(entry.matcher, context.toolName)) return { action: 'continue' }
			const outcome = await runShellHook(
				entry,
				{
					event,
					cwd: options.cwd,
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
			return shellHookVerdict(event, entry, outcome, log)
		},
	}
}

/**
 * Register every entry on the manager, in file order within an event. The
 * manager runs `post_*` hooks in reverse, as it does for plugins, so a
 * formatter registered last runs first after a write. Returns how many were
 * attached.
 */
export function attachShellHooks(
	manager: Pick<PluginLifecycleManager, 'registerHook'>,
	hooks: ShellHooksConfig,
	options: ShellHookOptions & { readonly pluginId?: PluginId },
): number {
	const pluginId = options.pluginId ?? SHELL_HOOKS_PLUGIN_ID
	let count = 0
	for (const event of SHELL_HOOK_EVENTS) {
		for (const entry of hooks[event] ?? []) {
			manager.registerHook(pluginId, createShellHook(event, entry, options))
			count += 1
		}
	}
	return count
}
