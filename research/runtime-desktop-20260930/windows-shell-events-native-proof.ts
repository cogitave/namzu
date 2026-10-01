import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runShellEscape } from '../../packages/cli/src/tui/shell-escape.ts'
import { formatResumeShellCommand } from '../../packages/cli/src/resume-shell.ts'
import { RuntimeClient } from '../../packages/desktop/src/main/rpc-client.ts'
import { lexShellCommandLine } from '../../packages/sdk/src/authorization/shell-lexer.ts'
import { evaluateRule } from '../../packages/sdk/src/authorization/rules.ts'
import { BashTool } from '../../packages/sdk/src/tools/builtins/bash.ts'
import { hostCommandShell } from '../../packages/sdk/src/tools/command-shell.ts'
import { unknownProgramInLine } from '../../packages/sdk/src/authorization/program.ts'
import { MockLLMProvider } from '../../packages/sdk/src/provider/mock.ts'
import { testToolset } from '../../packages/sdk/src/test-support/toolset.ts'
import { drainQuery } from '../../packages/sdk/src/runtime/query/index.ts'
import { createUserMessage } from '../../packages/sdk/src/types/message/index.ts'
assert.equal(process.platform,'win32')
const root=mkdtempSync(join(tmpdir(),'namzu-windows-shell-'))
const PROTOCOL_FIXTURE_SOURCE="// Isolated transport fixture: no credentials, model, network or shell execution.\nimport { createInterface } from 'node:readline'\nimport { randomUUID } from 'node:crypto'\nconst pending = new Map()\nconst send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\\n`)\nconst reply = (id, result) => send({ id, result })\nconst methods = ['namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/models', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop']\nconst lines = createInterface({ input: process.stdin })\nlines.on('close', () => process.exit(0))\nlines.on('line', (line) => {\n\tconst frame = JSON.parse(line)\n\tconst { id, method, params } = frame\n\tif (!method) {\n\t\tconst prompt = pending.get(id)\n\t\tif (!prompt) return\n\t\tpending.delete(id)\n\t\tsend({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'agent_message_chunk', text: frame.result.outcome === 'approve' ? 'Approved answer' : 'Declined answer' } } })\n\t\tsend({ method: 'session/update', params: { sessionId: prompt.sessionId, update: { kind: 'turn_ended', stopReason: 'end_turn' } } })\n\t\treply(prompt.id, { stopReason: 'end_turn' })\n\t} else if (method === 'initialize') reply(id, { agentInfo: { name: 'namzu' }, promptAttachments: process.env.FIXTURE_NO_ATTACHMENTS ? undefined : true, promptOptions: process.env.FIXTURE_NO_OPTIONS ? undefined : true, extensions: process.env.FIXTURE_INCOMPATIBLE ? [] : methods })\n\telse if (method === 'namzu/project/status') reply(id, { cwd: process.cwd(), trusted: true })\n\telse if (method === 'namzu/conversations/list') reply(id, [])\n\telse if (method === 'namzu/conversations/history') reply(id, { messages: [], partial: false })\n\telse if (method === 'namzu/providers/models') reply(id, { models: [{ id: `${params.provider}-${params.sessionId ?? 'project'}`, label: 'Configured fixture model' }], notice: null })\n\telse if (method === 'session/load') reply(id, { sessionId: params.sessionId })\n\telse if (method === 'session/new') reply(id, { sessionId: `session-${randomUUID()}` })\n\telse if (method === 'session/prompt') {\n\t\tif (params.prompt === 'Break connection') { process.exit(0); return }\n\t\tconst requestId = `review-${params.sessionId}-${id}`\n\t\tpending.set(requestId, { id, sessionId: params.sessionId })\n\t\tsend({ id: requestId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCalls: [{ id: requestId, name: 'fixture-tool', input: { prompt: params.prompt, ...(params.attachments?.length ? { attachments: params.attachments } : {}) }, isDestructive: false }] } })\n\t} else if (method === 'session/cancel') {\n\t\tfor (const [requestId, prompt] of pending) {\n\t\t\tif (prompt.sessionId !== params.sessionId) continue\n\t\t\tpending.delete(requestId)\n\t\t\treply(prompt.id, { stopReason: 'cancelled' })\n\t\t}\n\t\treply(id, {})\n\t} else if (method === 'test/echo') {\n\t\tconst bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: 'Türkçe 🧪' })}\\n`)\n\t\tconst split = bytes.indexOf(Buffer.from('ü')) + 1\n\t\tprocess.stdout.write(bytes.subarray(0, split), () => process.stdout.write(bytes.subarray(split)))\n\t} else if (method === 'test/malformed') process.stdout.write('invalid-json\\n')\n\telse if (method === 'test/exit') process.exit(0)\n\telse if (method === 'test/signal') process.kill(process.pid, 'SIGTERM')\n\telse if (method === 'test/wait') { /* pending until transport closes */ }\n\telse reply(id, {})\n})\n"
const checks:string[]=[]
try {
 const old=spawn('/bin/sh',['-c','echo old'],{cwd:root})
 const [oldError]=await once(old,'error')
 assert.equal(oldError.code,'ENOENT')
 checks.push('Prior bang /bin/sh launcher: ENOENT on native Windows')
 const cmdMismatch="echo 'safe & echo NAMZU_CMD_SECOND_COMMAND & echo '"
 const reading=lexShellCommandLine(cmdMismatch,{dialect:'sh'})
 assert.equal(reading.opaque,false);assert.equal(reading.commands.length,1)
 assert.equal(evaluateRule({type:'argument_pattern',toolNames:['bash'],argument:'command',pattern:'^echo',decision:'allow'},'bash',{command:cmdMismatch},BashTool,/^echo/,new Set(['bash']),{commandDialect:'sh'}),'allow')
 const cmdOutput=execFileSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c',cmdMismatch],{cwd:root,encoding:'utf8',windowsHide:true})
 assert.match(cmdOutput,/(?:^|\r?\n)NAMZU_CMD_SECOND_COMMAND[ \t]*(?:\r?\n|$)/)
 checks.push('Prior SDK metadata mismatch: sh lexer/rule grants one literal echo while native CMD executes a second echo between single quotes')
 assert.equal(hostCommandShell().dialect,'cmd')
 assert.equal(BashTool.commandDialect?.({sandboxed:false}),'cmd');assert.equal(BashTool.commandDialect?.({sandboxed:true}),'sh')
 assert.equal(evaluateRule({type:'argument_pattern',toolNames:['bash'],argument:'command',pattern:'^echo',decision:'allow'},'bash',{command:cmdMismatch},BashTool,/^echo/,new Set(['bash']),{commandDialect:'cmd'}),null)
 assert.match(unknownProgramInLine(cmdMismatch,'cmd')??'',/native CMD/)
 checks.push('Production native SDK CMD metadata: opaque parsing refuses command-specific allowance and preserves exact-call escalation; guest stays sh')
 const provider=new MockLLMProvider({responseText:'native shell metadata'})
 await drainQuery({provider,toolsets:[testToolset(BashTool)],messages:[createUserMessage('inspect the shell')],
  turnConfig:{model:'mock-model',timeoutMs:10000,tokenBudget:100000,maxIterations:2,maxResponseTokens:256},
  agentId:'agent_shell',agentName:'Shell',workingDirectory:root,sessionId:'052b7785-2bcc-458a-8184-76dfbdbfdf58' as never,topicId:'458174d9-b54f-43a9-9ccc-c3d87be14190' as never,projectId:'8e2b818f-eb63-4f6e-a416-18b311dcb61c' as never,tenantId:'36da1973-021d-40d5-9a72-7ba4084729de' as never})
 assert.match(JSON.stringify(provider.requests[0]?.messages),/Execution shell for bash: cmd \(host\)/)
 checks.push('Production native Windows SDK query: actual model request includes CMD execution syntax (mock provider, no model network)')
 const result=await runShellEscape('echo out & echo err 1>&2 & exit /b 3',{cwd:root})
 assert.equal(result.exitCode,3);assert.match(result.output,/out/);assert.match(result.output,/err/)
 checks.push('Production bang runner: native CMD, both output streams, nonzero status')
 const script=join(root,'utf8.cjs')
 writeFileSync(script,"const b=Buffer.from('Türkçe 🧪');process.stdout.write(b.subarray(0,2),()=>process.stdout.write(b.subarray(2)))")
 const utf8=await runShellEscape(`"${process.execPath}" "${script}"`,{cwd:root})
 assert.equal(utf8.exitCode,0);assert.equal(utf8.output,'Türkçe 🧪')
 checks.push('Production bang runner: spaced executable/script paths and split UTF-8 output')
 const controller=new AbortController();controller.abort()
 const aborted=await runShellEscape('echo should-not-run',{cwd:root,signal:controller.signal})
 assert.equal(aborted.output,'');assert.equal(aborted.exitCode,null)
 checks.push('Production bang runner: pre-aborted call refuses execution')
 const argvScript=join(root,'arguments.cjs')
 writeFileSync(argvScript,"process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}))")
 const ps=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 const quoted=formatResumeShellCommand([process.execPath,argvScript,'two words',"O'Brien",'& $ ;'],{platform:'win32',cwd:root})
 const quotedOut=execFileSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "+quoted],{encoding:'utf8',windowsHide:true})
 assert.deepEqual(JSON.parse(quotedOut),{argv:['two words',"O'Brien",'& $ ;'],cwd:root})
 checks.push('Production resume formatter: PS5.1 spaced paths, apostrophe and metacharacter arguments, guarded cwd')
 const comspec=process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe'
 const ownedScript=join(root,'owned.cjs')
 writeFileSync(ownedScript,"process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');process.stdin.resume();setInterval(()=>{},1000)")
 const wrapper=spawn(comspec,['/d','/s','/c',`""${process.execPath}" "${ownedScript}""`],{cwd:root,stdio:'pipe',windowsHide:true,windowsVerbatimArguments:true})
 const lines=createInterface({input:wrapper.stdout})
 const [line]=await once(lines,'line');const childPid=JSON.parse(line).pid
 const wrapperClose=once(wrapper,'close')
 const wrapperExit=once(wrapper,'exit');wrapper.kill();await wrapperExit
 assert.doesNotThrow(()=>process.kill(childPid,0))
 checks.push('Prior desktop forced shutdown: killing CMD wrapper leaves owned Node descendant alive')
 execFileSync('taskkill',['/pid',String(childPid),'/t','/f'],{windowsHide:true,stdio:'ignore'})
 await wrapperClose;lines.close()
 checks.push('Owned Windows tree cleanup: taskkill /pid /t /f removes controlled descendant')
 const rpcScript=join(root,'rpc.cjs')
 writeFileSync(rpcScript,`const r=require('node:readline').createInterface({input:process.stdin});setInterval(()=>{},1000);r.on('line',line=>{const f=JSON.parse(line);const result=f.method==='initialize'?{agentInfo:{name:'namzu'},extensions:['namzu/project/status','namzu/project/trust','namzu/conversations/list','namzu/conversations/history','namzu/providers/status','namzu/providers/select','namzu/jobs/list','namzu/jobs/read','namzu/jobs/stop']}:{pid:process.pid,args:process.argv.slice(2)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\\n')})`)
 writeFileSync(join(root,'fixture.cmd'),'@echo off\r\n"%NODE_EXEC%" "%RPC_FIXTURE%" %*\r\n')
 const runtime=new RuntimeClient(root,{program:comspec,args:['/d','/s','/c','fixture acp --desktop'],env:{...process.env,PATH:root+';'+process.env.PATH,NODE_EXEC:process.execPath,RPC_FIXTURE:rpcScript}})
 await runtime.start()
 const info=await runtime.request('test/pid') as {pid:number,args:string[]}
 assert.deepEqual(info.args,['acp','--desktop'])
 checks.push('Production desktop RuntimeClient: CMD/npm-style .cmd forwarding retains exact ACP arguments')
 await runtime.close();await runtime.close()
 assert.throws(()=>process.kill(info.pid,0))
 checks.push('Production desktop RuntimeClient: graceful EOF first, forced live owned tree shutdown, actual descendant gone')
 const protocolFixture=join(root,'protocol-fixture.mjs')
 writeFileSync(protocolFixture,PROTOCOL_FIXTURE_SOURCE)
 const protocol=new RuntimeClient(root,{program:process.execPath,args:[protocolFixture]})
 await protocol.start()
 const session=await protocol.request('session/new') as {sessionId:string}
 const frames:Record<string,any>[]=[]
 protocol.on('frame',(frame)=>frames.push(frame))
 const permission=once(protocol,'frame')
 const prompt=protocol.request('session/prompt',{sessionId:session.sessionId,prompt:'fixture approval'},0)
 const [request]=await permission
 assert.equal(request.method,'session/request_permission');assert.equal(request.params.sessionId,session.sessionId)
 protocol.answer(request.id,{outcome:'approve'})
 assert.deepEqual(await prompt,{stopReason:'end_turn'})
 assert.deepEqual(frames.filter(f=>f.method==='session/update').map(f=>f.params.update.kind),['agent_message_chunk','turn_ended'])
 assert.ok(frames.every(f=>f.params.sessionId===session.sessionId))
 checks.push('Production Windows RPC transport: correlated permission response, session targeting, ordered message/end frames (protocol fixture)')
 const pending=protocol.request('test/wait',{},0).then(()=>assert.fail('unexpected result'),error=>assert.match(error.message,/connection was closed/))
 await protocol.close();await pending
 checks.push('Production Windows RPC transport: graceful EOF and pending-request rejection (protocol fixture)')
 process.stdout.write(JSON.stringify({passed:true,platform:process.platform,node:process.version,checks,limitations:['No native TUI rendering, pwsh executable, credentialed model, or reconnect service tested.']},null,2)+'\n')
}finally{rmSync(root,{recursive:true,force:true})}
