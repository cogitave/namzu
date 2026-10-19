/**
 * Feeds the status line controller from the screen's live values and returns
 * the line to draw, or `undefined`.
 *
 * `read` builds the payload at run time from refs, so a run sees the state
 * of that moment, not of the render that scheduled it; `triggers` are the
 * values whose change schedules a run.
 */

import { useEffect, useRef, useState } from 'react'

import type { StatusLineConfig } from '../../config/schema.js'
import { StatusLineController } from './controller.js'
import type { StatusLinePayloadInput } from './payload.js'
import { buildStatusLinePayload } from './payload.js'
import { runStatusLineCommand } from './run-command.js'
import { type WorkspaceGit, readWorkspaceGit } from './workspace-git.js'

export interface UseStatusLineOptions {
	readonly config: StatusLineConfig | undefined
	/** False while the folder is untrusted or no interactive terminal is drawing. */
	readonly enabled: boolean
	readonly cwd: string
	readonly columns: number
	/** Builds the live inputs; called at run time. */
	readonly read: () => Omit<StatusLinePayloadInput, 'gitWorktree' | 'repo' | 'now'>
	readonly triggers: readonly unknown[]
}

export function useStatusLine(options: UseStatusLineOptions): string | undefined {
	const [text, setText] = useState<string | undefined>(undefined)
	const latest = useRef(options)
	latest.current = options
	const controllerRef = useRef<StatusLineController | null>(null)
	if (controllerRef.current === null) {
		controllerRef.current = new StatusLineController({
			onText: setText,
			run: async (signal, command) => {
				const current = latest.current
				const git: WorkspaceGit = await readWorkspaceGit(current.cwd).catch(() => ({}))
				if (signal.aborted) return undefined
				const payload = buildStatusLinePayload({
					...current.read(),
					...git,
					now: Date.now(),
				})
				return runStatusLineCommand({
					command,
					payload,
					cwd: current.cwd,
					columns: current.columns,
					signal,
				})
			},
		})
	}
	const command = options.enabled ? options.config?.command : undefined
	const refresh = options.config?.refreshInterval
	// biome-ignore lint/correctness/useExhaustiveDependencies: the trigger list is the dependency list
	useEffect(() => {
		controllerRef.current?.update(
			command === undefined ? null : { command, refreshIntervalSeconds: refresh },
			options.triggers,
		)
	}, [command, refresh, ...options.triggers])
	useEffect(() => () => controllerRef.current?.stop(), [])
	return command === undefined ? undefined : text
}
