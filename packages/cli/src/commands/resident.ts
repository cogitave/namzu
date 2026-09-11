import { stripVTControlCharacters } from 'node:util'
import type {
	ResidentAgendaState,
	ResidentDecision,
	ResidentHostResult,
	ResidentPursuit,
} from '@namzu/sdk'
import { ResidentConflictError } from '@namzu/sdk'
import { ConfigLoadError, ConfigValueError } from '../config/load.js'
import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_BAD_CONFIG, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { runOwnedResident } from '../integrations/resident/owned-runner.js'
import { queryRunner } from '../integrations/resident/runner-control.js'
import {
	residentRunnerStatus,
	startResidentRunner,
	stopResidentRunner,
} from '../integrations/resident/runner-launch.js'
import { readRunner, releaseRunner, reserveRunner } from '../integrations/resident/runner-store.js'
import {
	type CliResident,
	createResident,
	lookupResident,
} from '../integrations/resident/storage.js'
import { openSessions } from '../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { parseResidentFlags } from './resident-flags.js'
import { resolveWorkingDirectory } from './run-flags.js'
import type { CommandDef } from './types.js'

const line = (value: string) => stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')

export function residentStatus(
	resident: CliResident,
	state: ResidentAgendaState,
	message?: string,
	runner?: Awaited<ReturnType<typeof residentRunnerStatus>>,
) {
	const unresolved = state.pursuits.filter((p) => p.state.phase === 'running')
	const live = runner?.live?.kind === 'responsive' ? runner.live : null
	const responsive = live !== null
	const text = [
		`Resident · ${resident.agentKey}`,
		`Directory: ${line(resident.cwd)}`,
		`Admission: ${state.paused ? 'paused' : 'open'}${unresolved.length ? (responsive ? ' · a pursuit is admitted' : ' · retained work needs inspection') : ''}`,
		...(runner?.owner
			? [
					`Runner: ${live ? live.phase : runner.owner.phase === 'running' ? 'unresponsive; state retained' : runner.owner.phase} · ${runner.owner.mode}`,
					`  ${runner.owner.instanceId} · ${runner.owner.maxSteps} step(s) authorized${runner.owner.pid ? ` · PID ${runner.owner.pid}` : ''}`,
					...(live ? [`  ${live.stepsStarted} step(s) started in this invocation`] : []),
					...(runner.owner.outcome ? [`  Last outcome: ${line(runner.owner.outcome)}`] : []),
				]
			: []),
		...(message ? ['', message] : []),
		'',
		...state.pursuits.flatMap((p) => [
			`${p.state.phase} · ${line(p.state.objective)}`,
			`  ${p.id} · ${p.state.stepsAdmitted} step(s) admitted`,
			...(p.state.summary ? [`  ${line(p.state.summary)}`] : []),
			...(p.state.phase === 'waiting'
				? [
						`  ${p.state.wakeAt === null ? 'Waiting for evidence; use resident wake.' : p.state.wakeAt <= Date.now() ? (responsive ? 'Ready for the active runner.' : 'Ready for the next authorized run.') : `Next step: ${new Date(p.state.wakeAt).toISOString()}`}`,
					]
				: []),
			...(p.state.claimId
				? [
						`  Claim: ${p.state.claimId} · revision ${p.state.revision}`,
						`  Inspect attempt records: ${line(resident.artifactsRoot)}/${p.state.claimId}`,
					]
				: []),
		]),
		...(state.pursuits.length ? [] : ['No active pursuits.']),
		...(unresolved.length && !responsive
			? [
					'',
					'A retained claim does not establish whether its executor is still alive.',
					'Stop prior executors and inspect effects before resident reconcile.',
				]
			: []),
	].join('\n')
	return {
		text,
		agent: resident.agentKey,
		cwd: resident.cwd,
		agenda: state,
		...(runner ? { runner } : {}),
		...(message ? { message } : {}),
	}
}

function pursuit(state: ResidentAgendaState, id: string): ResidentPursuit {
	const found = state.pursuits.find((p) => p.id === id)
	if (!found) throw new Error(`Unknown active pursuit: ${id}`)
	return found
}

async function readAgenda(resident: CliResident): Promise<ResidentAgendaState> {
	const state = await resident.agenda.read()
	if (!state) throw new Error('Resident agenda is missing; no saved result can be reported.')
	return state
}

