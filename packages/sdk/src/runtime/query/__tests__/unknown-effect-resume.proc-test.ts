import { execFile, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SessionPaths } from '../../../session/paths.js'
import { DiskSessionLog } from '../../../store/session-log/index.js'
import type { SessionId } from '../../../types/ids/index.js'

// A batch's results reach the history only when the whole batch settles, so
// a sibling that finished before the kill is known from its own record in the
// log, never from a history the checkpoint carries.
it.each(['single', 'batch'])(
	'does not repeat an effect after a hard kill before its result (%s checkpoint)',
	async (shape) => {
		const sibling = shape !== 'single'
		const root = await mkdtemp(join(tmpdir(), 'namzu-unknown-effect-'))
		await mkdir(join(root, 'home'))
		let child: ReturnType<typeof fork> | undefined
		try {
			const scope = Object.fromEntries(
				['tenantId', 'projectId', 'sessionId', 'topicId', 'turnId'].map((key) => [
					key,
					randomUUID(),
				]),
			)
			const moduleURL = new URL('../../../../dist/index.js', import.meta.url).href
			const script = join(root, 'probe.mjs')
			await writeFile(
				script,
				`import * as sdk from ${JSON.stringify(moduleURL)};
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
const [mode,root,raw,hasSibling]=process.argv.slice(2),scope=JSON.parse(raw),seed=mode==='seed';
const names=hasSibling!=='single'?['settled','uncertain','untouched']:['uncertain'];
const toolsets=[sdk.toolset('effects',names.map(name=>({name,description:'Synthetic local effect.',inputSchema:sdk.mcpJsonSchemaToZod({type:'object',properties:{}}),isDestructive:()=>true,execute:async()=>{
 let n=0;try{n=Number(await readFile(join(root,name),'utf8'))}catch{}
 await writeFile(join(root,name),String(n+1));
 if(seed&&name==='uncertain'){process.send({ready:true});setInterval(()=>{},1000);await new Promise(()=>{});}
 return{success:true,output:name+' receipt'};
}})))];
const paths=new sdk.SessionPaths({home:join(root,'home'),slug:'effects'});
const log=sdk.DiskSessionLog.at(paths,{sessionId:scope.sessionId});
// A short lease, so the resuming process can take the session the killed one left.
const lease=await log.claim({holder:mode+':'+process.pid,ttlMs:400});
const params={...scope,toolsets,paths,lease,workingDirectory:root,agentId:'effect-probe',agentName:'Effect probe',turnConfig:{model:'mock',maxIterations:3,tokenBudget:20000,timeoutMs:15000},resumeHandler:async req=>({action:req.type==='tool_review'?'approve_tools':'continue'})};
if(seed)await sdk.drainQuery({...params,provider:new sdk.MockLLMProvider({turns:[{toolCalls:names.map(name=>({id:name,name,args:{}}))}]}),messages:[sdk.createUserMessage('Do each effect once.')]});
else{const {turnId:_t,...session}=scope;
 // The checkpoints are found beside the log, under the same paths.
 const provider=new sdk.MockLLMProvider({turns:[{text:'Inspect the unknown effect before retrying.'}]});
 const outcome=await sdk.resumeSession({...params,...session,scope,sessionLog:log,provider});console.log(JSON.stringify({resumed:outcome.resumed,messages:provider.requests[0]?.messages}));}
`,
			)
			child = fork(script, ['seed', root, JSON.stringify(scope), shape], {
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			})
			let stderr = ''
			child.stderr!.on('data', (bytes) => {
				stderr = (stderr + bytes).slice(-10_000)
			})
			const exited = new Promise((resolve) =>
				child!.once('exit', (code, signal) => resolve({ code, signal })),
			)
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Seed timed out: ${stderr}`)), 15_000)
				child!.once('message', () => {
					clearTimeout(timer)
					resolve()
				})
				child!.once('error', (error) => {
					clearTimeout(timer)
					reject(error)
				})
				child!.once('exit', () => {
					clearTimeout(timer)
					reject(new Error(`Seed exited: ${stderr}`))
				})
			})
			child.kill('SIGKILL')
			expect(await exited).toMatchObject({ signal: 'SIGKILL' })
			expect(await readFile(join(root, 'uncertain'), 'utf8')).toBe('1')
			const log = DiskSessionLog.at(
				new SessionPaths({ home: join(root, 'home'), slug: 'effects' }),
				{
					sessionId: scope.sessionId as SessionId,
				},
			)
			const events = (await log.readAll()).entries.map(
				(entry) => entry.record as { type: string; toolUseId?: string },
			)
			expect(events.some((e) => e.type === 'tool_executing' && e.toolUseId === 'uncertain')).toBe(
				true,
			)
			expect(events.some((e) => e.type === 'tool_completed' && e.toolUseId === 'uncertain')).toBe(
				false,
			)
			// Past the killed process's lease.
			await new Promise((resolve) => setTimeout(resolve, 500))
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[script, 'resume', root, JSON.stringify(scope), shape],
				{ timeout: 20_000, maxBuffer: 200_000 },
			)
			const result = JSON.parse(stdout)
			expect(result.resumed).toBe(true)
			expect(await readFile(join(root, 'uncertain'), 'utf8')).toBe('1')
			expect(
				result.messages.find(
					(m: { role: string; toolCallId?: string }) =>
						m.role === 'tool' && m.toolCallId === 'uncertain',
				),
			).toMatchObject({ isError: true, content: expect.stringContaining('outcome is unknown') })
			if (sibling) {
				expect(await readFile(join(root, 'settled'), 'utf8')).toBe('1')
				expect(await readFile(join(root, 'untouched'), 'utf8')).toBe('1')
			}
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				const stopped = new Promise((resolve) => child!.once('exit', resolve))
				child.kill('SIGKILL')
				await stopped
			}
			await rm(root, { recursive: true, force: true })
		}
	},
	40_000,
)
