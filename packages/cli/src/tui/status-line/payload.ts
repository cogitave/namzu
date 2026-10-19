/**
 * The JSON a status line command reads on stdin.
 *
 * Field names are the reference terminal's, so a script written for it reads
 * the same object here. A field appears only when this terminal has the
 * fact; a script must read every field except `session_id`, `cwd`, `model`,
 * `workspace` and `version` as possibly absent. What is never sent, because
 * Namzu has no data for it: `output_style`, `fast_mode`, `thinking`,
 * `vim`, `rate_limits`, `prompt_cache`, `remote`, `worktree`,
 * `transcript_path`, `cost.total_api_duration_ms` and the line counters.
 */

import type { PermissionMode } from '../../permissions/mode.js'
import type { PrFooterState } from '../pr-status.js'

export interface StatusLinePayloadInput {
	readonly sessionId: string | undefined
	readonly sessionName?: string | undefined
	readonly cwd: string
	readonly projectDir: string
	readonly addedDirs: readonly string[]
	readonly gitWorktree?: string | undefined
	readonly repo?:
		| { readonly host: string; readonly owner: string; readonly name: string }
		| undefined
	/** What the footer names as the model; the session offers no separate id. */
	readonly model: string | null
	readonly version: string
	readonly permissionMode?: PermissionMode | undefined
	readonly effort?: string | undefined
	readonly agentName?: string | undefined
	readonly pr?: PrFooterState | undefined
	readonly totalCostUsd: number
	readonly sessionStartedAt: number
	readonly now: number
	/** Tokens in the context now and the model's window; absent before the first answer. */
	readonly context?: { readonly tokens: number; readonly windowTokens: number } | undefined
}

/** The review words the reference uses; `merged` has no counterpart there, so none is sent. */
const REVIEW_STATE: Readonly<Record<string, string>> = {
	approved: 'approved',
	changes: 'changes_requested',
	pending: 'pending',
	draft: 'draft',
}

export function buildStatusLinePayload(input: StatusLinePayloadInput): Record<string, unknown> {
	const model = input.model ?? 'unknown'
	const context = input.context
	let contextWindow: Record<string, unknown> | undefined
	if (context && context.windowTokens > 0 && Number.isFinite(context.tokens)) {
		const used = Math.min(
			100,
			Math.max(0, Math.round((context.tokens / context.windowTokens) * 100)),
		)
		contextWindow = {
			total_input_tokens: context.tokens,
			context_window_size: context.windowTokens,
			used_percentage: used,
			remaining_percentage: 100 - used,
		}
	}
	const pr = input.pr?.kind === 'pr' ? input.pr : undefined
	return {
		hook_event_name: 'StatusLine',
		session_id: input.sessionId ?? '',
		...(input.sessionName ? { session_name: input.sessionName } : {}),
		cwd: input.cwd,
		...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
		model: { id: model, display_name: model },
		workspace: {
			current_dir: input.cwd,
			project_dir: input.projectDir,
			added_dirs: [...input.addedDirs],
			...(input.gitWorktree ? { git_worktree: input.gitWorktree } : {}),
			...(input.repo ? { repo: input.repo } : {}),
		},
		version: input.version,
		cost: {
			total_cost_usd: input.totalCostUsd,
			total_duration_ms: Math.max(0, input.now - input.sessionStartedAt),
		},
		...(contextWindow ? { context_window: contextWindow } : {}),
		...(context ? { exceeds_200k_tokens: context.tokens > 200_000 } : {}),
		...(input.effort ? { effort: { level: input.effort } } : {}),
		...(input.agentName ? { agent: { name: input.agentName } } : {}),
		...(pr
			? {
					pr: {
						number: pr.number,
						url: pr.url,
						...(REVIEW_STATE[pr.review] ? { review_state: REVIEW_STATE[pr.review] } : {}),
					},
				}
			: {}),
	}
}
