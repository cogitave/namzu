import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ResidentContextualStep, ResidentDecision } from '@namzu/sdk'
import { generateRunId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { EXIT_BAD_CONFIG, EXIT_UNTRUSTED, EXIT_USAGE } from '../../exit-codes.js'
import type { ResidentSessionStepOptions } from '../../integrations/resident/session-step.js'
import { lookupResident } from '../../integrations/resident/storage.js'
import { residentCommand } from '../resident.js'
import type { CommandContext } from '../types.js'

const adapter = vi.hoisted(() => ({
	create: vi.fn<(options: ResidentSessionStepOptions) => ResidentContextualStep>(),
	step: vi.fn<ResidentContextualStep>(),
}))

vi.mock('../../integrations/resident/session-step.js', () => ({
	createResidentSessionStep: adapter.create,
}))

let directory: string
let stateRoot: string
let workspace: string

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-resident-command-'))
	stateRoot = join(directory, 'state')
	workspace = join(directory, 'workspace')
	mkdirSync(stateRoot)
	mkdirSync(workspace)
	vi.stubEnv('NAMZU_HOME', stateRoot)
	adapter.create.mockReset().mockReturnValue(adapter.step)
	adapter.step
		.mockReset()
		.mockResolvedValue({ kind: 'complete', summary: 'Verified the objective.' })
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(directory)
})

async function command(args: readonly string[], cwd = workspace) {
	const printed: unknown[] = []
	const errors: string[] = []
	const ctx: CommandContext = {
		config: {},
		formatter: {
			name: 'json',
			print: (value) => printed.push(value),
			info: () => {},
			error: (error) => errors.push(error.message),
		},
	}
	const code = await residentCommand.handler({ ctx, rawArgs: [...args, '--cwd', cwd] })
	return { code, printed, errors }
}

async function active(cwd = workspace) {
	const resident = await lookupResident(cwd, 'default')
	if (!resident) throw new Error('Fixture resident was not created')
	const agenda = await resident.agenda.read()
	if (!agenda) throw new Error('Fixture agenda was not created')
	const pursuit = agenda.pursuits[0]
	if (!pursuit) throw new Error('Fixture pursuit was not added')
	return { resident, agenda, pursuit }
}

async function add(cwd = workspace) {
	expect(
		(await command(['add', '--trust', 'Inspect the project and verify its tests'], cwd)).code,
	).toBe(0)
	return active(cwd)
}

async function cli(args: readonly string[]) {
	const output: string[] = []
	const errors: string[] = []
	const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		output.push(String(chunk))
		return true
	})
	const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		errors.push(String(chunk))
		return true
	})
	try {
		const code = await runCli({ argv: ['node', 'namzu', '--format', 'json', 'resident', ...args] })
		return { code, output: output.join(''), errors: errors.join('') }
	} finally {
		stdout.mockRestore()
		stderr.mockRestore()
	}
}

