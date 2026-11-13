import { boundCompactionSummary, compactionHookInstructions } from '../plugin/hook-context.js'
import { applyLifecycleHookResults } from '../runtime/query/plugin-hooks.js'
import type { SessionId, TurnId } from '../types/ids/index.js'
import type {
	PluginCompactionInfo,
	PluginHookContext,
	PluginHookEvent,
	PluginHookResult,
} from '../types/plugin/index.js'
import type { SessionEvent } from '../types/session/index.js'

/**
 * What a compaction needs of the plugin lifecycle manager: the one call that
 * runs the hooks of an event. Structural, so a pass outside a turn does not
 * need the manager's whole type.
 */
export interface CompactionHookHost {
	executeHooks(
		event: PluginHookEvent,
		context: Omit<PluginHookContext, 'pluginId' | 'event'>,
		emitSessionEvent?: (event: SessionEvent) => Promise<void>,
	): Promise<PluginHookResult[]>
}

/**
 * The hooks around a compaction pass a host asked for outside any turn: a
 * person's `/compact`, a summarised span, an idle pass. The pass fires
 * `pre_compact` and `post_compact` as an automatic one does, on the same
 * payload, with `trigger` saying which it is.
 */
export interface ManualCompactionHooks {
	readonly manager: CompactionHookHost
	readonly sessionId: SessionId
	/** `manual` (the default) is a person's request; `idle` is a host compacting a quiet conversation, which the hooks see as `auto`. */
	readonly trigger?: 'manual' | 'idle'
	readonly emitEvent?: (event: SessionEvent) => Promise<void>
}

/**
 * A `pre_compact` hook refused a pass a person asked for. Thrown by
 * {@link compactNow}, {@link compactRegion} and the session variants; a host
 * shows {@link CompactionRefusedError.reason} in one line. A pass the kernel
 * started on its own is cancelled quietly instead, and one the provider forced
 * cannot be refused.
 */
export class CompactionRefusedError extends Error {
	readonly reason: string
	constructor(reason: string) {
		super(`A pre_compact hook refused the compaction: ${reason}`)
		this.name = 'CompactionRefusedError'
		this.reason = reason
	}
}

/** What the `pre_compact` hooks of a pass answered. */
export interface PreCompactAnswer {
	/** The first refusal in answer order, when any hook refused. */
	readonly refusal?: string
	/** What the hooks said the summary should keep, joined and bounded. */
	readonly instructions?: string
}

/** Run the `pre_compact` hooks and read their answers. `error` answers throw, as in a turn. */
export async function askPreCompact(
	host: CompactionHookHost,
	base: {
		readonly sessionId: SessionId
		readonly turnId?: TurnId
		readonly iteration?: number
		readonly signal?: AbortSignal
		readonly emitEvent?: (event: SessionEvent) => Promise<void>
	},
	compaction: PluginCompactionInfo,
): Promise<PreCompactAnswer> {
	const results = await host.executeHooks(
		'pre_compact',
		{
			sessionId: base.sessionId,
			...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
			...(base.iteration !== undefined ? { iteration: base.iteration } : {}),
			compaction,
			...(base.signal ? { signal: base.signal } : {}),
		},
		base.emitEvent,
	)
	applyLifecycleHookResults('pre_compact', results)
	const refusal = results.find((result) => result.action === 'skip')
	const instructions = compactionHookInstructions(results)
	return {
		...(refusal?.action === 'skip' ? { refusal: refusal.reason } : {}),
		...(instructions !== undefined ? { instructions } : {}),
	}
}

/** The summary a `post_compact` hook receives, bounded; the pass's own text is not cut. */
export function postCompactSummary(summary: string | undefined): { summary?: string } {
	const bounded = boundCompactionSummary(summary)
	return bounded === undefined ? {} : { summary: bounded }
}

/** The text of a message, for a hook: only a string body counts. */
export function messageText(content: unknown): string | undefined {
	return typeof content === 'string' ? content : undefined
}
