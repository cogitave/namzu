import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,posix} from 'node:path'
import {randomUUID} from 'node:crypto'
import {MockLLMProvider} from '../../packages/sdk/src/provider/mock.ts'
import {drainQuery} from '../../packages/sdk/src/runtime/query/index.ts'
import {createUserMessage} from '../../packages/sdk/src/types/message/index.ts'
import {toolset} from '../../packages/sdk/src/toolsets/toolset.ts'
import {ReadFileTool} from '../../packages/sdk/src/tools/builtins/read-file.ts'
import {WriteFileTool} from '../../packages/sdk/src/tools/builtins/write-file.ts'
import {GlobTool} from '../../packages/sdk/src/tools/builtins/glob.ts'
import {GrepTool} from '../../packages/sdk/src/tools/builtins/grep.ts'
import {BashTool} from '../../packages/sdk/src/tools/builtins/bash.ts'
assert.equal(process.platform,'win32')
const root=mkdtempSync(join(tmpdir(),'namzu-guest-query-win-'))
const guestRoot='/home/namzu/workspace'
const files=new Map([['notes.txt','hello Türkçe 🧪\n']])
const calls=[]
const key=(path)=>posix.relative(guestRoot,posix.resolve(guestRoot,path))
const sandbox={id:randomUUID(),status:'ready',rootDir:guestRoot,environment:'linux-namespace',
 async readFile(path){calls.push({kind:'read',path});if(!files.has(key(path)))throw Object.assign(new Error('Absent'),{code:'ENOENT'});return Buffer.from(files.get(key(path)))},
 async writeFile(path,content){calls.push({kind:'write',path});files.set(key(path),typeof content==='string'?content:content.toString())},
 async listFiles(){return []},
 async *walkFiles(path,options){calls.push({kind:'walk',path});for(const [file,contents]of files){if(options.pattern==='**/*.md'&&!file.endsWith('.md'))continue;yield {path:posix.join(guestRoot,file),size:Buffer.byteLength(contents)}}},
 async exec(command,args,options){calls.push({kind:'exec',command,args,cwd:options.cwd});return {exitCode:0,stdout:'guest shell result',stderr:'',timedOut:false,durationMs:0}},
 async destroy(){calls.push({kind:'destroy'})}}
const provider=new MockLLMProvider({turns:[
 {toolCalls:[{name:'read',args:{path:'notes.txt'}}]},
 {toolCalls:[{name:'write',args:{path:'outputs/report.md',content:'hello report\n'}}]},
 {toolCalls:[{name:'glob',args:{pattern:'**/*.md'}}]},
 {toolCalls:[{name:'grep',args:{pattern:'hello',path:'.'}}]},
 {toolCalls:[{name:'bash',args:{command:'printf native'}}]},
 {text:'Done'}]})
const events=[]
try {
 await drainQuery({provider,toolsets:[toolset('fixture',[ReadFileTool,WriteFileTool,GlobTool,GrepTool,BashTool])],
 turnConfig:{model:'fixture',timeoutMs:10000,tokenBudget:0,maxIterations:8,maxResponseTokens:256},
 agentId:'agent_win_guest',agentName:'Windows guest query proof',messages:[createUserMessage('Run guest tools')],
 workingDirectory:root,sessionId:randomUUID(),topicId:randomUUID(),projectId:randomUUID(),tenantId:randomUUID(),
 sandboxProvider:{id:'fixture',name:'Fixture guest',environment:'linux-namespace',create:async()=>sandbox}},event=>{events.push(event)})
 assert.equal(files.get('outputs/report.md'),'hello report\n')
 assert.ok(calls.some(c=>c.kind==='walk'&&c.path===guestRoot))
 assert.ok(calls.filter(c=>c.kind==='walk').every(c=>!c.path.includes('\\')))
 const shell=calls.find(c=>c.kind==='exec')
 assert.equal(shell.command,'/bin/sh');assert.equal(shell.args[0],'-c');assert.ok(shell.args[1].includes('exec bash -c'));assert.equal(shell.args.at(-1),'printf native');assert.equal(shell.cwd,undefined)
 assert.ok(JSON.stringify(provider.requests).includes('./outputs/report.md'))
 assert.ok(JSON.stringify(provider.requests).includes('guest shell result'))
 assert.ok(JSON.stringify(provider.requests).includes('hello Türkçe 🧪'))
 process.stdout.write(JSON.stringify({passed:true,platform:process.platform,node:process.version,calls,providerRequests:provider.requests.length,checks:['actual SDK query read/write/glob/grep/bash on Windows host','guest POSIX paths survive host Windows path rules','shell routes to Sandbox.exec /bin/sh, never Windows host','guest UTF-8 observations reach model'],limitations:['Sandbox and model provider are fixtures; no guest engine/browser/actual model exercised.']},null,2)+'\n')
}finally{rmSync(root,{recursive:true,force:true})}
