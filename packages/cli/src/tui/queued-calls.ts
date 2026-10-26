/**
 * The row a call has while it waits for a yes.
 *
 * With per-call review the terminal knows about a call before the kernel
 * starts it: it is being asked about, or it is queued behind an earlier
 * question. The row is the one the call will have when it runs, drawn quiet:
 * a static dim dot, the call's own title, and for a shell call a dim
 * "Waiting…" line where "Running…" will go. When the call starts, the kernel's
 * start event takes the row over by id.
 */

import type { ToolPresenter } from '@namzu/sdk'

import type { ActiveTool } from './LiveActivity.js'
import { type PermissionToolCall, toAgentEvent } from './agent.js'
import { formatToolCall } from './tool-end-rows.js'
import { webCallTitle } from './web-activity.js'

export type QueuedTool = ActiveTool & {
	readonly activity?: 'exploration'
	readonly turnId?: string
	readonly toolName: string
	readonly detail?: readonly string[]
}

/** The waiting row of one call, or `undefined` when the call has no view to draw. */
export function queuedToolRow(
	call: PermissionToolCall,
	turnId: string | undefined,
	presenter: ToolPresenter,
	cwd: string,
	now: number,
): QueuedTool | undefined {
	const event = toAgentEvent(
		{
			type: 'tool_executing',
			...(turnId ? { turnId } : {}),
			toolUseId: call.id,
			toolName: call.name,
			input: call.input,
		} as unknown as Parameters<typeof toAgentEvent>[0],
		presenter,
		undefined,
		cwd,
	)
	if (event?.kind !== 'tool-start') return undefined
	return {
		id: event.toolUseId,
		...(event.turnId ? { turnId: event.turnId } : {}),
		toolName: event.toolName,
		...(event.activity ? { activity: event.activity } : {}),
		label: event.web
			? webCallTitle(event.web)
			: formatToolCall(event.toolName, event.summary, event.standalone),
		startedAt: now,
		queued: true,
		detail: event.detail,
		...(event.command ? { command: event.command } : {}),
		...(event.web ? { web: event.web } : {}),
	}
}

/** Add a waiting row unless the call already has one (or already runs). */
export function withQueuedRow<T extends { readonly id: string; readonly turnId?: string }>(
	rows: readonly T[],
	row: T,
): readonly T[] {
	return rows.some((other) => other.id === row.id && other.turnId === row.turnId)
		? rows
		: [...rows, row]
}

/** Take a call's waiting row away, if it is still waiting. A running call's row stays. */
export function withoutQueuedRow<T extends { readonly id: string; readonly queued?: true }>(
	rows: readonly T[],
	callId: string,
): readonly T[] {
	return rows.filter((row) => !(row.id === callId && row.queued === true))
}

/** A waiting row after its yes: the same row, now running. */
export function withStartedRow<
	T extends { readonly id: string; readonly queued?: true; readonly startedAt: number },
>(rows: readonly T[], callId: string, now: number): readonly T[] {
	return rows.map((row) => {
		if (row.id !== callId || row.queued !== true) return row
		const { queued: _queued, ...running } = row
		return { ...running, startedAt: now } as T
	})
}