describe('resident commands reach durable project state', () => {
	it('shows help and default status without trusting the project, reading malformed config or creating state', async () => {
		writeFileSync(join(stateRoot, 'config.yaml'), 'invalid: [configuration')
		writeFileSync(join(workspace, 'namzu.config.json'), '{broken')
		const before = readdirSync(stateRoot).sort()
		const help = await cli(['--help', '--cwd', workspace])
		expect(help.code).toBe(0)
		expect(help.output).toContain('run --max-steps')
		const status = await cli(['--cwd', workspace, '--agent', 'default'])
		expect(status.code).toBe(0)
		expect(status.output).toContain('No resident named default')
		expect(readdirSync(stateRoot).sort()).toEqual(before)
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it('adds authorized objectives without starting execution or remembering invocation trust', async () => {
		const { pursuit } = await add()
		expect(pursuit.state).toMatchObject({
			objective: 'Inspect the project and verify its tests',
			phase: 'waiting',
			stepsAdmitted: 0,
			claimId: null,
		})
		expect(adapter.create).not.toHaveBeenCalled()
		expect(adapter.step).not.toHaveBeenCalled()
		expect((await command(['run', '--max-steps', '1'])).code).toBe(EXIT_UNTRUSTED)
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it('requires trust before the first add can create state', async () => {
		const result = await command(['add', 'Inspect the project'])
		expect(result.code).toBe(EXIT_UNTRUSTED)
		expect(result.errors.join('')).toContain('nobody has trusted')
		expect(readdirSync(stateRoot)).toEqual([])
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it.each([null, '0', 'Infinity', '1.5', '9007199254740992'])(
		'requires a finite positive explicit step cap before execution: %j',
		async (value) => {
			const result = await command([
				'run',
				'--trust',
				...(value !== null ? ['--max-steps', value] : []),
			])
			expect(result.code).toBe(EXIT_USAGE)
			expect(result.errors.join('')).toContain('--max-steps')
			expect(readdirSync(stateRoot)).toEqual([])
			expect(adapter.create).not.toHaveBeenCalled()
		},
	)

	it.each(['paused', 'unresolved', 'complete', 'blocked', 'indefinite', 'future'])(
		'%s work performs zero execution steps on an authorized run',
		async (phase) => {
			const { resident, agenda, pursuit } = await add()
			if (phase === 'paused') await resident.agenda.setPaused(agenda, true)
			else {
				const store = resident.agenda.execution(pursuit.id)
				const claim = await store.claim(pursuit.state, Date.now())
				if (phase !== 'unresolved') {
					const decision: ResidentDecision =
						phase === 'complete' || phase === 'blocked'
							? { kind: phase, summary: 'Verified final result' }
							: {
									kind: 'wait',
									summary: 'Waiting for further evidence',
									wakeAt: phase === 'future' ? Date.now() + 100_000 : null,
								}
					await store.settle(claim, decision, Date.now())
				}
			}
			const result = await command(['run', '--trust', '--max-steps', '1', '--max-idle-ms', '0'])
			expect(result.code).toBe(phase === 'unresolved' ? 1 : 0)
			expect(adapter.step).not.toHaveBeenCalled()
			if (phase === 'unresolved') {
				expect(JSON.stringify(result.printed)).toContain('unresolved')
				expect((await active()).pursuit.state.phase).toBe('running')
			}
		},
	)

	it('reopens a settled wait with the same objective and retained summary only after an explicit wake and run', async () => {
		const initial = await add()
		adapter.step.mockResolvedValueOnce({
			kind: 'wait',
			summary: 'Read the test setup; waiting for the fixture to arrive.',
			wakeAt: null,
		})
		expect((await command(['run', '--trust', '--max-steps', '1'])).code).toBe(0)
		expect(adapter.step).toHaveBeenCalledTimes(1)
		const reopened = await active()
		expect(reopened.pursuit).toMatchObject({
			id: initial.pursuit.id,
			state: {
				objective: initial.pursuit.state.objective,
				phase: 'waiting',
				summary: 'Read the test setup; waiting for the fixture to arrive.',
			},
		})
		expect((await command(['wake', initial.pursuit.id, 'Fixture has arrived'])).code).toBe(0)
		expect(adapter.step).toHaveBeenCalledTimes(1)
		expect((await command(['run', '--trust', '--max-steps', '1'])).code).toBe(0)
		expect(adapter.step).toHaveBeenCalledTimes(2)
		expect(adapter.step.mock.calls[1]?.[0]).toMatchObject({
			id: initial.pursuit.id,
			state: {
				objective: initial.pursuit.state.objective,
				summary: 'Read the test setup; waiting for the fixture to arrive.',
				reason: 'Fixture has arrived',
				stepsAdmitted: 2,
			},
		})
		expect((await active()).pursuit.state.phase).toBe('complete')
	})

	it('reports failure for a retained claim even when the host returns paused, without executing a step', async () => {
		const { resident, pursuit } = await add()
		const claim = await resident.agenda.execution(pursuit.id).claim(pursuit.state, Date.now())
		const running = await active()
		await resident.agenda.setPaused(running.agenda, true)
		const result = await command(['run', '--trust', '--max-steps', '1'])
		expect(result.code).toBe(1)
		expect(result.printed).toContainEqual(
			expect.objectContaining({
				execution: expect.objectContaining({ status: 'paused', stepsSettled: 0 }),
			}),
		)
		const retained = await active()
		expect(retained.agenda.paused).toBe(true)
		expect(retained.pursuit.state).toEqual(claim)
		expect(adapter.step).not.toHaveBeenCalled()
	})

	it('retains a failed executor claim across restart and refuses automatic replay', async () => {
		await add()
		adapter.step.mockRejectedValueOnce(new Error('The executor stopped after an uncertain effect'))
		const failed = await command(['run', '--trust', '--max-steps', '1'])
		expect(failed.code).toBe(1)
		const retained = (await active()).pursuit.state
		expect(retained.phase).toBe('running')
		expect(retained.claimId).not.toBeNull()
		expect((await command(['run', '--trust', '--max-steps', '1'])).code).toBe(1)
		expect(adapter.step).toHaveBeenCalledTimes(1)
		expect((await active()).pursuit.state).toEqual(retained)
	})

	it('requires pause, executor confirmation and the exact claim revision to reconcile, retaining pause afterwards', async () => {
		const { resident, pursuit } = await add()
		const claim = await resident.agenda.execution(pursuit.id).claim(pursuit.state, Date.now())
		const reconcile = [
			'reconcile',
			pursuit.id,
			'Inspected the output and stopped the old executor.',
			'--claim',
			claim.claimId!,
			'--revision',
			String(claim.revision),
			'--outcome',
			'wait',
		]
		expect((await command([...reconcile, '--executor-stopped'])).errors.join('')).toContain(
			'Pause the resident',
		)
		expect((await command(['pause'])).code).toBe(0)
		expect((await command(['resume'])).code).toBe(1)
		expect((await command(reconcile)).code).toBe(EXIT_USAGE)
		const wrongClaim = [...reconcile, '--executor-stopped']
		wrongClaim[4] = generateRunId()
		expect((await command(wrongClaim)).errors.join('')).toContain('Claim or revision')
		const wrongRevision = [...reconcile, '--executor-stopped']
		wrongRevision[6] = String(claim.revision + 1)
		expect((await command(wrongRevision)).errors.join('')).toContain('Claim or revision')
		expect((await active()).pursuit.state).toEqual(claim)
		expect((await command([...reconcile, '--executor-stopped'])).code).toBe(0)
		const reconciled = await active()
		expect(reconciled.agenda.paused).toBe(true)
		expect(reconciled.pursuit.state).toMatchObject({
			phase: 'waiting',
			claimId: null,
			wakeAt: null,
			summary: 'Inspected the output and stopped the old executor.',
		})
		expect(adapter.step).not.toHaveBeenCalled()
		expect((await command(['resume'])).code).toBe(0)
		expect((await active()).agenda.paused).toBe(false)
		expect(adapter.step).not.toHaveBeenCalled()
	})

	it('archives terminal work and retains its immutable history', async () => {
		const { resident, pursuit } = await add()
		expect((await command(['archive', pursuit.id])).code).toBe(1)
		expect((await command(['run', '--trust', '--max-steps', '1'])).code).toBe(0)
		expect((await command(['archive', pursuit.id])).code).toBe(0)
		expect((await resident.agenda.read())?.pursuits).toEqual([])
		const archived = await resident.agenda.listArchived()
		expect(archived.entries[0]?.pursuits[0]).toMatchObject({
			id: pursuit.id,
			state: { objective: pursuit.state.objective, phase: 'complete' },
		})
		expect(adapter.step).toHaveBeenCalledTimes(1)
	})

	it('runs from the stored canonical subdirectory when later invoked at the project root', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'package')
		mkdirSync(nested)
		const { resident } = await add(nested)
		expect((await command(['run', '--trust', '--max-steps', '1'])).code).toBe(0)
		expect(adapter.create.mock.calls[0]?.[0]).toMatchObject({
			cwd: nested,
			sessions: { projectId: resident.projectId, tenantId: resident.tenantId },
			artifactsRoot: resident.artifactsRoot,
		})
	})

	it('refuses a missing stored directory while status remains available from the project root', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'package')
		mkdirSync(nested)
		await add(nested)
		renameSync(nested, join(directory, 'moved-package'))
		expect((await command(['status'])).code).toBe(0)
		const result = await command(['run', '--trust', '--max-steps', '1'])
		expect(result.code).toBe(1)
		expect(result.errors.join('')).toContain('does not exist')
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it('refuses an execution directory that became a different project after binding', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'package')
		mkdirSync(nested)
		await add(nested)
		mkdirSync(join(nested, '.git'))
		const result = await command(['run', '--trust', '--max-steps', '1'])
		expect(result.code).toBe(1)
		expect(result.errors.join('')).toContain('no longer belongs')
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it('refuses a stored directory replaced by a symlink within the same project before reading its config', async () => {
		mkdirSync(join(workspace, '.git'))
		const nested = join(workspace, 'package')
		const replacement = join(workspace, 'replacement')
		mkdirSync(nested)
		mkdirSync(replacement)
		await add(nested)
		renameSync(nested, join(directory, 'original-package'))
		symlinkSync(replacement, nested, process.platform === 'win32' ? 'junction' : 'dir')
		writeFileSync(join(replacement, 'namzu.config.json'), '{broken')
		const result = await cli(['run', '--cwd', workspace, '--trust', '--max-steps', '1'])
		expect(result.code).toBe(1)
		expect(result.errors).toMatch(/canonical|changed|directory/)
		expect(result.errors).not.toContain('not valid JSON')
		expect(adapter.create).not.toHaveBeenCalled()
		expect(adapter.step).not.toHaveBeenCalled()
		expect((await active()).pursuit.state.stepsAdmitted).toBe(0)
	})

	it('refuses a binding edited to execute outside its project', async () => {
		const { resident } = await add()
		const path = join(dirname(resident.artifactsRoot), 'binding.json')
		const binding = JSON.parse(readFileSync(path, 'utf8'))
		writeFileSync(path, JSON.stringify({ ...binding, cwd: directory }))
		const result = await command(['run', '--trust', '--max-steps', '1'])
		expect(result.code).toBe(1)
		expect(result.errors.join('')).toContain('outside the bound project')
		expect(adapter.create).not.toHaveBeenCalled()
	})

	it('allows add, status and pause with malformed configuration, but refuses to execute it', async () => {
		writeFileSync(join(stateRoot, 'config.yaml'), 'invalid: [configuration')
		writeFileSync(join(workspace, 'namzu.config.json'), '{broken')
		expect((await cli(['add', '--cwd', workspace, '--trust', 'Inspect the test setup'])).code).toBe(
			0,
		)
		expect((await cli(['status', '--cwd', workspace])).code).toBe(0)
		expect((await cli(['pause', '--cwd', workspace])).code).toBe(0)
		expect((await active()).agenda.paused).toBe(true)
		const result = await cli(['run', '--cwd', workspace, '--trust', '--max-steps', '1'])
		expect(result.code).toBe(EXIT_BAD_CONFIG)
		expect(result.errors).toContain('config')
		expect(adapter.create).not.toHaveBeenCalled()
	})
})
