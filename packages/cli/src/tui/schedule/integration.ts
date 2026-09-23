/**
 * Everything the TUI's App needs from the scheduler, behind one object so
 * the App changes by a few lines: the `schedule` and `session_loop` tools for
 * the session, `/schedule` and `/loop`, the loop timer, the startup line, and
 * the answer path for a parked scheduled run.
 *
 * The App hands it getters rather than values, because what they read
 * (the conversation on screen, the model, whether a turn is running) changes
 * after this object is made.
 */

import { type ToolDefinition, buildScheduleTools, buildSessionLoopTools } from '@namzu/sdk'
import type { NamzuCliConfig } from '../../config/schema.js'
import type { PermissionMode } from '../../permissions/mode.js'
import type { QuestionFn, ResumePausedParams, ScreenPermissionFn } from '../agent.js'
import { runLoopCommand, runScheduleCommand } from './host-commands.js'
import { SessionLoopScheduler } from './loop-host.js'
import { type ResumeEnvironment, prepareScheduledResume } from './resume.js'
import { scheduleStartupLine } from './startup.js'
import { createScheduleToolHost } from './tool-host.js'

export interface ScheduleIntegrationDeps {
	/** `NAMZU_HOME` of the conversations on screen, once known. */
	readonly home: () => string | undefined
	readonly cwd: () => string
	readonly extraRoots: () => readonly string[]
	readonly config: () => Pick<NamzuCliConfig, 'limits'>
	readonly model: () => { readonly provider: string; readonly model?: string } | undefined
	readonly sessionId: () => string | undefined
	/** `<session-id>/loops.json` of the conversation on screen. */
	readonly loopsFile: () => string | undefined
	readonly isIdle: () => boolean
	readonly say: (text: string) => void
	readonly ask: QuestionFn
	/** The permission screen; a scheduled turn's prompts are batch-only. */
	readonly askPermission: ScreenPermissionFn
	/** Send a prompt as the next turn, as if typed. */
	readonly submit: (text: string) => void
}

export interface ScheduleIntegration {
	readonly loops: SessionLoopScheduler
	/** The tools a person-attended session offers. */
	tools(): ToolDefinition[]
	/** `/schedule` and `/loop`; false for any other name. */
	handleSlash(name: string, args: readonly string[]): boolean
	startupLine(): string | undefined
	/**
	 * Ask about a parked scheduled batch. Throws, saying which session would
	 * match, when `environment` is not how the job runs.
	 */
	prepareResume(
		operatorMode: PermissionMode,
		environment: ResumeEnvironment,
	): Promise<
		| Pick<ResumePausedParams, 'pendingDecision' | 'onPermission' | 'rules' | 'permissionMode'>
		| undefined
	>
	dispose(): void
}

const LOOP_TICK_MS = 15_000

export function createScheduleIntegration(deps: ScheduleIntegrationDeps): ScheduleIntegration {
	const home = () => {
		const value = deps.home()
		if (!value)
			throw new Error('Scheduled jobs are unavailable until this folder’s conversations are open.')
		return value
	}
	const loops = new SessionLoopScheduler({
		file: deps.loopsFile,
		isIdle: deps.isIdle,
		fire: (loop) => {
			deps.say(`↻ loop ${loop.id}${loop.createdBy === 'model' ? ' (created by the model)' : ''}`)
			deps.submit(loop.prompt)
		},
	})
	const timer = setInterval(() => {
		try {
			loops.tick()
		} catch {}
	}, LOOP_TICK_MS)
	timer.unref?.()
	return {
		loops,
		tools: () => [
			...buildScheduleTools(
				createScheduleToolHost({
					home,
					cwd: deps.cwd,
					extraRoots: deps.extraRoots,
					model: deps.model,
					config: deps.config,
					sessionId: deps.sessionId,
					say: deps.say,
					ask: deps.ask,
				}),
			),
			...buildSessionLoopTools(loops),
		],
		handleSlash(name, args) {
			if (name === 'loop') {
				void runLoopCommand(args, loops, deps.say)
				return true
			}
			if (name !== 'schedule') return false
			let ctxHome: string
			try {
				ctxHome = home()
			} catch (error) {
				deps.say(error instanceof Error ? error.message : String(error))
				return true
			}
			const model = deps.model()
			void runScheduleCommand(args, {
				home: ctxHome,
				cwd: deps.cwd(),
				config: deps.config(),
				...(model ? { model } : {}),
				say: deps.say,
				ask: deps.ask,
			})
			return true
		},
		startupLine() {
			const value = deps.home()
			if (!value) return undefined
			try {
				return scheduleStartupLine(value, deps.cwd())
			} catch {
				return undefined
			}
		},
		async prepareResume(operatorMode, environment) {
			const value = deps.home()
			const sessionId = deps.sessionId()
			if (!value || !sessionId) return undefined
			return prepareScheduledResume({
				home: value,
				sessionId,
				operatorMode,
				environment,
				ask: deps.askPermission,
				say: deps.say,
			})
		},
		dispose() {
			clearInterval(timer)
		},
	}
}
