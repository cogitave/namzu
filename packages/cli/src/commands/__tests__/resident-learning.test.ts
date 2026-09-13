import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteResidentLearningStore } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { residentLearningStore } from '../../integrations/resident/learning-storage.js'
import { lookupResident } from '../../integrations/resident/storage.js'
import { residentCommand } from '../resident.js'
import type { CommandContext } from '../types.js'

let root: string
let cwd: string
let home: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-cli-learning-'))
	cwd = join(root, 'workspace')
	home = join(root, 'home')
	mkdirSync(cwd)
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function command(args: string[]) {
	const printed: Record<string, unknown>[] = []
	const errors: string[] = []
	const ctx: CommandContext = {
		config: {},
		formatter: {
			name: 'json',
			print: (value) => printed.push(value as Record<string, unknown>),
			info: () => {},
			error: (value) => errors.push(value.message),
		},
	}
	const code = await residentCommand.handler({
		ctx,
		rawArgs: [...args, '--cwd', cwd],
	})
	return { code, printed, errors }
}

function moduleFile(fail = false): string {
	const path = join(root, 'host.learning.mjs')
	writeFileSync(
		path,
		`
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'imported'))}, 'host was imported');
export default function(host) {
 const candidate = {name:'source-check',description:'Inspect the designated source.',body:'Read the actual source before reporting its value.'};
 return {
  skillName:candidate.name, failure:{evidence:{key:'failed-read',source:'fixture:actual-observation',reason:'Expected a source read.'},trace:'Original source was not read.'},
  resources:{unit:'tokens',maxUnits:100},
  generate:async context=>{await context.recordUsage({runId:randomUUID(),tokens:5,costUsd:null});return {candidate,usageComplete:true}},
  evaluate:async context=>{
   await context.recordUsage({runId:randomUUID(),tokens:20,costUsd:null});
   ${fail ? "throw new Error('Independent evaluation was interrupted.');" : ''}
   const trials=side=>Array.from({length:10},(_,i)=>{
    const passed=side==='candidate'||i>1, taskId=context.stage+'-'+Math.floor(i/2);
    return {taskId,trial:i%2,conditions:context.stage+'-'+i,trajectoryId:side+'-'+context.stage+'-'+i,result:{case:taskId,passed,status:passed?'passed':'failed',mean:Number(passed),scores:{exact:{score:Number(passed),reason:'Independent fixture check.'}},run:{output:passed?'observed':'missing',steps:[],toolCalls:[],totalTokens:1,totalCostUsd:0,durationMs:1}}};
   });
   const baseline=trials('baseline'), candidate=trials('candidate');
   return {usageComplete:true,batch:{baselineRevision:context.baselineRevision,candidateRevision:context.candidateRevision,baseline,candidate,attributions:[{taskId:context.stage+'-0',effect:'improvement',reason:'Independent trace comparison.',baselineTrajectories:baseline.slice(0,2).map(t=>t.trajectoryId),candidateTrajectories:candidate.slice(0,2).map(t=>t.trajectoryId)}]}};
  }
 };
}
`,
	)
	return path
}

async function resident() {
	const value = await lookupResident(cwd, 'default')
	if (!value) throw new Error('Missing fixture resident.')
	return value
}

it('does not create learning state or load a module during empty inspection', async () => {
	expect((await command(['learning'])).code).toBe(0)
	expect(existsSync(join(home, 'state'))).toBe(false)
	expect((await command(['add', '--trust', 'Inspect sources.'])).code).toBe(0)
	expect((await command(['learning'])).code).toBe(0)
	expect(existsSync(join(home, 'state', 'learning.sqlite'))).toBe(false)
	expect(existsSync(join(home, 'learning'))).toBe(false)
})

it('refuses untrusted host execution before importing the selected module', async () => {
	await command(['add', '--trust', 'Inspect sources.'])
	const path = moduleFile()
	expect((await command(['learn', path])).code).toBe(77)
	expect(existsSync(join(root, 'imported'))).toBe(false)
	expect(existsSync(join(home, 'state', 'learning.sqlite'))).toBe(false)
})

it('runs the host factory through the real SDK gate, persists both batches and inspects after reopening', async () => {
	await command(['add', '--trust', 'Inspect sources.'])
	const path = moduleFile()
	const response = await command(['learn', path, '--trust'])
	expect(response.errors).toEqual([])
	expect(response.code).toBe(0)
	const handle = await resident()
	const state = await handle.agenda.read()
	expect(state?.learning?.skills[0]?.name).toBe('source-check')
	const store = residentLearningStore(handle, true)
	if (!store) throw new Error('Expected recorded store.')
	const cycle = (await store.list())[0]
	if (!cycle) throw new Error('Expected recorded cycle.')
	expect(cycle).toMatchObject({
		status: 'activated',
		result: { consumption: { tokens: 45, unknownCosts: 3 } },
	})
	expect((await store.artifacts(cycle.cycleId)).map((a) => a.name)).toEqual([
		'confirmation',
		'verification',
	])
	expect(await store.readArtifact(cycle.cycleId, 'confirmation')).toHaveProperty(
		'candidateRevision',
		cycle.candidateRevision,
	)
	const before = readFileSync(join(home, 'state', 'learning.sqlite'))
	const inspection = await command(['learning', cycle.cycleId, '--events', '--limit', '2'])
	expect(inspection.code).toBe(0)
	expect(inspection.printed[0]?.events).toHaveLength(2)
	expect(readFileSync(join(home, 'state', 'learning.sqlite'))).toEqual(before)
})

it('retains evaluator failure and partial usage without activating a skill', async () => {
	await command(['add', '--trust', 'Inspect sources.'])
	const response = await command(['learn', moduleFile(true), '--trust'])
	expect(response.code).toBe(1)
	const handle = await resident()
	const store = residentLearningStore(handle, true)
	if (!store) throw new Error('Expected recorded store.')
	const cycle = (await store.list())[0]
	if (!cycle) throw new Error('Expected recorded cycle.')
	expect(cycle).toMatchObject({
		status: 'failed',
		result: { consumption: { tokens: 25, unfinishedStages: 1 } },
	})
	expect((await handle.agenda.read())?.learning).toBeUndefined()
})

it('preserves acknowledged activation in the output when the final journal write fails', async () => {
	await command(['add', '--trust', 'Inspect sources.'])
	const original = SqliteResidentLearningStore.prototype.append
	vi.spyOn(SqliteResidentLearningStore.prototype, 'append').mockImplementation(function (
		this: SqliteResidentLearningStore,
		event,
	) {
		if (event.kind === 'finished') return Promise.reject(new Error('Synthetic disk failure.'))
		return original.call(this, event)
	})
	const response = await command(['learn', moduleFile(), '--trust'])
	expect(response.code).toBe(1)
	expect(response.printed[0]?.result).toMatchObject({
		status: 'activated',
		auditComplete: false,
	})
	expect(response.printed[0]?.text).toContain('journal is incomplete')
	expect((await (await resident()).agenda.read())?.learning?.skills).toHaveLength(1)
})

it('rejects unsupported command flags and paused residents before importing code', async () => {
	await command(['add', '--trust', 'Inspect sources.'])
	expect((await command(['learning', '--provider', 'zen'])).code).toBe(64)
	await command(['pause'])
	expect((await command(['learn', moduleFile(), '--trust'])).code).toBe(1)
	expect(existsSync(join(root, 'imported'))).toBe(false)
})
