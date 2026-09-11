import { stripVTControlCharacters } from 'node:util'
import type { ResidentAgendaState, ResidentDecision, ResidentPursuit } from '@namzu/sdk'
import { ConfigLoadError, ConfigValueError } from '../config/load.js'
import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_BAD_CONFIG, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { runResidentForeground } from '../integrations/resident/foreground.js'
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
) {
	const unresolved = state.pursuits.filter((p) => p.state.phase === 'running')
	const text = [
		`Resident · ${resident.agentKey}`,
		`Directory: ${line(resident.cwd)}`,
		`Admission: ${state.paused ? 'paused' : 'open'}${unresolved.length ? ' · unresolved work needs inspection' : ''}`,
		...(message ? ['', message] : []),
		'',
		...state.pursuits.flatMap((p) => [
			`${p.state.phase} · ${line(p.state.objective)}`,
			`  ${p.id} · ${p.state.stepsAdmitted} step(s) admitted`,
			...(p.state.summary ? [`  ${line(p.state.summary)}`] : []),
			...(p.state.phase === 'waiting'
				? [
						`  ${p.state.wakeAt === null ? 'Waiting for evidence; use resident wake.' : p.state.wakeAt <= Date.now() ? 'Ready for the next authorized run.' : `Next step: ${new Date(p.state.wakeAt).toISOString()}`}`,
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
		...(unresolved.length
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

export const residentCommand: CommandDef = {
	name: 'resident',
	description:
		'Manage persistent work and run explicitly authorized foreground steps (experimental)',
	passThrough: true,
	help: [
		'Usage: namzu resident <action> [options]',
		'',
		'  add <objective>          Save work without starting a model',
		'  status                   Show saved work and unresolved claims (default action)',
		'  run --max-steps <n>       Continue due work in this foreground process',
		'  pause                    Close admission and request interruption of active runners',
		'  resume                   Reopen admission; does not start work or clear claims',
		'  wake <id> <evidence>      Make a waiting pursuit due using new evidence',
		'  archive <id>             Retire a terminal pursuit, preserving its history',
		'  reconcile <id> <summary> Record inspected effects for an exact interrupted claim',
		'',
		'Common: --cwd <path>, --agent <name> (default: default).',
		'The first add binds the execution directory; later launches keep that directory.',
		'Add and run require folder trust, or --trust for this invocation.',
		'',
		'Run options: --provider <id>, --model <id>, --effort <level>,',
		'  --permission-mode <mode> (default: plan, read-only), --skills <a,b>,',
		'  --max-iterations <n>, --token-budget <n> (limits apply per SDK step),',
		'  --gate <command>, --gate-retries <n>, --max-idle-ms <n> (default: 60000).',
		'Every run requires a finite --max-steps. No background service is installed.',
		'Idle waits use local storage checks and spend no model calls.',
		'',
		'Reconcile also requires --claim <uuid> --revision <n> --outcome wait|complete|blocked',
		'  --executor-stopped. This confirms all old executors stopped and effects were',
		'  inspected; put the evidence in <summary>. Pause the resident first.',
		'  A wait outcome rests indefinitely; use wake to supply new evidence.',
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
			if (flags.action === 'add' || flags.action === 'run') {
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
					message = `Saved ${added.id}. Start with namzu resident run --max-steps <n>.`
					break
				}
				case 'status':
					break
				case 'pause':
					await resident.agenda.setPaused(state, true)
					message = 'Admission closed; interruption requested. Active tools may still be stopping.'
					break
				case 'resume':
					if (state.pursuits.some((p) => p.state.phase === 'running'))
						throw new Error('Inspect and reconcile unresolved claims before reopening admission.')
					await resident.agenda.setPaused(state, false)
					message = 'Admission reopened. No work started; invoke resident run explicitly.'
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
				case 'run': {
					if (flags.maxSteps === null) throw new Error('resident run requires --max-steps.')
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
						artifactsRoot: resident.artifactsRoot,
					})
					const controller = new AbortController()
					const interrupt = () =>
						controller.abort(new Error('Resident foreground invocation interrupted.'))
					process.once('SIGINT', interrupt)
					process.once('SIGTERM', interrupt)
					try {
						const result = await runResidentForeground({
							agenda: resident.agenda,
							step,
							signal: controller.signal,
							maxSteps: flags.maxSteps,
							maxIdleMs: flags.maxIdleMs,
						})
						state = await readAgenda(resident)
						const status = residentStatus(resident, state)
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
			bootstrap.formatter.print(residentStatus(resident, state, message))
			return 0
		} catch (error) {
			bootstrap.formatter.error({ message: error instanceof Error ? error.message : String(error) })
			if (resident) {
				try {
					const state = await resident.agenda.read()
					if (state) bootstrap.formatter.print(residentStatus(resident, state))
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
