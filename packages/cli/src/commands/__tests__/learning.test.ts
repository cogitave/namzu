import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteLearningStore, slugForCwd } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { lookupNamedTarget } from '../../integrations/learning/target.js'
import { cliProjectRoot } from '../../integrations/state/project.js'
import { learnCommand, learningCommand } from '../learn.js'
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

/** Run `namzu learn …` or `namzu learning …` the way the CLI would. */
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
	const [name, ...rest] = args
	const code = await (name === 'learn' ? learnCommand : learningCommand).handler({
		ctx,
		rawArgs: [...rest, '--cwd', cwd],
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
  protection:{verification:['verification-1'],confirmation:['confirmation-1']},
  generate:async context=>{await context.recordUsage({sessionId:randomUUID(),turnId:randomUUID(),tokens:5,costUsd:null});return {candidate,usageComplete:true}},
  evaluate:async context=>{
   await context.recordUsage({sessionId:randomUUID(),turnId:randomUUID(),tokens:20,costUsd:null});
   ${fail ? "throw new Error('Independent evaluation was interrupted.');" : ''}
   const trials=side=>Array.from({length:10},(_,i)=>{
    const passed=side==='candidate'||i>1, taskId=context.stage+'-'+Math.floor(i/2);
    return {taskId,trial:i%2,conditions:context.stage+'-'+i,trajectoryId:side+'-'+context.stage+'-'+i,result:{case:taskId,passed,status:passed?'passed':'failed',mean:Number(passed),scores:{exact:{score:Number(passed),reason:'Independent fixture check.'}},turn:{output:passed?'observed':'missing',steps:[],toolCalls:[],totalTokens:1,totalCostUsd:0,durationMs:1}}};
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

async function target() {
	const value = await lookupNamedTarget(cwd, 'default')
	if (!value) throw new Error('Missing fixture target.')
	return value
}

/** The target's own journal. */
async function learningDatabase(): Promise<string> {
	return join((await target()).storeDirectory, 'learning.sqlite')
}

it('does not create learning state or load a module during empty inspection', async () => {
	const empty = await command(['learning'])
	expect(empty.code).toBe(0)
	expect(empty.printed[0]?.text).toBe('No learning experiments recorded.')
	expect(existsSync(join(home, 'state'))).toBe(false)
	expect(existsSync(join(home, 'projects'))).toBe(false)
	expect((await command(['learning', '--observations'])).code).toBe(0)
	expect(existsSync(join(home, 'projects'))).toBe(false)
})

it('refuses untrusted host execution before importing the selected module', async () => {
	const path = moduleFile()
	expect((await command(['learn', path])).code).toBe(77)
	expect(existsSync(join(root, 'imported'))).toBe(false)
	// Nothing was created for a module that was refused.
	expect(existsSync(join(home, 'projects'))).toBe(false)
})

it('refuses a legacy host without protection before executing generation', async () => {
	const path = moduleFile()
	writeFileSync(
		path,
		readFileSync(path, 'utf8')
			.replace("protection:{verification:['verification-1'],confirmation:['confirmation-1']},", '')
			.replace(
				'generate:async context=>{',
				`generate:async context=>{throw new Error('generation must not run');`,
			),
	)
	const response = await command(['learn', path, '--trust'])
	expect(response.code).not.toBe(0)
	expect(response.errors.join('\n')).toContain('Declare protection.verification')
	expect(response.errors.join('\n')).not.toContain('generation must not run')
	expect((await (await target()).guidance.read())?.learning).toBeUndefined()
})

it('runs the host factory through the real SDK gate, persists both batches and inspects after reopening', async () => {
	const path = moduleFile()
	const response = await command(['learn', path, '--trust'])
	expect(response.errors).toEqual([])
	expect(response.code).toBe(0)
	const handle = await target()
	const state = await handle.guidance.read()
	expect(state?.learning?.skills[0]?.name).toBe('source-check')
	const store = handle.openStore(true)
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
	const before = readFileSync(await learningDatabase())
	const inspection = await command(['learning', cycle.cycleId, '--events', '--limit', '2'])
	expect(inspection.code).toBe(0)
	expect(inspection.printed[0]?.events).toHaveLength(2)
	expect(readFileSync(await learningDatabase())).toEqual(before)
	// The installation-wide location of the old layout is never created.
	expect(existsSync(join(home, 'state'))).toBe(false)
})

it('forwards optional environment exploration and retains its evidence before synthesis', async () => {
	const path = moduleFile()
	writeFileSync(
		path,
		readFileSync(path, 'utf8').replace(
			'generate:async context=>{',
			`explore:async context=>{
   await context.recordUsage({sessionId:randomUUID(),turnId:randomUUID(),tokens:7,costUsd:null});
   return {observations:{evidence:{key:'probe',source:'service-output',reason:'Observed.'},trace:'preview returned a destination'},usageComplete:true};
  },
  generate:async context=>{if(context.exploration?.trace!=='preview returned a destination')throw new Error('exploration missing');`,
		),
	)
	const response = await command(['learn', path, '--trust'])
	expect(response.errors).toEqual([])
	expect(response.code).toBe(0)
	const store = (await target()).openStore(true)
	if (!store) throw new Error('Expected learning store.')
	const cycle = (await store.list())[0]
	if (!cycle) throw new Error('Expected cycle.')
	expect(cycle.result?.consumption.tokens).toBe(52)
	expect(
		(await store.events(cycle.cycleId)).some(
			(event) => event.kind === 'exploration' && event.stage === 'explore',
		),
	).toBe(true)
})

it('retains evaluator failure and partial usage without activating a skill', async () => {
	const response = await command(['learn', moduleFile(true), '--trust'])
	expect(response.code).toBe(1)
	const handle = await target()
	const store = handle.openStore(true)
	if (!store) throw new Error('Expected recorded store.')
	const cycle = (await store.list())[0]
	if (!cycle) throw new Error('Expected recorded cycle.')
	expect(cycle).toMatchObject({
		status: 'failed',
		result: { consumption: { tokens: 25, unfinishedStages: 1 } },
	})
	expect((await handle.guidance.read())?.learning).toBeUndefined()
})

it('preserves acknowledged activation in the output when the final journal write fails', async () => {
	const original = SqliteLearningStore.prototype.append
	vi.spyOn(SqliteLearningStore.prototype, 'append').mockImplementation(function (
		this: SqliteLearningStore,
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
	expect((await (await target()).guidance.read())?.learning?.skills).toHaveLength(1)
})

it('rejects unsupported command flags before importing code', async () => {
	expect((await command(['learning', '--provider', 'zen'])).code).toBe(64)
	expect((await command(['learn', '--provider', 'zen', moduleFile()])).code).toBe(64)
	expect(existsSync(join(root, 'imported'))).toBe(false)
})

it('refuses a module name that is not a learning module before importing anything', async () => {
	const path = join(root, 'host.mjs')
	writeFileSync(path, 'throw new Error("must not load")')
	const response = await command(['learn', path, '--trust'])
	expect(response.code).toBe(1)
	expect(response.errors.join('\n')).toContain('.learning.js')
})

it('inspects observations without leaking full traces or implying an executor is alive', async () => {
	// A module run creates the target; here it only has to exist.
	expect((await command(['learn', moduleFile(), '--trust'])).code).toBe(0)
	const store = (await target()).openStore()
	if (!store) throw new Error('Missing store.')
	await store.observe({
		sessionId: '0199a8d2-37dd-7f8e-9e13-4e57937fd049',
		turnId: 'c7b3b083-1934-4cae-a445-2a8dd580d4a1',
		skillName: 'source-check',
		evaluatorRevision: 'muse-low-v1',
		baselineRevision: 'none',
		taskKey: 'source-a',
		outcome: 'execution-error',
		usageComplete: false,
		evidence: { key: 'receipt', source: 'host-check', reason: 'Provider did not complete.' },
		trace: 'Full trace only for structured inspection.',
	})
	const inspected = await command(['learning', '--observations', '--limit', '1'])
	expect(inspected.code, JSON.stringify(inspected.errors)).toBe(0)
	expect(inspected.printed[0]?.text).toContain('execution-error · usage unresolved')
	expect(inspected.printed[0]?.text).toContain('Provider did not complete.')
	expect(inspected.printed[0]?.text).not.toContain('Full trace')
	expect(inspected.printed[0]?.nextAfter).toBe(1)
	expect((await command(['learning', '--observations', '--after', '1'])).printed[0]?.text).toBe(
		'No learning observations recorded.',
	)
	expect((await command(['learning', '--observations', '--events'])).code).not.toBe(0)
})

it('selects a stored failure through the host module and does not replay it on a second CLI invocation', async () => {
	const path = moduleFile()
	let body = readFileSync(path, 'utf8')
	body = body.replace('export default function(host)', 'export default async function(host)')
	body = body.replace(
		' return {\n  skillName:',
		`
 await host.store.observe({sessionId:'0199a8d2-37dd-7f8e-9e13-4e57937fd04a',turnId:'a33cc456-e5d6-46c6-9347-db1c4300ab08',skillName:candidate.name,evaluatorRevision:'fixture-v1',baselineRevision:'none',taskKey:'source-fixture',outcome:'failed',usageComplete:true,evidence:{key:'source',source:'host-fixture',reason:'No source read.'},trace:'Source was not read.'});
 return {evaluators:[{skillName:candidate.name,evaluatorRevision:'fixture-v1'}],\n  skillName:`,
	)
	writeFileSync(path, body)
	const first = await command(['learn', path, '--trust'])
	expect(first.code, JSON.stringify(first.errors)).toBe(0)
	expect(first.printed[0]?.result).toMatchObject({ status: 'activated' })
	expect(first.printed[0]?.text).toContain('Verification: baseline 8/10 → candidate 10/10')
	expect(first.printed[0]?.text).toContain('Confirmation: baseline 8/10 → candidate 10/10')
	expect(first.printed[0]?.text).toContain('Protected tasks: passed')
	const second = await command(['learn', path, '--trust'])
	expect(second.code, JSON.stringify(second.errors)).toBe(0)
	expect(second.printed[0]?.result).toBeNull()
	expect(second.printed[0]?.text).toContain('No eligible unattempted')
	const observations = await command(['learning', '--observations'])
	expect(observations.printed[0]?.observations).toEqual([
		expect.objectContaining({ attemptedCycleId: expect.any(String) }),
	])
})

it('`namzu learn` runs a module into a named target and `namzu learning` lists what it recorded', async () => {
	const path = moduleFile()
	const untrusted = await command(['learn', path])
	expect(untrusted.code).toBe(77)
	expect(existsSync(join(root, 'imported'))).toBe(false)
	const ran = await command(['learn', path, '--trust'])
	expect(ran.errors).toEqual([])
	expect(ran.code).toBe(0)
	expect((await (await target()).guidance.read())?.learning?.skills[0]?.name).toBe('source-check')
	const listed = await command(['learning'])
	expect(listed.code).toBe(0)
	expect((listed.printed[0]?.cycles as unknown[]).length).toBe(1)
	// Another name is another target: nothing recorded there.
	const other = await command(['learning', '--agent', 'other'])
	expect(other.printed[0]?.text).toBe('No learning experiments recorded.')
	expect((await command(['learn', path, '--trust', '--agent', 'Not A Name'])).code).toBe(1)
})

/**
 * A target laid out the way an earlier version kept it: its journal, artifacts
 * and guidance under `residents/`, copied here from disk (see
 * __fixtures__/earlier-resident-target). The guidance revisions are in the
 * earlier shape; the journal row already uses the current `guidanceRevision`
 * field name, so the older `agendaRevision` name is covered separately, in
 * guidance-history.test.ts.
 */
const EARLIER_TARGET = join(
	import.meta.dirname,
	'..',
	'..',
	'__fixtures__',
	'earlier-resident-target',
)

function digests(directory: string): Record<string, string> {
	const out: Record<string, string> = {}
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) walk(path)
			else
				out[path.slice(directory.length)] = createHash('sha256')
					.update(readFileSync(path))
					.digest('hex')
		}
	}
	walk(directory)
	return out
}

function installEarlierTarget(): { projectDirectory: string; residents: string; cycleId: string } {
	const meta = JSON.parse(readFileSync(join(EARLIER_TARGET, 'meta.json'), 'utf8'))
	writeFileSync(
		join(home, 'identity.json'),
		JSON.stringify({ tenantId: meta.tenantId, createdAt: new Date(0).toISOString() }),
	)
	const projectRoot = cliProjectRoot(realpathSync(cwd))
	const slug = slugForCwd(projectRoot)
	const projectDirectory = join(home, 'projects', slug)
	mkdirSync(projectDirectory, { recursive: true })
	writeFileSync(
		join(projectDirectory, 'project.json'),
		JSON.stringify({
			v: 1,
			kind: 'project',
			projectId: meta.projectId,
			cwd: projectRoot,
			slug,
			createdAt: new Date(0).toISOString(),
		}),
	)
	const residents = join(projectDirectory, 'residents')
	cpSync(join(EARLIER_TARGET, 'residents'), residents, { recursive: true })
	return { projectDirectory, residents, cycleId: meta.cycleId }
}

it('carries a target an earlier version learned into over on first use and leaves the old files as they were', async () => {
	const earlier = installEarlierTarget()
	const before = digests(earlier.residents)

	// Inspecting finds the journal the earlier version recorded, observation and cycle.
	const listed = await command(['learning'])
	expect(listed.code).toBe(0)
	expect(listed.printed[0]?.cycles).toEqual([
		expect.objectContaining({ cycleId: earlier.cycleId, status: 'activated' }),
	])
	const observed = await command(['learning', '--observations'])
	expect(String(observed.printed[0]?.text)).toContain('execution-error · usage unresolved')
	const detail = await command(['learning', earlier.cycleId])
	expect(detail.code).toBe(0)
	expect(detail.printed[0]?.artifacts).toHaveLength(2)

	// The guidance activated back then is still there, with its history.
	const handle = await target()
	const state = await handle.guidance.read()
	expect(state?.revision).toBe(2)
	expect(state?.learning?.skills.map((s) => s.name)).toEqual(['source-check'])
	expect((await handle.guidance.readRevision(1))?.learning).toBeUndefined()
	expect(existsSync(join(handle.storeDirectory, 'adopted.json'))).toBe(true)

	// Working on top of it adds to the carried-over state, never to the old files.
	const ran = await command(['learn', moduleFile(), '--trust'])
	expect(ran.code).toBe(2) // the same guidance again: identical to the active baseline
	expect(ran.errors).toEqual([])
	const after = await command(['learning'])
	expect(after.printed[0]?.cycles).toHaveLength(2)
	expect(digests(earlier.residents)).toEqual(before)
})

it('lists what conversations kept', async () => {
	const { openSessions } = await import('../../integrations/sessions/store.js')
	const { createSessionLearningFeed } = await import('../../integrations/learning/session-feed.js')
	const { loadIdentity } = await import('../../integrations/state/identity.js')
	const { SessionPaths } = await import('@namzu/sdk')
	const sessions = await openSessions(cwd)
	const paths = new SessionPaths({ home: sessions.root, slug: sessions.slug })
	const stamp = Date.now().toString(16).padStart(12, '0')
	const id = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7def-8123-456789abcdef`
	const feed = createSessionLearningFeed({
		paths,
		tenantId: loadIdentity(sessions.root).tenantId,
		projectId: sessions.projectId,
		sessionId: id,
	})
	feed.observe({ kind: 'done', turnId: id, stopReason: 'timeout' })
	await feed.flush()
	const printed: Record<string, unknown>[] = []
	const run = (args: string[]) =>
		learningCommand.handler({
			ctx: {
				config: {},
				formatter: {
					name: 'json',
					print: (value) => printed.push(value as Record<string, unknown>),
					info: () => {},
					error: () => {},
				},
			} as CommandContext,
			rawArgs: [...args, '--cwd', cwd],
		})
	expect(await run(['--sessions'])).toBe(0)
	expect((printed[0]?.observations as unknown[]).length).toBe(1)
	expect(String(printed[0]?.text)).toContain('stop:timeout')
	expect(await run(['--sessions', '--after', '1'])).toBe(0)
	expect(printed[1]?.text).toBe('No conversation observations recorded.')
})
