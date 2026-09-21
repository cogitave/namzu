import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each([false, true])(
	'reopens an unclosed snapshot across processes without repairing it (torn: %s)',
	async (torn) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-unclosed-snapshot-'))
		try {
			const scope = {
				tenantId: randomUUID(),
				projectId: randomUUID(),
				sessionId: randomUUID(),
				turnId: randomUUID(),
			}
			const sdkUrl = new URL('../../../../dist/index.js', import.meta.url).href
			const script = `import {RunDiskStore,createSessionTextEvidenceSource,createUserMessage} from ${JSON.stringify(sdkUrl)};
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
const [root,raw,mode,address]=process.argv.slice(1),scope=JSON.parse(raw),runDir=join(root,scope.runId);
if(mode==='seed') {
 const store=new RunDiskStore({baseDir:root});await store.initRun(scope.runId);
 await writeFile(join(runDir,'run.json'),JSON.stringify({id:scope.runId,status:'idle',metadata:{scope}}));
 await store.appendEvent({type:'turn_started',runId:scope.runId,seq:1});
 await store.appendEvent({type:'compaction_shed',runId:scope.runId,seq:2,iteration:1,reason:'threshold',messages:[createUserMessage('ORCHID exact original α🦉',[{data:'A'.repeat(5*1024*1024),mediaType:'image/png'}])]});
} else {
 const source=createSessionTextEvidenceSource({scope,runDir,indexDir:join(runDir,'index'),consistency:'snapshot'});
 console.log(JSON.stringify(mode==='search'?await source.search({query:'ORCHID'}):await source.read({address})));
}`
			const exec = promisify(execFile)
			const child = async (mode: string, address = '') => {
				const { stdout } = await exec(
					process.execPath,
					['--input-type=module', '-e', script, root, JSON.stringify(scope), mode, address],
					{ timeout: 20000, maxBuffer: 100000 },
				)
				return stdout ? JSON.parse(stdout) : undefined
			}
			await child('seed')
			const path = join(root, scope.runId, 'transcript.jsonl')
			if (torn) await writeFile(path, `${await readFile(path, 'utf8')}{"type":"unfinished`)
			const original = await readFile(path)
			const metadataPath = join(root, scope.runId, 'run.json')
			const metadata = await readFile(metadataPath)
			const search = await child('search')
			expect(search.incomplete).toBe(true)
			expect(search.unavailable).toEqual([])
			expect(search.matches).toHaveLength(1)
			const read = await child('read', search.matches[0].address)
			expect(read.text).toBe('ORCHID exact original α🦉')
			expect(read.retained).toBe('full')
			expect(read.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(await readFile(path)).toEqual(original)
			expect(await readFile(metadataPath)).toEqual(metadata)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

it('reads retained compaction text and restores whole attachments across processes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-compaction-restart-'))
	try {
		const scope = {
			tenantId: randomUUID(),
			projectId: randomUUID(),
			sessionId: randomUUID(),
			turnId: randomUUID(),
		}
		const sdkUrl = new URL('../../../../dist/index.js', import.meta.url).href
		const script = `import {RunDiskStore,createSessionTextEvidenceSource,createUserMessage} from ${JSON.stringify(sdkUrl)};
import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const [root,raw,mode,address]=process.argv.slice(1),scope=JSON.parse(raw),store=new RunDiskStore({baseDir:root});
const runDir=await store.initRun(scope.runId);
if(mode==='seed') {
await writeFile(join(runDir,'run.json'),JSON.stringify({id:scope.runId,status:'completed',metadata:{scope}}));
await store.appendEvent({type:'turn_started',runId:scope.runId,seq:1});
await store.appendEvent({type:'compaction_shed',runId:scope.runId,seq:2,iteration:1,reason:'threshold',generation:9,
messages:[createUserMessage('ORCHID exact original A17',[{data:'A'.repeat(5*1024*1024),mediaType:'image/png'}])]});
}
const source=createSessionTextEvidenceSource({scope,runDir,indexDir:join(runDir,'index')});
if(mode==='seed') console.log(JSON.stringify(await source.search({query:'ORCHID'})));
else { const read=await source.read({address}); const events=await store.readEvents();const shed=events.find(e=>e.type==='compaction_shed');
console.log(JSON.stringify({read,imageBytes:shed.messages[0].attachments[0].data.length,generation:shed.generation})); }`
		const exec = promisify(execFile)
		const child = async (mode: string, address = '') => {
			const { stdout } = await exec(
				process.execPath,
				['--input-type=module', '-e', script, root, JSON.stringify(scope), mode, address],
				{ timeout: 20000, maxBuffer: 100000 },
			)
			return JSON.parse(stdout)
		}
		const first = await child('seed')
		expect(first.matches).toHaveLength(1)
		const next = await child('read', first.matches[0].address)
		expect(next.read.text).toBe('ORCHID exact original A17')
		expect(next.read.scannedBytes).toBeLessThan(100000)
		expect(next.imageBytes).toBe(5 * 1024 * 1024)
		expect(next.generation).toBe(9)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it.each(['query', 'terms', 'tokens', 'refined'] as const)(
	'shares an atomically published index and reads a previous process address (%s)',
	async (mode) => {
		const search =
			mode === 'query'
				? { query: 'RECEIPT' }
				: {
						terms: ['absent', 'RECEIPT'],
						...(['tokens', 'refined'].includes(mode) ? { matchMode: 'token' } : {}),
					}
		const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-restart-'))
		try {
			const scope = {
				tenantId: randomUUID(),
				projectId: randomUUID(),
				sessionId: randomUUID(),
				turnId: randomUUID(),
			}
			const runDir = join(root, 'run')
			await mkdir(runDir)
			const options = { scope, runDir, indexDir: join(runDir, 'index') }
			await writeFile(
				join(runDir, 'run.json'),
				JSON.stringify({
					id: scope.runId,
					status: 'completed',
					metadata: { scope },
				}),
			)
			const lines = [
				{ type: 'turn_started', runId: scope.runId, seq: 1 },
				...Array.from({ length: 80 }, (_, i) => ({
					type: 'tool_completed',
					seq: i + 2,
					timestamp: 1_735_689_600_000 + i,
					turnId: scope.runId,
					toolUseId: `call-${i}`,
					toolName: 'observe',
					isError: false,
					result: i === 79 ? 'ORIGINAL RECEIPT 🦉' : 'earlier unrelated output',
				})),
			]
			await writeFile(
				join(runDir, 'transcript.jsonl'),
				`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
			)
			const original = await readFile(join(runDir, 'transcript.jsonl'), 'utf8')
			const moduleUrl = new URL('../../../../dist/store/evidence/disk.js', import.meta.url).href
			const exec = promisify(execFile)
			async function child(method: 'search' | 'read', input: unknown) {
				const script = `import {createSessionEvidenceSource} from ${JSON.stringify(moduleUrl)}; const source=createSessionEvidenceSource(JSON.parse(process.argv[1])); console.log(JSON.stringify(await source[process.argv[2]](JSON.parse(process.argv[3]))));`
				const { stdout } = await exec(
					process.execPath,
					[
						'--input-type=module',
						'-e',
						script,
						JSON.stringify(options),
						method,
						JSON.stringify(input),
					],
					{ timeout: 20_000, maxBuffer: 100_000 },
				)
				return JSON.parse(stdout)
			}
			const first = await Promise.all([child('search', search), child('search', search)])
			expect(first.every((page) => page.matches.length === 0 && page.nextCursor)).toBe(true)
			expect(first[0].nextCursor).toBe(first[1].nextCursor)
			const cached = await child('search', search)
			expect(cached.cacheHit).toBe(true)
			const found = await child('search', {
				...search,
				cursor: first[0].nextCursor,
				...(mode === 'refined' ? { refineTerms: ['RECEIPT'] } : {}),
			})
			if (mode === 'refined') {
				const broadAgain = await child('search', { ...search, cursor: first[0].nextCursor })
				expect(broadAgain.matches).toEqual(found.matches)
			}
			expect(found.matches).toHaveLength(1)
			expect(found.matches[0].recordedAt).toBe(1_735_689_600_079)
			const read = await child('read', { address: found.matches[0].address })
			expect(read.text).toBe('ORIGINAL RECEIPT 🦉')
			expect(read.recordedAt).toBe(1_735_689_600_079)
			expect(await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).toBe(original)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

it('reconstructs a live writer boundary in another process and retains durable event identities', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-live-evidence-restart-'))
	try {
		const scope = {
			tenantId: randomUUID(),
			projectId: randomUUID(),
			sessionId: randomUUID(),
			turnId: randomUUID(),
		}
		const storeUrl = new URL('../../../../dist/store/run/disk.js', import.meta.url).href
		const exec = promisify(execFile)
		const script = `import {RunDiskStore} from ${JSON.stringify(storeUrl)};
import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
const [root, encoded, previous] = process.argv.slice(1); const scope = JSON.parse(encoded);
const store = new RunDiskStore({baseDir:root});const dir = await store.initRun(scope.runId);
if(!previous) {
 await writeFile(join(dir,'run.json'),JSON.stringify({id:scope.runId,status:'running',metadata:{scope}}));
 await store.appendEvent({type:'turn_started',runId:scope.runId,seq:1});
 await store.appendEvent({type:'message_completed',runId:scope.runId,seq:2,content:'original receipt 🦉'});
} else await store.appendEvent({type:'message_completed',runId:scope.runId,seq:3,content:'new writer'});
const source=await store.captureTextEvidence(scope);const page=await source.search({query:'original receipt'});
const read=await source.read({address:page.matches[0].address});let oldRefused=false;
if(previous) { try {await source.read({address:previous});} catch {oldRefused=true;} }
console.log(JSON.stringify({page,read,oldRefused}));`
		const child = async (previous = '') => {
			const { stdout } = await exec(
				process.execPath,
				['--input-type=module', '-e', script, root, JSON.stringify(scope), previous],
				{ timeout: 20_000, maxBuffer: 100_000 },
			)
			return JSON.parse(stdout)
		}
		const first = await child()
		const next = await child(first.page.matches[0].address)
		expect(first.read.text).toBe('original receipt 🦉')
		expect(next.read.text).toBe(first.read.text)
		expect(next.page.matches[0].seq).toBe(2)
		expect(next.oldRefused).toBe(true)
		expect(next.page.incomplete).toBe(false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