async function closeAdmission(resident: CliResident, initial: ResidentAgendaState): Promise<void> {
	let state = initial
	for (let attempt = 0; ; attempt++) {
		try {
			await resident.agenda.setPaused(state, true)
			return
		} catch (error) {
			if (!(error instanceof ResidentConflictError) || attempt >= 7) throw error
			state = await readAgenda(resident)
		}
	}
}

export const residentCommand: CommandDef = {
	name: 'resident',
	description: 'Manage persistent work and explicitly authorized resident runners (experimental)',
	passThrough: true,
	help: [
		'Usage: namzu resident <action> [options]',
		'',
		'  add <objective>          Save work without starting a model',
		'  status                   Show saved work and unresolved claims (default action)',
		'  run --max-steps <n>       Continue due work in this foreground process',
		'  start --max-steps <n>     Start a managed background runner; retain its limit while idle',
		'  stop                     Close admission and wait briefly for runner drainage',
		'  release <runner-id>      Release inspected stale ownership; requires --executor-stopped',
		'  pause                    Close admission and request interruption of active runners',
		'  resume                   Reopen admission; does not start work or clear claims',
		'  wake <id> <evidence>      Make a waiting pursuit due using new evidence',
		'  archive <id>             Retire a terminal pursuit, preserving its history',
		'  reconcile <id> <summary> Record inspected effects for an exact interrupted claim',
		'',
		'Common: --cwd <path>, --agent <name> (default: default).',
		'The first add binds the execution directory; later launches keep that directory.',
		'Add, run and start require folder trust, or --trust for this invocation.',
		'',
		'Run options: --provider <id>, --model <id>, --effort <level>,',
		'  --permission-mode <mode> (default: plan, read-only), --skills <a,b>,',
		'  --max-iterations <n>, --token-budget <n> (limits apply per SDK step),',
		'  --tool-loading eager|deferred (default: eager; defer optional schemas per step),',
		'  --gate <command>, --gate-retries <n>, --max-idle-ms <n> (default: 60000).',
		'Run and start require a finite --max-steps. No OS service is installed.',
		'Start survives the launching terminal; it stops at that limit, pause, failure or stop.',
		'For start, --max-idle-ms is a positive local idle check interval; idle does not exit.',
		'Status contacts the exact runner locally; no recorded PID is blindly signalled.',
		'Idle waits use local storage checks and spend no model calls.',
		'',
		'Reconcile also requires --claim <uuid> --revision <n> --outcome wait|complete|blocked',
		'  --executor-stopped. This confirms all old executors stopped and effects were',
		'  inspected; put the evidence in <summary>. Pause the resident first.',
		'  A wait outcome rests indefinitely; use wake to supply new evidence.',
		'Release requires prior pause and confirmation all previous executors stopped.',
		'An unreachable runner is not proof it stopped. Release never reconciles a pursuit.',
		'',
		'Pause acknowledges durable admission closure, not completed tool cancellation.',
		'Interrupted, failed or unfinished steps keep their claim and are never replayed automatically.',
		'Continuation uses the saved summary and approved learning, not a restored chat transcript.',
		'Exit: 0 for an operation/clean bounded run, 1 for unresolved or failed work,',
		'  64 for invalid arguments, 77 for untrusted execution, 78 for invalid run config,',
		'  130 for cancellation. A clean run does not mean every pursuit is complete.',
	].join('\n'),
	handler: async ({ ctx: bootstrap, rawArgs }) => {
		let flags: ReturnType<typeof parseResidentFlags>
		try {
			flags = parseResidentFlags(rawArgs)
		} catch (error) {
			bootstrap.formatter.error({ message: String(error instanceof Error ? error.message : error) })
			return EXIT_USAGE
		}
		const resolved = resolveWorkingDirectory(flags.run.cwd)
		if ('error' in resolved) {
			bootstrap.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}
		let resident: CliResident | null = null
		try {
			resident = await lookupResident(resolved.cwd, flags.agent)
			if (flags.action === 'status' && !resident) {
				bootstrap.formatter.print({
					text: `No resident named ${flags.agent} in this project. Use namzu resident add <objective>.`,
					agent: flags.agent,
					agenda: null,
				})
				return 0
			}
			if (flags.action === 'add' || flags.action === 'run' || flags.action === 'start') {
				const target = resolveWorkingDirectory(resident?.cwd ?? resolved.cwd)
				if ('error' in target) throw new Error(target.error)
				const trust = decideHeadlessTrust({ cwd: target.cwd, trustFlag: flags.run.trust })
				if (!trust.allowed) {
					bootstrap.formatter.error({
						message: trust.message ?? 'Resident directory is not trusted.',
					})
					return EXIT_UNTRUSTED
				}
				if (resident && trust.cwd !== resident.cwd)
					throw new Error(
						'Resident execution directory no longer resolves to its saved canonical path. Restore the original directory before running this resident.',
					)
				if (flags.action === 'add') resident = await createResident(trust.cwd, flags.agent)
			}
			if (!resident) throw new Error(`No resident named ${flags.agent}. Add a pursuit first.`)
			let state = await resident.agenda.read()
			if (!state)
				throw new Error(
					'Resident binding exists but its agenda is missing; repeat add to initialize it.',
				)
			let message: string | undefined
			switch (flags.action) {
				case 'add': {
					const added = await resident.agenda.add(state, flags.run.rest.join(' '))
					message = `Saved ${added.id}.`
					break
				}
				case 'status':
					break
				case 'stop': {
					// Bind this stop to the invocation observed before closing admission.
					// A later resume/start must not become the target of an older stop.
					const owner = readRunner(resident)
					await closeAdmission(resident, state)
					const stopped = await stopResidentRunner(resident, { owner })
					state = await readAgenda(resident)
					const text =
						stopped.status === 'drained'
							? 'The observed runner drained. Inspect current admission and any retained pursuit claim below.'
							: stopped.status === 'absent'
								? 'Admission closed. No managed runner is recorded; other executors are not certified stopped.'
								: 'Interruption requested; runner drainage is not confirmed. Inspect status before recovery.'
					bootstrap.formatter.print({
						...residentStatus(resident, state, text, await residentRunnerStatus(resident)),
						stop: stopped,
					})
					return stopped.status === 'unconfirmed' ? 1 : 0
				}
				case 'release': {
					if (!state.paused)
						throw new Error('Pause the resident before releasing inspected runner ownership.')
					const owner = readRunner(resident)
					if (!owner || owner.instanceId !== flags.run.rest[0])
						throw new Error('Runner ID does not match current ownership. Inspect status again.')
					if (
						owner.phase === 'running' &&
						(await queryRunner(owner, 'status')).kind === 'responsive'
					)
						throw new Error(
							'This runner still responds. Use resident stop and wait for drainage before recovery.',
						)
					releaseRunner(resident, owner)
					message =
						'Inspected runner ownership released. Pursuit claims and admission are unchanged; reconcile interrupted work separately.'
					break
				}
				case 'pause':
					await closeAdmission(resident, state)
					message = 'Admission closed; interruption requested. Active tools may still be stopping.'
					break
				case 'resume':
					if (state.pursuits.some((p) => p.state.phase === 'running'))
						throw new Error('Inspect and reconcile unresolved claims before reopening admission.')
					await resident.agenda.setPaused(state, false)
					message = 'Admission reopened. No work started; invoke resident run or start explicitly.'
					break
				case 'wake': {
					const selected = pursuit(state, flags.run.rest[0])
					await resident.agenda.wake(
						selected.id,
						selected.state,
						flags.run.rest.slice(1).join(' '),
						Date.now(),
					)
					message = 'New evidence saved; pursuit is due on the next authorized run.'
					break
				}
				case 'archive':
					await resident.agenda.archive(state, {
						pursuitIds: [pursuit(state, flags.run.rest[0]).id],
					})
					message = 'Terminal pursuit archived; immutable history retained.'
					break
				case 'reconcile': {
					if (!state.paused)
						throw new Error('Pause the resident before reconciling inspected effects.')
					const selected = pursuit(state, flags.run.rest[0])
					if (
						selected.state.phase !== 'running' ||
						selected.state.claimId !== flags.claim ||
						selected.state.revision !== flags.revision
					)
						throw new Error(
							'Claim or revision does not match the current unresolved pursuit; inspect status again.',
						)
					const summary = flags.run.rest.slice(1).join(' ')
					const decision: ResidentDecision =
						flags.outcome === 'wait'
							? { kind: 'wait', summary, wakeAt: null }
							: { kind: flags.outcome as 'complete' | 'blocked', summary }
					await resident.agenda.execution(selected.id).settle(selected.state, decision, Date.now())
					message = 'Inspection recorded against the exact claim. Resident remains paused.'
					break
				}
				case 'run':
				case 'start': {
					if (flags.maxSteps === null) throw new Error('Resident execution requires --max-steps.')
					const ctx = resolveTrustedProjectContext(bootstrap, resident.cwd)
					const sessions = await openSessions(resident.cwd)
					if (sessions.projectId !== resident.projectId || sessions.tenantId !== resident.tenantId)
						throw new Error(
							'Resident execution directory no longer belongs to its bound project and tenant.',
						)
					const { createResidentSessionStep } = await import(
						'../integrations/resident/session-step.js'
					)
					const step = createResidentSessionStep({
						ctx,
						cwd: resident.cwd,
						sessions,
						flags: flags.run,
						toolLoading: flags.toolLoading,
						artifactsRoot: resident.artifactsRoot,
					})
					if (flags.action === 'start') {
						const owner = await startResidentRunner({
							resident,
							ctx,
							flags: flags.run,
							toolLoading: flags.toolLoading,
							maxSteps: flags.maxSteps,
							maxIdleMs: flags.maxIdleMs,
						})
						state = await readAgenda(resident)
						ctx.formatter.print({
							...residentStatus(
								resident,
								state,
								'Background runner started. Use resident status to inspect it and resident stop to drain it.',
								await residentRunnerStatus(resident),
							),
							started: owner,
						})
						return 0
					}
					const existing = readRunner(resident)
					if (existing && ['reserved', 'running'].includes(existing.phase))
						throw new Error(
							'A resident runner already owns this agenda. Inspect status and stop it before another run.',
						)
					const controller = new AbortController()
					const interrupt = () =>
						controller.abort(new Error('Resident foreground invocation interrupted.'))
					process.once('SIGINT', interrupt)
					process.once('SIGTERM', interrupt)
					try {
						const result: ResidentHostResult =
							state.paused || state.pursuits.some((p) => p.state.phase === 'running')
								? {
										status: state.paused ? 'paused' : 'unresolved',
										stepsSettled: 0,
										nextWakeAt: null,
									}
								: await runOwnedResident({
										resident,
										owner: reserveRunner(resident, {
											mode: 'foreground',
											maxSteps: flags.maxSteps,
											pauseGeneration: state.pauseGeneration ?? 0,
										}),
										step,
										signal: controller.signal,
										keepAlive: false,
										maxIdleMs: flags.maxIdleMs,
									})
						state = await readAgenda(resident)
						const status = residentStatus(
							resident,
							state,
							undefined,
							await residentRunnerStatus(resident),
						)
						ctx.formatter.print({
							...status,
							execution: result,
							text: `${status.text}\n\nRun: ${result.status} · ${result.stepsSettled} step(s) settled`,
						})
						return result.status === 'cancelled'
							? 130
							: ['unresolved', 'contended'].includes(result.status) ||
									state.pursuits.some((p) => p.state.phase === 'running')
								? 1
								: 0
					} finally {
						process.removeListener('SIGINT', interrupt)
						process.removeListener('SIGTERM', interrupt)
					}
				}
			}
			state = await readAgenda(resident)
			const runner = await residentRunnerStatus(resident)
			if (flags.action === 'add') {
				message +=
					runner.live?.kind === 'responsive'
						? ' Due work is available to the current runner within its remaining authorization.'
						: runner.owner && ['running', 'reserved'].includes(runner.owner.phase)
							? ' Runner ownership is retained; inspect resident status before execution.'
							: ' Continue with namzu resident run --max-steps <n> or resident start --max-steps <n>.'
			}
			bootstrap.formatter.print(residentStatus(resident, state, message, runner))
			return 0
		} catch (error) {
			bootstrap.formatter.error({ message: error instanceof Error ? error.message : String(error) })
			if (resident) {
				try {
					const state = await resident.agenda.read()
					if (state)
						bootstrap.formatter.print(
							residentStatus(resident, state, undefined, await residentRunnerStatus(resident)),
						)
				} catch {
					/* Preserve the original error when state is also unavailable. */
				}
			}
			return error instanceof ConfigLoadError || error instanceof ConfigValueError
				? EXIT_BAD_CONFIG
				: 1
		}
	},
}
