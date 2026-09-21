import { execFile, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.each(['single', 'batch', 'partial'])(
	'does not repeat an effect after a hard kill before its result (%s checkpoint)',
	async (shape) => {
		const sibling = shape !== 'single'
		const root = await mkdtemp(join(tmpdir(), 'namzu-unknown-effect-'))
		let child: ReturnType<typeof fork> | undefined
		try {
			const scope = Object.fromEntries(
				['tenantId', 'projectId', 'sessionId', 'topicId', 'runId'].map((key) => [
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
const tools=new sdk.ToolRegistry(),names=hasSibling!=='single'?['settled','uncertain','untouched']:['uncertain'];
for(const name of names)tools.register({name,description:'Synthetic local effect.',inputSchema:sdk.mcpJsonSchemaToZod({type:'object',properties:{}}),isDestructive:()=>true,execute:async()=>{
 let n=0;try{n=Number(await readFile(join(root,name),'utf8'))}catch{}
 await writeFile(join(root,name),String(n+1));
 if(seed&&name==='uncertain'){process.send({ready:true});setInterval(()=>{},1000);await new Promise(()=>{});}
 return{success:true,output:name+' receipt'};
}});
const store=new sdk.DiskCheckpointStore({baseDir:join(root,'runs')});
const params={...scope,tools,checkpointStore:store,runStore:new sdk.RunDiskStore({baseDir:join(root,'runs')}),workingDirectory:root,agentId:'effect-probe',agentName:'Effect probe',turnConfig:{model:'mock',maxIterations:3,tokenBudget:20000,timeoutMs:15000},resumeHandler:async req=>({action:req.type==='tool_review'?'approve_tools':'continue'})};
if(seed)await sdk.drainQuery({...params,provider:new sdk.MockLLMProvider({turns:[{toolCalls:names.map(name=>({id:name,name,args:{}}))}]}),messages:[sdk.createUserMessage('Do each effect once.')]});
else{if(hasSibling==='partial'){const latest=(await store.listCheckpoints(scope)).at(-1);
 if(!latest)throw new Error('Missing checkpoint');
 await store.writeCheckpoint(scope,{...latest,messages:[...latest.messages,sdk.createToolMessage('settled receipt','settled')]});}
 const provider=new sdk.MockLLMProvider({turns:[{text:'Inspect the unknown effect before retrying.'}]});
 const outcome=await sdk.resumeSession({...params,scope,provider});console.log(JSON.stringify({resumed:outcome.resumed,messages:provider.requests[0]?.messages}));}
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
			const events = (await readFile(join(root, 'runs', scope.runId!, 'transcript.jsonl'), 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
			expect(events.some((e) => e.type === 'tool_executing' && e.toolUseId === 'uncertain')).toBe(
				true,
			)
			expect(events.some((e) => e.type === 'tool_completed' && e.toolUseId === 'uncertain')).toBe(
				false,
			)
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
