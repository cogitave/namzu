// Controlled ACP transport for native transcript verification. No model,
// credentials, shell/tool execution or access to the user's Namzu home.
import { createInterface } from 'node:readline'
import { readFileSync, watch } from 'node:fs'
const send = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const reply = (id, result) => send({ id, result })
const methods = ['namzu/project/status', 'namzu/project/trust', 'namzu/conversations/list', 'namzu/conversations/history', 'namzu/providers/status', 'namzu/providers/models', 'namzu/providers/select', 'namzu/jobs/list', 'namzu/jobs/read', 'namzu/jobs/stop']
let prompt
let revision = 0
const update = value => send({ method: 'session/update', params: { sessionId: prompt.params.sessionId, update: value } })
const identity = () => ({ turnId: `turn-${prompt.id}`, messageId: `message-${prompt.id}` })
const lines = createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', line => {
 const frame = JSON.parse(line)
 if (!frame.method) {
  if (frame.id === 'transcript-review') {
   update({ kind:'tool_call',toolCallId:'read',title:'exec',status:'completed',durationMs:1200,view:{kind:'terminal',command:'Read fixture',output:'Fixture output'} })
   update({ kind:'tool_call',toolCallId:'check',title:'exec',status:'completed',durationMs:2300,view:{kind:'terminal',command:'Check fixture',output:'Checks passed'} })
  }
  return
 }
 const { id, method, params } = frame
 if (method === 'initialize') reply(id,{agentInfo:{name:'namzu'},promptOptions:true,extensions:methods})
 else if (method === 'namzu/project/status') reply(id,{cwd:process.cwd(),trusted:true})
 else if (method === 'namzu/conversations/list' || method === 'namzu/jobs/list') reply(id,[])
 else if (method === 'namzu/conversations/history') reply(id,{messages:[],partial:false})
 else if (method === 'namzu/providers/status') reply(id,{available:[{id:'fixture',label:'Controlled transport',defaultModel:'fixture'}],selected:{id:'fixture',model:'fixture'}})
 else if (method === 'namzu/providers/models') reply(id,{models:[{id:'fixture',label:'Controlled transport'}],notice:null})
 else if (method === 'session/new') reply(id,{sessionId:`transcript-${id}`})
 else if (method === 'session/load') reply(id,{sessionId:params.sessionId})
 else if (method === 'session/prompt') prompt=frame
 else if (method === 'session/cancel') {reply(prompt.id,{stopReason:'cancelled',reason:'cancelled'});reply(id,{})}
 else reply(id,{})
})
watch(process.env.NAMZU_TRANSCRIPT_CONTROL, () => {
 let command
 try {command=JSON.parse(readFileSync(process.env.NAMZU_TRANSCRIPT_CONTROL,'utf8'))} catch{return}
 if (command.revision <= revision || !prompt) return
 revision=command.revision
 const ident=identity()
 if(command.stage==='thinking') {
  update({kind:'agent_thought',status:'pending',...ident,blockId:`${ident.messageId}:0`})
  update({kind:'agent_thought_chunk',text:'Compare the reported events before changing the transcript.',...ident,blockId:`${ident.messageId}:0`})
 } else if(command.stage==='tools') {
  update({kind:'agent_thought',status:'completed',...ident,blockId:`${ident.messageId}:0`})
  update({kind:'agent_message_chunk',text:'I will inspect the local events.',...ident,phase:'commentary',textPart:{id:'comment',phase:'commentary'}})
  update({kind:'agent_message',status:'completed',...ident,content:'I will inspect the local events.',textParts:[{id:'comment',text:'I will inspect the local events.',phase:'commentary'}],stopReason:'tool_use'})
  update({kind:'tool_call',toolCallId:'read',title:'exec',status:'pending',view:{kind:'terminal',command:'Read fixture',output:''}})
 } else if(command.stage==='more-tools') {
  update({kind:'tool_call',toolCallId:'check',title:'exec',status:'pending',view:{kind:'terminal',command:'Check fixture',output:''}})
 } else if(command.stage==='permission') {
  send({id:'transcript-review',method:'session/request_permission',params:{sessionId:prompt.params.sessionId,toolCalls:[{id:'read',name:'fixture',input:{fixture:true},isDestructive:false}]}})
 } else if(command.stage==='answer') {
  update({kind:'agent_message_chunk',text:'Draft result before settlement.',turnId:ident.turnId,messageId:`final-${prompt.id}`,phase:'final_answer',textPart:{id:'final',phase:'final_answer'}})
 } else if(command.stage==='finish') {
  const messageId=`final-${prompt.id}`
  update({kind:'agent_message',status:'completed',turnId:ident.turnId,messageId,content:'Verified final result.',textParts:[{id:'final',text:'Verified final result.',phase:'final_answer'}],stopReason:'end_turn'})
  update({kind:'turn_ended',stopReason:'end_turn',reason:'end_turn',turnId:ident.turnId,messageId,result:'Verified final result.'})
  reply(prompt.id,{stopReason:'end_turn',reason:'end_turn'})
 } else if(command.stage==='blocked') {
  update({kind:'agent_message_chunk',text:'BLOCKED_TRANSCRIPT_FIXTURE',...ident,phase:'final_answer',textPart:{id:'blocked',phase:'final_answer'}})
  update({kind:'turn_ended',stopReason:'refused',reason:'output_guardrail',...ident,result:''})
  reply(prompt.id,{stopReason:'refused',reason:'output_guardrail'})
 }
})
